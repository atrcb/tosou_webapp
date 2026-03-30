import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import crypto from 'crypto';
import * as notion from './src/server/notion.js';
import * as workflow from './src/server/workflow.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number.parseInt(process.env.PORT || '3001', 10);
app.set('trust proxy', true);

type EmbedAudience = 'notion_embed_link' | 'notion_embed_session';
type EmbedClaims = {
  aud: EmbedAudience;
  exp?: number;
  iat: number;
  jti: string;
  scope: string[];
  sub: string;
};

const EMBED_LINK_SECRET = process.env.EMBED_LINK_SECRET || '';
const EMBED_SESSION_SECRET = process.env.EMBED_SESSION_SECRET || EMBED_LINK_SECRET;
const EMBED_BASE_URL = process.env.EMBED_BASE_URL || '';
const EMBED_ADMIN_TOKEN = process.env.EMBED_ADMIN_TOKEN || '';
const EMBED_LINK_TTL_SEC = Number.parseInt(process.env.EMBED_LINK_TTL_SEC || '600', 10);
const EMBED_SESSION_TTL_SEC = Number.parseInt(process.env.EMBED_SESSION_TTL_SEC || '900', 10);
const EMBED_SESSION_RATE_LIMIT_MAX = Number.parseInt(process.env.EMBED_SESSION_RATE_LIMIT_MAX || '20', 10);
const EMBED_SESSION_RATE_LIMIT_WINDOW_SEC = Number.parseInt(
  process.env.EMBED_SESSION_RATE_LIMIT_WINDOW_SEC || '60',
  10
);
const EMBED_API_RATE_LIMIT_MAX = Number.parseInt(process.env.EMBED_API_RATE_LIMIT_MAX || '120', 10);
const EMBED_API_RATE_LIMIT_WINDOW_SEC = Number.parseInt(process.env.EMBED_API_RATE_LIMIT_WINDOW_SEC || '60', 10);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join('/tmp', 'notion-backend-uploads');

const nowSeconds = () => Math.floor(Date.now() / 1000);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized);
};

const resolveEmbedBaseUrl = (req: express.Request): string => {
  if (EMBED_BASE_URL) {
    return EMBED_BASE_URL;
  }

  const host = req.get('host') || '';
  const inferredBaseUrl = `${req.protocol}://${host}`;
  const parsed = new URL(inferredBaseUrl);

  if (isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      'Refusing to generate an embed link for localhost. Set EMBED_BASE_URL to a public HTTPS URL, then regenerate the Notion embed link.'
    );
  }

  return parsed.toString();
};

const base64UrlEncode = (input: string | Buffer): string =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const base64UrlDecode = (input: string): string => {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
};

const signEmbedToken = (claims: EmbedClaims, secret: string): string => {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
};

const verifyEmbedToken = (token: string, secret: string): EmbedClaims => {
  const [encodedHeader, encodedPayload, providedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !providedSignature) {
    throw new Error('Invalid token format');
  }

  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  if (
    expectedSignature.length !== providedSignature.length ||
    !crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(providedSignature))
  ) {
    throw new Error('Invalid token signature');
  }

  const claims = JSON.parse(base64UrlDecode(encodedPayload)) as EmbedClaims;
  if (!claims.sub || !Array.isArray(claims.scope) || !claims.aud || !claims.iat || !claims.jti) {
    throw new Error('Invalid token claims');
  }
  if (typeof claims.exp === 'number' && claims.exp > 0 && claims.exp <= nowSeconds()) {
    throw new Error('Token expired');
  }
  return claims;
};

const createEmbedSessionAccessToken = (linkToken: string): string => {
  if (!EMBED_LINK_SECRET || !EMBED_SESSION_SECRET) {
    throw new Error('Embed secrets are not configured');
  }

  const linkClaims = verifyEmbedToken(linkToken, EMBED_LINK_SECRET);
  if (linkClaims.aud !== 'notion_embed_link') {
    throw new Error('Invalid audience');
  }

  const sessionTtl = clamp(EMBED_SESSION_TTL_SEC, 60, 7200);
  const iat = nowSeconds();
  const exp = iat + sessionTtl;

  return signEmbedToken(
    {
      aud: 'notion_embed_session',
      exp,
      iat,
      jti: crypto.randomUUID(),
      scope: linkClaims.scope,
      sub: linkClaims.sub
    },
    EMBED_SESSION_SECRET
  );
};

type EmbedBootstrapState = {
  accessToken?: string;
  error?: string;
};

const buildEmbedBootstrapState = (req: express.Request): EmbedBootstrapState => {
  const linkToken = String(req.query?.token || '').trim();
  if (!linkToken) {
    return { error: 'Missing token query parameter.' };
  }

  try {
    return { accessToken: createEmbedSessionAccessToken(linkToken) };
  } catch (error: any) {
    return { error: error?.message || 'Failed to create embed session.' };
  }
};

const requireEmbedScope =
  (requiredScope: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      if (!EMBED_SESSION_SECRET) {
        return res.status(500).json({ error: 'Embed session secret is not configured' });
      }
      const authHeader = req.get('authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!token) {
        return res.status(401).json({ error: 'Missing bearer token' });
      }

      const claims = verifyEmbedToken(token, EMBED_SESSION_SECRET);
      if (claims.aud !== 'notion_embed_session') {
        return res.status(401).json({ error: 'Invalid audience' });
      }
      if (!claims.scope.includes(requiredScope)) {
        return res.status(403).json({ error: 'Insufficient scope' });
      }

      res.locals.embedClaims = claims;
      next();
    } catch (error: any) {
      return res.status(401).json({ error: error.message || 'Invalid token' });
    }
  };

const requireEmbedAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!EMBED_ADMIN_TOKEN) {
    return res.status(500).json({ error: 'EMBED_ADMIN_TOKEN is not configured' });
  }

  const provided = req.get('x-embed-admin-token') || '';
  if (!provided) {
    return res.status(401).json({ error: 'Missing admin token' });
  }

  if (
    provided.length !== EMBED_ADMIN_TOKEN.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(EMBED_ADMIN_TOKEN))
  ) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }
  return next();
};

type RateBucket = { count: number; windowStart: number };
const rateBuckets = new Map<string, RateBucket>();

const applyRateLimit =
  (name: string, max: number, windowSeconds: number) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${name}:${req.ip || 'unknown'}`;
    const now = nowSeconds();
    const clampedMax = clamp(Number.isFinite(max) ? max : 60, 1, 10000);
    const clampedWindow = clamp(Number.isFinite(windowSeconds) ? windowSeconds : 60, 1, 3600);

    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.windowStart >= clampedWindow) {
      rateBuckets.set(key, { count: 1, windowStart: now });
      return next();
    }

    if (bucket.count >= clampedMax) {
      const retryAfter = Math.max(1, clampedWindow - (now - bucket.windowStart));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }

    bucket.count += 1;
    return next();
  };

// Configure multer for file uploads
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, path.basename(file.originalname));
  }
});
const upload = multer({ storage });
const distIndexPath = path.join(__dirname, 'dist', 'index.html');

app.use(express.json());
app.disable('x-powered-by');

app.use((req, res, next) => {
  const isEmbedRoute =
    req.path === '/embed' ||
    req.path === '/embed/' ||
    req.path.startsWith('/embed-app') ||
    req.path.startsWith('/embed-api/') ||
    req.path === '/embed/session';

  // Do not send frame-ancestor restrictions for embed routes. Notion's iPad app
  // appears to use a webview ancestor that does not consistently match the normal
  // notion.so/site origins, which can cause a blank embed despite the page being valid.
  res.removeHeader('X-Frame-Options');
  if (!isEmbedRoute) {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self';");
  } else {
    res.removeHeader('Content-Security-Policy');
  }
  next();
});

app.post('/api/embed-link', requireEmbedAdmin, (req, res) => {
  try {
    if (!EMBED_LINK_SECRET) {
      return res.status(500).json({ error: 'EMBED_LINK_SECRET is not configured' });
    }

    const sub = String(req.body?.sub || '').trim();
    if (!sub) {
      return res.status(400).json({ error: 'sub is required' });
    }

    const requestedPath = String(req.body?.path || '/embed/');
    const defaultScopes = requestedPath.startsWith('/embed-app') ? ['embed:read', 'embed:write'] : ['embed:read'];
    const requestedScopes = Array.isArray(req.body?.scopes) ? req.body.scopes : defaultScopes;
    const scopes = requestedScopes.filter((value: unknown) => typeof value === 'string' && value.trim().length > 0);
    if (scopes.length === 0) {
      return res.status(400).json({ error: 'At least one scope is required' });
    }

    const defaultTtlSeconds = requestedPath.startsWith('/embed-app') ? 0 : EMBED_LINK_TTL_SEC;
    const requestedTtl = Number.parseInt(String(req.body?.ttlSeconds ?? defaultTtlSeconds), 10);
    const ttlSeconds =
      Number.isFinite(requestedTtl) && requestedTtl <= 0
        ? 0
        : clamp(Number.isFinite(requestedTtl) ? requestedTtl : defaultTtlSeconds, 60, 315360000);
    const iat = nowSeconds();
    const exp = ttlSeconds === 0 ? undefined : iat + ttlSeconds;

    const linkToken = signEmbedToken(
      {
        aud: 'notion_embed_link',
        exp,
        iat,
        jti: crypto.randomUUID(),
        scope: scopes,
        sub
      },
      EMBED_LINK_SECRET
    );

    const baseUrl = resolveEmbedBaseUrl(req);
    const embedPath = requestedPath.startsWith('/') ? requestedPath : '/embed/';
    const embedUrl = new URL(embedPath, baseUrl);
    embedUrl.searchParams.set('token', linkToken);

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      embedUrl: embedUrl.toString(),
      expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
      expiresInSeconds: ttlSeconds === 0 ? null : ttlSeconds,
      persistent: ttlSeconds === 0
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Could not create embed link' });
  }
});

app.post(
  '/embed/session',
  applyRateLimit('embed-session', EMBED_SESSION_RATE_LIMIT_MAX, EMBED_SESSION_RATE_LIMIT_WINDOW_SEC),
  (req, res) => {
  try {
    if (!EMBED_LINK_SECRET || !EMBED_SESSION_SECRET) {
      return res.status(500).json({ error: 'Embed secrets are not configured' });
    }

    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    const linkClaims = verifyEmbedToken(token, EMBED_LINK_SECRET);
    if (linkClaims.aud !== 'notion_embed_link') {
      return res.status(401).json({ error: 'Invalid audience' });
    }

    const sessionTtl = clamp(EMBED_SESSION_TTL_SEC, 60, 7200);
    const iat = nowSeconds();
    const exp = iat + sessionTtl;
    const sessionToken = signEmbedToken(
      {
        aud: 'notion_embed_session',
        exp,
        iat,
        jti: crypto.randomUUID(),
        scope: linkClaims.scope,
        sub: linkClaims.sub
      },
      EMBED_SESSION_SECRET
    );

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      accessToken: sessionToken,
      expiresAt: new Date(exp * 1000).toISOString(),
      expiresInSeconds: sessionTtl,
      scope: linkClaims.scope
    });
  } catch (error: any) {
    const message = error?.message === 'Token expired'
      ? 'Embed link expired. Generate a fresh Notion embed link.'
      : error?.message || 'Invalid token';
    return res.status(401).json({ error: message });
  }
}
);

// Initialize Notion SDK on startup if possible
try {
  notion.initNotion();
} catch (e) {
  console.warn('Could not initialize Notion on startup:', e);
}

// Upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({ filename: req.file.originalname });
});

const handleCalendar = async (res: express.Response) => {
  const data = await notion.getCalendarPagesNextN();
  res.json(data);
};

const handleLoadProducts = async (body: any, res: express.Response) => {
  const { filePath } = body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(UPLOAD_DIR, path.basename(filePath));
  const data = await workflow.loadProductsFromExcel(fullPath);
  return res.json(data);
};

const handleSync = async (body: any, res: express.Response) => {
  const { file_path, page_id, products } = body;
  if (!file_path || !page_id) throw new Error('file_path and page_id are required');
  const fullPath = path.isAbsolute(file_path) ? file_path : path.join(UPLOAD_DIR, path.basename(file_path));
  const data = await workflow.highlightAndSync(fullPath, page_id, products || []);
  return res.json(data);
};

const buildEmbedBootstrapScript = (assetScriptPath: string, bootstrapState: EmbedBootstrapState) => `<script type="module">
(() => {
  const bootstrapError = ${JSON.stringify(bootstrapState.error || '')};
  const accessToken = ${JSON.stringify(bootstrapState.accessToken || '')};
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font:14px system-ui;background:#f8fafc;color:#475569;">Loading embedded app...</div>';
  }
  const renderFatal = (message) => {
    document.body.innerHTML = '<pre style="padding:16px;color:#b91c1c;font:14px system-ui;white-space:pre-wrap;">' + String(message) + '</pre>';
  };

  if (bootstrapError) {
    renderFatal(bootstrapError);
    return;
  }

  const sessionPromise = Promise.resolve(accessToken);

  window.__EMBED_MODE__ = true;
  window.__EMBED_SESSION__ = sessionPromise;

  const clearLoadingShell = () => {
    const rootEl = document.getElementById('root');
    if (!rootEl) return;
    const observer = new MutationObserver(() => {
      if (rootEl.childElementCount > 0) {
        observer.disconnect();
      }
    });
    observer.observe(rootEl, { childList: true });
  };

  sessionPromise.catch((error) => {
    renderFatal(error && error.message ? error.message : error);
  });

  window.addEventListener('error', (event) => {
    renderFatal(event.error?.message || event.message || 'Unknown embed runtime error.');
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason && event.reason.message ? event.reason.message : event.reason;
    renderFatal(reason || 'Unhandled promise rejection in embedded app.');
  });

  clearLoadingShell();
  import(${JSON.stringify(assetScriptPath)}).catch((error) => {
    renderFatal(error && error.message ? error.message : error);
  });
})();
</script>`;

const shouldServeLiteEmbedApp = (req: express.Request): boolean => {
  const forceFull = String(req.query?.full || '').toLowerCase();
  if (forceFull === '1' || forceFull === 'true') {
    return false;
  }

  const forceLite = String(req.query?.lite || '').toLowerCase();
  if (forceLite === '1' || forceLite === 'true') {
    return true;
  }

  // Serve the lightweight app by default for Notion embeds. iPadOS often presents
  // a desktop-class user agent, which makes server-side iOS detection unreliable.
  // An explicit `?full=1` override keeps the richer desktop bundle available.
  return true;
};

const renderEmbeddedLiteApp = (req: express.Request, res: express.Response) => {
  const bootstrapState = buildEmbedBootstrapState(req);
  res.setHeader('Cache-Control', 'no-store');
  return res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Painting Team Workflow</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Avenir Next", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
        --bg: #f4eee5;
        --paper: rgba(255, 250, 243, 0.94);
        --panel: rgba(255, 252, 247, 0.94);
        --line: rgba(120, 104, 82, 0.16);
        --ink: #1f1a14;
        --muted: #6f6357;
        --accent: #c2410c;
        --accent-strong: #9a3412;
        --accent-soft: #ffedd5;
        --teal: #115e59;
        --teal-soft: #ccfbf1;
        --rose: #be185d;
        --rose-soft: #fce7f3;
        --shadow: 0 20px 50px rgba(55, 34, 18, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(194, 65, 12, 0.10), transparent 26%),
          radial-gradient(circle at top right, rgba(17, 94, 89, 0.10), transparent 24%),
          linear-gradient(180deg, #faf6ef 0%, var(--bg) 100%);
        color: var(--ink);
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255,255,255,0.28) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.28) 1px, transparent 1px);
        background-size: 24px 24px;
        mask-image: linear-gradient(180deg, rgba(0,0,0,0.45), transparent 82%);
      }
      .shell {
        position: relative;
        max-width: 1024px;
        margin: 0 auto;
        padding: 18px;
      }
      .stack { display: grid; gap: 16px; }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(14px);
      }
      .hero {
        overflow: hidden;
        position: relative;
        padding: 20px;
        background:
          radial-gradient(circle at 15% 20%, rgba(194, 65, 12, 0.16), transparent 24%),
          radial-gradient(circle at 85% 15%, rgba(17, 94, 89, 0.14), transparent 18%),
          linear-gradient(135deg, rgba(255, 246, 236, 0.98), rgba(255, 251, 247, 0.92));
      }
      .hero::after {
        content: "";
        position: absolute;
        width: 220px;
        height: 220px;
        right: -70px;
        bottom: -110px;
        border-radius: 50%;
        background: rgba(194, 65, 12, 0.08);
      }
      .hero-grid {
        position: relative;
        z-index: 1;
        display: grid;
        gap: 18px;
      }
      @media (min-width: 860px) {
        .hero-grid {
          grid-template-columns: 1.3fr 0.9fr;
          align-items: end;
        }
      }
      h1, h2, h3, p { margin: 0; }
      h1 {
        font-size: clamp(24px, 5vw, 34px);
        line-height: 1.02;
        letter-spacing: -0.03em;
        font-weight: 800;
      }
      h2 {
        font-size: 15px;
        font-weight: 800;
        margin-bottom: 12px;
      }
      h3 {
        font-size: 14px;
        font-weight: 700;
      }
      .muted {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 11px;
        border-radius: 999px;
        background: rgba(255,255,255,0.78);
        border: 1px solid rgba(120, 104, 82, 0.12);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--accent-strong);
      }
      .hero-copy {
        display: grid;
        gap: 14px;
      }
      .hero-notes {
        display: grid;
        gap: 10px;
      }
      .hero-note {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        padding: 12px 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.72);
        border: 1px solid rgba(120, 104, 82, 0.10);
      }
      .hero-note strong {
        display: block;
        margin-bottom: 2px;
        font-size: 12px;
      }
      .dot {
        width: 10px;
        height: 10px;
        margin-top: 5px;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--accent), #fb923c);
        flex: 0 0 auto;
      }
      .metrics {
        display: grid;
        gap: 12px;
      }
      .metric {
        padding: 14px 16px;
        border-radius: 20px;
        background: rgba(255,255,255,0.76);
        border: 1px solid rgba(120, 104, 82, 0.10);
      }
      .metric-label {
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.10em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .metric-value {
        margin-top: 6px;
        font-size: 18px;
        font-weight: 800;
      }
      .metric-sub {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }
      .grid {
        display: grid;
        gap: 16px;
      }
      @media (min-width: 760px) {
        .grid.two {
          grid-template-columns: 1fr 1fr;
        }
      }
      .card {
        padding: 18px;
      }
      .card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }
      .step {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 800;
        color: white;
        background: linear-gradient(135deg, var(--accent), #ea580c);
      }
      .tag {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        background: var(--accent-soft);
        color: var(--accent-strong);
      }
      .tag.success {
        background: var(--teal-soft);
        color: var(--teal);
      }
      .tag.rose {
        background: var(--rose-soft);
        color: var(--rose);
      }
      .control {
        display: grid;
        gap: 8px;
      }
      label {
        display: block;
        font-size: 12px;
        font-weight: 800;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      select, input[type="file"], button, a.button {
        width: 100%;
        border-radius: 16px;
        border: 1px solid rgba(120, 104, 82, 0.16);
        background: rgba(255,255,255,0.86);
        color: var(--ink);
        font: inherit;
      }
      select, input[type="file"] {
        padding: 12px 14px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
      }
      button, a.button {
        padding: 13px 16px;
        font-weight: 800;
        text-align: center;
        text-decoration: none;
        cursor: pointer;
      }
      button.primary, a.button.primary {
        background: linear-gradient(135deg, var(--accent), #ea580c);
        border-color: transparent;
        color: #fff;
        box-shadow: 0 16px 30px rgba(194, 65, 12, 0.22);
      }
      button.secondary, a.button.secondary {
        background: rgba(255,255,255,0.8);
        color: var(--ink);
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
        box-shadow: none;
      }
      .note {
        padding: 12px;
        border-radius: 16px;
        background: rgba(255,255,255,0.7);
        border: 1px solid rgba(120, 104, 82, 0.10);
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .error {
        padding: 12px;
        border-radius: 16px;
        background: #fff1f2;
        color: #be123c;
        white-space: pre-wrap;
        border: 1px solid #fecdd3;
      }
      .product-groups {
        display: grid;
        gap: 16px;
      }
      .product-group {
        padding: 14px;
        border-radius: 20px;
        background: rgba(255,255,255,0.74);
        border: 1px solid rgba(120, 104, 82, 0.10);
      }
      .group-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      .group-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .color-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-radius: 999px;
        background: #fff7ed;
        color: var(--accent-strong);
        font-size: 11px;
        font-weight: 700;
      }
      .swatch {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--accent), #fb923c);
      }
      .product-list {
        display: grid;
        gap: 12px;
      }
      .product-card {
        padding: 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.88);
        border: 1px solid rgba(120, 104, 82, 0.08);
        display: grid;
        gap: 12px;
      }
      .product-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .product-title {
        font-size: 14px;
        font-weight: 800;
        line-height: 1.3;
      }
      .product-sub {
        margin-top: 4px;
        font-size: 12px;
        color: var(--muted);
      }
      .trial {
        display: inline-block;
        margin-bottom: 7px;
        padding: 4px 7px;
        border-radius: 999px;
        background: var(--rose-soft);
        color: var(--rose);
        font-size: 10px;
        font-weight: 800;
      }
      .product-metrics {
        text-align: right;
        min-width: 92px;
      }
      .product-metrics strong {
        display: block;
        font-size: 15px;
      }
      .product-metrics span {
        display: block;
        margin-top: 4px;
        font-size: 11px;
        color: var(--muted);
      }
      .product-controls {
        display: grid;
        gap: 8px;
      }
      @media (min-width: 620px) {
        .product-controls {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      .toggle {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid rgba(120, 104, 82, 0.12);
        background: rgba(255,255,255,0.78);
      }
      .toggle input {
        width: 18px;
        height: 18px;
        margin: 0;
        accent-color: var(--accent);
      }
      .toggle span {
        font-size: 12px;
        font-weight: 700;
      }
      .empty {
        padding: 18px;
        border-radius: 18px;
        background: rgba(255,255,255,0.72);
        border: 1px dashed rgba(120, 104, 82, 0.20);
        color: var(--muted);
        font-size: 13px;
        text-align: center;
      }
      .activity {
        display: grid;
        gap: 8px;
      }
      .activity-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 14px;
        background: rgba(255,255,255,0.76);
        border: 1px solid rgba(120, 104, 82, 0.08);
      }
      .activity-index {
        width: 22px;
        height: 22px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 800;
        background: var(--accent-soft);
        color: var(--accent-strong);
      }
      .activity-copy {
        flex: 1;
        min-width: 0;
      }
      .dock {
        position: sticky;
        bottom: 14px;
        z-index: 5;
        padding: 14px;
        border-radius: 22px;
        background: rgba(31, 26, 20, 0.90);
        color: #fff;
        box-shadow: 0 20px 50px rgba(31, 26, 20, 0.22);
      }
      .dock-row {
        display: grid;
        gap: 12px;
      }
      @media (min-width: 760px) {
        .dock-row {
          grid-template-columns: 1fr auto;
          align-items: center;
        }
      }
      .dock-title {
        font-size: 14px;
        font-weight: 800;
      }
      .dock-copy {
        margin-top: 4px;
        color: rgba(255,255,255,0.72);
        font-size: 12px;
      }
      .dock-actions {
        display: grid;
        gap: 10px;
      }
      @media (min-width: 520px) {
        .dock-actions {
          grid-template-columns: repeat(2, minmax(0, auto));
          justify-content: end;
        }
      }
      .dock .button,
      .dock button {
        min-width: 180px;
      }
      .hidden { display: none; }
      .footer {
        font-size: 12px;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="stack">
        <section class="panel hero">
          <div class="hero-grid">
            <div class="hero-copy">
              <span class="eyebrow">Notion Share View</span>
              <div>
                <h1>Painting workflow, redesigned for the Notion frame.</h1>
                <p class="muted" style="margin-top: 10px;">
                  Public link, lightweight startup, mobile-safe controls, and a manual download finish so the embed behaves more like Figma, Maps, and other purpose-built share views.
                </p>
              </div>
              <div class="hero-notes">
                <div class="hero-note">
                  <span class="dot"></span>
                  <div>
                    <strong>Responsive first</strong>
                    <div class="muted">Single-column controls on small frames and grouped product cards instead of a dense desktop table.</div>
                  </div>
                </div>
                <div class="hero-note">
                  <span class="dot"></span>
                  <div>
                    <strong>Public, no-login flow</strong>
                    <div class="muted">The embed is self-contained and avoids redirect, auth wall, or extra app chrome.</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="metrics">
              <div class="metric">
                <div class="metric-label">Current status</div>
                <div id="status" class="metric-value">Initializing…</div>
                <div class="metric-sub">The workflow stage updates as data loads.</div>
              </div>
              <div class="metric">
                <div class="metric-label">Delivery model</div>
                <div class="metric-value">Manual finish</div>
                <div class="metric-sub">Processed workbooks open via a direct download action that is friendlier to Notion and iPad.</div>
              </div>
            </div>
          </div>
        </section>

        <section id="error" class="error hidden"></section>

        <section class="grid two">
          <section class="panel card">
            <div class="card-head">
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="step">1</span>
                <div>
                  <h2 style="margin:0;">Choose the target page</h2>
                  <p class="muted">Pick the calendar page that should receive the synced workload.</p>
                </div>
              </div>
              <span class="tag">Live Notion</span>
            </div>
            <div class="control">
              <label for="calendar-select">Target page</label>
              <select id="calendar-select">
                <option value="">Loading pages…</option>
              </select>
            </div>
          </section>

          <section class="panel card">
            <div class="card-head">
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="step">2</span>
                <div>
                  <h2 style="margin:0;">Upload the workbook</h2>
                  <p class="muted">Use the native file picker so the flow remains reliable inside Notion and on iPad.</p>
                </div>
              </div>
              <span class="tag success">Mobile-safe</span>
            </div>
            <div class="control">
              <label for="file-input">Excel workbook</label>
              <input id="file-input" type="file" accept=".xlsx,.xls" />
              <div class="note" id="file-name">No workbook uploaded yet.</div>
            </div>
          </section>
        </section>

        <section class="panel card">
          <div class="card-head">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="step">3</span>
              <div>
                <h2 style="margin:0;">Review the paint groups</h2>
                <p class="muted">This share view groups work by color so the embedded version stays scannable in tight frames.</p>
              </div>
            </div>
            <span class="tag rose">Review before sync</span>
          </div>
          <div id="products-empty" class="empty">Upload a workbook to load products and choose what should sync.</div>
          <div id="products" class="product-groups hidden"></div>
        </section>

        <section class="grid two">
          <section class="panel card">
            <h2>Why this works in Notion</h2>
            <div class="activity">
              <div class="activity-item">
                <span class="activity-index">1</span>
                <div class="activity-copy">
                  <h3>Dedicated share view</h3>
                  <p class="muted">The layout is purpose-built for embedding instead of squeezing the full admin console into an iframe.</p>
                </div>
              </div>
              <div class="activity-item">
                <span class="activity-index">2</span>
                <div class="activity-copy">
                  <h3>Public link flow</h3>
                  <p class="muted">No login wall, no pop-up bootstrap, and no challenge page in front of the frame.</p>
                </div>
              </div>
              <div class="activity-item">
                <span class="activity-index">3</span>
                <div class="activity-copy">
                  <h3>Progressive complexity</h3>
                  <p class="muted">High-level status stays visible first, while dense product controls appear only after a workbook is loaded.</p>
                </div>
              </div>
            </div>
          </section>

          <section class="panel card">
            <h2>Activity feed</h2>
            <div id="log" class="footer">Waiting for input.</div>
          </section>
        </section>

        <section class="dock">
          <div class="dock-row">
            <div>
              <div class="dock-title">Ready to sync when both a page and workbook are selected.</div>
              <div class="dock-copy">After the sync completes, the processed workbook appears as a direct download action here.</div>
            </div>
            <div class="dock-actions">
              <button id="sync-button" class="primary" disabled>Sync to Notion</button>
              <a id="download-link" class="button secondary hidden" href="#" download>Open processed workbook</a>
            </div>
          </div>
        </section>
      </div>
    </div>

    <script>
      (function () {
        const bootstrapError = ${JSON.stringify(bootstrapState.error || '')};
        const statusEl = document.getElementById('status');
        const errorEl = document.getElementById('error');
        const fileInputEl = document.getElementById('file-input');
        const fileNameEl = document.getElementById('file-name');
        const calendarSelectEl = document.getElementById('calendar-select');
        const syncButtonEl = document.getElementById('sync-button');
        const productsEl = document.getElementById('products');
        const productsEmptyEl = document.getElementById('products-empty');
        const downloadLinkEl = document.getElementById('download-link');
        const logEl = document.getElementById('log');

        const state = {
          accessToken: ${JSON.stringify(bootstrapState.accessToken || '')},
          selectedFile: '',
          selectedCalendarId: '',
          products: [],
          downloadUrl: ''
        };

        const setStatus = (message) => {
          statusEl.textContent = message;
        };

        const setError = (message) => {
          errorEl.textContent = String(message);
          errorEl.classList.remove('hidden');
          setStatus('Needs attention');
        };

        const log = (message) => {
          logEl.textContent = message;
        };

        const updateSyncButton = () => {
          syncButtonEl.disabled = !(state.selectedFile && state.selectedCalendarId);
        };

        const apiFetch = async (path, init) => {
          const headers = new Headers((init && init.headers) || {});
          headers.set('Authorization', 'Bearer ' + state.accessToken);
          return fetch(path, Object.assign({}, init || {}, { headers }));
        };

        const revokeDownload = () => {
          if (state.downloadUrl) {
            URL.revokeObjectURL(state.downloadUrl);
            state.downloadUrl = '';
          }
          downloadLinkEl.classList.add('hidden');
          downloadLinkEl.removeAttribute('href');
        };

        const createDownload = (base64, filename) => {
          revokeDownload();
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          });
          state.downloadUrl = URL.createObjectURL(blob);
          downloadLinkEl.href = state.downloadUrl;
          downloadLinkEl.download = filename;
          downloadLinkEl.className = 'button primary';
          downloadLinkEl.textContent = 'Open processed workbook';
          downloadLinkEl.classList.remove('hidden');
        };

        const renderProducts = () => {
          if (!state.products.length) {
            productsEl.classList.add('hidden');
            productsEmptyEl.classList.remove('hidden');
            productsEmptyEl.textContent = 'Upload a workbook to load products and choose what should sync.';
            return;
          }

          productsEmptyEl.classList.add('hidden');
          productsEl.classList.remove('hidden');

          const groups = state.products.reduce(function (acc, product, index) {
            const groupKey = (product.color || 'Unspecified').trim() || 'Unspecified';
            if (!acc[groupKey]) acc[groupKey] = [];
            acc[groupKey].push({ product: product, index: index });
            return acc;
          }, {});

          productsEl.innerHTML = Object.keys(groups).sort().map(function (groupKey) {
            const items = groups[groupKey];
            const selectedCount = items.filter(function (item) { return item.product.selected; }).length;
            const cards = items.map(function (item) {
              const product = item.product;
              const trial = product.trial
                ? '<span class="trial">' + product.trial + '</span>'
                : '';

              return '' +
                '<article class="product-card">' +
                  '<div class="product-top">' +
                    '<div>' +
                      trial +
                      '<div class="product-title">' + (product.part || 'Untitled part') + '</div>' +
                      '<div class="product-sub">' + (product.date || 'No date') + ' · ' + (product.color || 'No color') + '</div>' +
                    '</div>' +
                    '<div class="product-metrics">' +
                      '<strong>' + (product.qty || 0) + ' pcs</strong>' +
                      '<span>' + (product.ct || 0) + ' sec / part</span>' +
                    '</div>' +
                  '</div>' +
                  '<div class="product-controls">' +
                    '<label class="toggle"><input type="checkbox" data-index="' + item.index + '" data-key="selected"' + (product.selected ? ' checked' : '') + ' /><span>Sync this item</span></label>' +
                    '<label class="toggle"><input type="checkbox" data-index="' + item.index + '" data-key="colorAccent"' + (product.colorAccent ? ' checked' : '') + ' /><span>Append color to part</span></label>' +
                    '<label class="toggle"><input type="checkbox" data-index="' + item.index + '" data-key="override"' + (product.override ? ' checked' : '') + ' /><span>Override existing data</span></label>' +
                  '</div>' +
                '</article>';
            }).join('');

            return '' +
              '<section class="product-group">' +
                '<div class="group-head">' +
                  '<div class="group-meta">' +
                    '<span class="color-chip"><span class="swatch"></span>' + groupKey + '</span>' +
                    '<span class="tag">' + items.length + ' items</span>' +
                  '</div>' +
                  '<span class="tag success">' + selectedCount + ' selected</span>' +
                '</div>' +
                '<div class="product-list">' + cards + '</div>' +
              '</section>';
          }).join('');
        };

        productsEl.addEventListener('change', function (event) {
          const target = event.target;
          if (!target || target.tagName !== 'INPUT') return;
          const index = Number(target.getAttribute('data-index'));
          const key = target.getAttribute('data-key');
          if (!Number.isNaN(index) && key) {
            state.products[index][key] = target.checked;
            renderProducts();
          }
        });

        const loadCalendar = async () => {
          setStatus('Loading calendar');
          const response = await apiFetch('/embed-api/calendar');
          const data = await response.json();
          if (!response.ok || !Array.isArray(data)) {
            throw new Error((data && data.error) || 'Failed to load calendar.');
          }

          calendarSelectEl.innerHTML =
            '<option value="">Choose a calendar page…</option>' +
            data.map(function (page) {
              const title = (page.title || 'Untitled') + ' (' + (page.date || '') + ')';
              return '<option value="' + page.id + '">' + title + '</option>';
            }).join('');

          setStatus('Ready for workbook');
          log('Calendar loaded and ready.');
        };

        const loadProducts = async () => {
          if (!state.selectedFile) return;
          setStatus('Reviewing workbook');
          const response = await apiFetch('/embed-api/load-products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: state.selectedFile })
          });
          const data = await response.json();
          if (!response.ok || !Array.isArray(data)) {
            throw new Error((data && data.error) || 'Failed to load products.');
          }

          state.products = data;
          renderProducts();
          setStatus('Ready to sync');
          log('Loaded ' + data.length + ' products from ' + state.selectedFile + '.');
        };

        const initialize = async () => {
          try {
            if (bootstrapError) {
              throw new Error(bootstrapError);
            }

            if (!state.accessToken) {
              throw new Error('Missing embed access token.');
            }

            await loadCalendar();
          } catch (error) {
            setError(error && error.message ? error.message : error);
          }
        };

        calendarSelectEl.addEventListener('change', function (event) {
          state.selectedCalendarId = event.target.value;
          updateSyncButton();
        });

        fileInputEl.addEventListener('change', async function (event) {
          try {
            const file = event.target.files && event.target.files[0];
            if (!file) return;

            revokeDownload();
            setStatus('Uploading workbook');
            const formData = new FormData();
            formData.append('file', file);
            const response = await apiFetch('/embed-api/upload', {
              method: 'POST',
              body: formData
            });
            const data = await response.json();
            if (!response.ok || !data.filename) {
              throw new Error((data && data.error) || 'Upload failed.');
            }

            state.selectedFile = data.filename;
            fileNameEl.textContent = 'Uploaded workbook: ' + data.filename;
            updateSyncButton();
            log('File uploaded: ' + data.filename + '.');
            await loadProducts();
          } catch (error) {
            setError(error && error.message ? error.message : error);
          }
        });

        syncButtonEl.addEventListener('click', async function () {
          if (!state.selectedFile || !state.selectedCalendarId) return;
          try {
            setStatus('Syncing to Notion');
            log('Running sync for the selected paint groups.');
            const response = await apiFetch('/embed-api/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                file_path: state.selectedFile,
                page_id: state.selectedCalendarId,
                products: state.products
              })
            });
            const data = await response.json();
            if (!response.ok) {
              throw new Error((data && data.error) || 'Sync failed.');
            }

            if (data && data.buffer) {
              createDownload(data.buffer, state.selectedFile || 'updated_plan.xlsx');
            }

            setStatus('Sync complete');
            log('Sync finished. The processed workbook is ready to open.');
          } catch (error) {
            setError(error && error.message ? error.message : error);
          }
        });

        window.addEventListener('beforeunload', revokeDownload);
        initialize();
      })();
    </script>
  </body>
</html>`);
};

const renderEmbeddedDistApp = (req: express.Request, res: express.Response) => {
  const bootstrapState = buildEmbedBootstrapState(req);
  if (!fs.existsSync(distIndexPath)) {
    return res.status(500).send('dist/index.html not found. Run npm run build first.');
  }

  const rawHtml = fs.readFileSync(distIndexPath, 'utf8');
  const scriptMatch = rawHtml.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/i);
  if (!scriptMatch) {
    return res.status(500).send('Could not locate built module script in dist/index.html.');
  }

  const assetScriptPath = scriptMatch[1];
  const withoutModuleScript = rawHtml.replace(scriptMatch[0], '');
  const bootstrap = buildEmbedBootstrapScript(assetScriptPath, bootstrapState);
  const html = withoutModuleScript.includes('</body>')
    ? withoutModuleScript.replace('</body>', `${bootstrap}\n</body>`)
    : `${withoutModuleScript}\n${bootstrap}`;

  res.setHeader('Cache-Control', 'no-store');
  return res.type('html').send(html);
};

// API Endpoints
app.get('/api/calendar', async (req, res) => {
  try {
    await handleCalendar(res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get(
  '/embed-api/me',
  applyRateLimit('embed-api', EMBED_API_RATE_LIMIT_MAX, EMBED_API_RATE_LIMIT_WINDOW_SEC),
  requireEmbedScope('embed:read'),
  (req, res) => {
  const claims = res.locals.embedClaims as EmbedClaims;
  return res.json({
    scope: claims.scope,
    sub: claims.sub
  });
}
);

app.get(
  '/embed-api/calendar',
  applyRateLimit('embed-api', EMBED_API_RATE_LIMIT_MAX, EMBED_API_RATE_LIMIT_WINDOW_SEC),
  requireEmbedScope('embed:read'),
  async (req, res) => {
  try {
    await handleCalendar(res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
);

app.get(['/embed', '/embed/'], (req, res) => {
  const bootstrapState = buildEmbedBootstrapState(req);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Notion Embed</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 16px; background: #fff; color: #111; }
      .card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; }
      .muted { color: #6b7280; font-size: 13px; }
      pre { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; overflow: auto; }
      h1 { font-size: 16px; margin: 0 0 8px; }
      .err { color: #b91c1c; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Embed Calendar</h1>
      <div id="status" class="muted">Initializing...</div>
      <pre id="output"></pre>
    </div>
    <script>
      const statusEl = document.getElementById('status');
      const outputEl = document.getElementById('output');
      const bootstrapError = ${JSON.stringify(bootstrapState.error || '')};
      const accessToken = ${JSON.stringify(bootstrapState.accessToken || '')};
      const setStatus = (text, isError = false) => {
        statusEl.textContent = text;
        statusEl.className = isError ? 'err' : 'muted';
      };

      (async () => {
        try {
          if (bootstrapError) {
            throw new Error(bootstrapError);
          }
          if (!accessToken) {
            throw new Error('Missing embed access token.');
          }

          setStatus('Loading calendar data...');
          const dataResp = await fetch('/embed-api/calendar', {
            headers: { Authorization: 'Bearer ' + accessToken }
          });
          const data = await dataResp.json();
          if (!dataResp.ok) throw new Error(data.error || 'Failed to load calendar.');

          setStatus('Loaded');
          outputEl.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
          setStatus('Failed', true);
          outputEl.textContent = String(err && err.message ? err.message : err);
        }
      })();
    </script>
  </body>
</html>`);
});

app.post('/api/load-products', async (req, res) => {
  try {
    await handleLoadProducts(req.body, res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    await handleSync(req.body, res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post(
  '/embed-api/upload',
  applyRateLimit('embed-api', EMBED_API_RATE_LIMIT_MAX, EMBED_API_RATE_LIMIT_WINDOW_SEC),
  requireEmbedScope('embed:write'),
  upload.single('file'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    return res.json({ filename: req.file.originalname });
  }
);

app.post(
  '/embed-api/load-products',
  applyRateLimit('embed-api', EMBED_API_RATE_LIMIT_MAX, EMBED_API_RATE_LIMIT_WINDOW_SEC),
  requireEmbedScope('embed:write'),
  async (req, res) => {
    try {
      await handleLoadProducts(req.body, res);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  '/embed-api/sync',
  applyRateLimit('embed-api', EMBED_API_RATE_LIMIT_MAX, EMBED_API_RATE_LIMIT_WINDOW_SEC),
  requireEmbedScope('embed:write'),
  async (req, res) => {
    try {
      await handleSync(req.body, res);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.get(['/embed-app', '/embed-app/', '/embed-app/*'], (req, res) => {
  if (shouldServeLiteEmbedApp(req)) {
    return renderEmbeddedLiteApp(req, res);
  }
  return renderEmbeddedDistApp(req, res);
});

// Serve frontend in production
app.use(express.static(path.join(__dirname, 'dist')));

// SPA support: Fallback to index.html for all non-API requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Backend server running on port ${port}`);
});
