import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import crypto from 'crypto';
import * as dailyWorkflow from './src/server/dailyWorkflow.js';
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

type StartupCacheWarmSummary = {
  calendarPages: number;
  failures: string[];
  nestedDatabases: number;
  partsEntries: number;
  warmedDatabases: number;
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
const STARTUP_CACHE_WARMUP_ENABLED = (process.env.STARTUP_CACHE_WARMUP || '1').trim() !== '0';

const formatWarmupError = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
};

const warmStartupCachesSafely = async (): Promise<StartupCacheWarmSummary> => {
  const notionWithWarmup = notion as typeof notion & {
    warmStartupCaches?: () => Promise<StartupCacheWarmSummary>;
  };

  if (typeof notionWithWarmup.warmStartupCaches === 'function') {
    return notionWithWarmup.warmStartupCaches();
  }

  const summary: StartupCacheWarmSummary = {
    calendarPages: 0,
    failures: [],
    nestedDatabases: 0,
    partsEntries: 0,
    warmedDatabases: 0,
  };

  const [partsMapResult, calendarPagesResult] = await Promise.allSettled([
    notion.buildPartsMap(),
    notion.getCalendarPagesNextN(),
  ]);

  if (partsMapResult.status === 'fulfilled') {
    summary.partsEntries = Object.keys(partsMapResult.value).length;
  } else {
    summary.failures.push(`parts map: ${formatWarmupError(partsMapResult.reason)}`);
  }

  let calendarPages: Array<{id: string; title: string; date: string}> = [];
  if (calendarPagesResult.status === 'fulfilled') {
    calendarPages = calendarPagesResult.value;
    summary.calendarPages = calendarPages.length;
  } else {
    summary.failures.push(`calendar pages: ${formatWarmupError(calendarPagesResult.reason)}`);
  }

  if (calendarPages.length === 0) {
    return summary;
  }

  const nestedDatabaseResults = await Promise.allSettled(
    calendarPages.map((page) => notion.findNestedDatabases(page.id, '作業内容')),
  );

  const nestedDatabaseIds = new Set<string>();
  nestedDatabaseResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      result.value.forEach((databaseId) => nestedDatabaseIds.add(databaseId));
      return;
    }

    const page = calendarPages[index];
    summary.failures.push(
      `nested dbs for ${page?.title || page?.id || `page-${index + 1}`}: ${formatWarmupError(result.reason)}`,
    );
  });

  const nestedDatabaseList = Array.from(nestedDatabaseIds);
  summary.nestedDatabases = nestedDatabaseList.length;

  if (nestedDatabaseList.length === 0) {
    return summary;
  }

  const nestedPageResults = await Promise.allSettled(
    nestedDatabaseList.map((databaseId) => notion.getAllPages(databaseId)),
  );

  nestedPageResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      summary.warmedDatabases += 1;
      return;
    }

    summary.failures.push(
      `nested db pages ${nestedDatabaseList[index]}: ${formatWarmupError(result.reason)}`,
    );
  });

  return summary;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const readQueryStringValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0].trim();
  }
  return '';
};

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
      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : readQueryStringValue(req.query?.access_token);
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

    const requestedPath = String(req.body?.path || '/embed-app/');
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

const handleInitializeCaches = async (res: express.Response) => {
  const summary = await warmStartupCachesSafely();
  res.json(summary);
};

const handleDownloadWorkbook = async (fileParam: unknown, res: express.Response) => {
  const requested = readQueryStringValue(fileParam);
  if (!requested) {
    return res.status(400).json({ error: 'file is required' });
  }

  const filename = path.basename(requested);
  const fullPath = path.join(UPLOAD_DIR, filename);
  try {
    await fs.promises.access(fullPath, fs.constants.R_OK);
  } catch {
    return res.status(404).json({ error: 'Workbook not found' });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.download(fullPath, filename);
};

const handleLoadProducts = async (body: any, res: express.Response) => {
  const { filePath, pageId, page_id } = body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(UPLOAD_DIR, path.basename(filePath));
  const targetPageId = typeof pageId === 'string' && pageId.trim() ? pageId.trim() : typeof page_id === 'string' ? page_id.trim() : '';
  const data = await workflow.loadProductsFromExcel(fullPath, targetPageId || undefined);
  return res.json(data);
};

const handleSync = async (body: any, res: express.Response) => {
  const { file_path, page_id, products } = body;
  if (!file_path || !page_id) throw new Error('file_path and page_id are required');
  const fullPath = path.isAbsolute(file_path) ? file_path : path.join(UPLOAD_DIR, path.basename(file_path));
  const data = await workflow.highlightAndSync(fullPath, page_id, products || []);
  return res.json(data);
};

const handleDailyRun = async (body: any, res: express.Response) => {
  const { file_path, page_id } = body;
  if (!file_path || !page_id) throw new Error('file_path and page_id are required');
  const fullPath = path.isAbsolute(file_path) ? file_path : path.join(UPLOAD_DIR, path.basename(file_path));
  const data = await dailyWorkflow.runDailyWorkflow(fullPath, page_id);
  return res.json(data);
};

const handleRemoveProduct = async (body: any, res: express.Response) => {
  const { page_id, product } = body;
  if (!page_id || !product) {
    return res.status(400).json({ error: 'page_id and product are required' });
  }

  const data = await workflow.removeProductFromNotion(page_id, product);
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

  // Default to the shared React layout so embed URLs match the main app.
  // Keep `?lite=1` available as a compatibility fallback for stricter webviews.
  return false;
};

const renderEmbeddedLegacyLiteApp = (req: express.Request, res: express.Response) => {
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

        productsEl.addEventListener('click', async function (event) {
          const target = event.target;
          const button = target && target.closest ? target.closest('[data-remove-index]') : null;
          if (!button) return;

          const index = Number(button.getAttribute('data-remove-index'));
          if (Number.isNaN(index) || !state.products[index] || !state.selectedCalendarId || state.removingProductId) {
            return;
          }

          const product = state.products[index];
          state.removingProductId = product.id || String(index);
          renderProducts();
          setStatus('Removing item from Notion');
          addActivity('Removing ' + (product.part || 'item') + ' from Notion.', 'warning', '−');

          try {
            const response = await apiFetch('/embed-api/remove-product', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                page_id: state.selectedCalendarId,
                product: product
              })
            });
            const data = await response.json();
            if (!response.ok) {
              throw new Error((data && data.error) || 'Failed to remove product.');
            }

            if (data && data.removed) {
              state.products[index] = Object.assign({}, product, { alreadySynced: false });
              setStatus('Notion item removed');
              addActivity((product.part || 'Item') + ' was removed from Notion.', 'success', '−');
            } else {
              setStatus('Notion item not found');
              addActivity('No matching Notion row was found for ' + (product.part || 'item') + '.', 'warning', '−');
            }
          } catch (error) {
            setError(error && error.message ? error.message : error);
          } finally {
            state.removingProductId = '';
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

const renderEmbeddedLiteApp = (req: express.Request, res: express.Response) => {
  const forceLegacy = String(req.query?.legacy || '').toLowerCase();
  if (forceLegacy === '1' || forceLegacy === 'true') {
    return renderEmbeddedLegacyLiteApp(req, res);
  }

  const bootstrapState = buildEmbedBootstrapState(req);
  res.setHeader('Cache-Control', 'no-store');
  return res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Painting Team Launcher</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Avenir Next", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
        --bg: #f4eee5;
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
        --violet: #7c3aed;
        --violet-soft: #f3e8ff;
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
      code {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(255,255,255,0.76);
        border: 1px solid rgba(120, 104, 82, 0.10);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .icon-inline {
        width: 16px;
        height: 16px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.9;
        stroke-linecap: round;
        stroke-linejoin: round;
        flex: 0 0 auto;
      }
      .icon-shell {
        width: 42px;
        height: 42px;
        border-radius: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        background: linear-gradient(135deg, var(--accent), #fb923c);
        box-shadow: 0 16px 30px rgba(194, 65, 12, 0.20);
        flex: 0 0 auto;
      }
      .icon-shell svg {
        width: 18px;
        height: 18px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.9;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .icon-shell.teal {
        background: linear-gradient(135deg, var(--teal), #14b8a6);
        box-shadow: 0 16px 30px rgba(17, 94, 89, 0.18);
      }
      .icon-shell.violet {
        background: linear-gradient(135deg, var(--violet), #be185d);
        box-shadow: 0 16px 30px rgba(124, 58, 237, 0.18);
      }
      .icon-shell.soft {
        background: rgba(255,255,255,0.82);
        color: var(--accent-strong);
        box-shadow: none;
        border: 1px solid rgba(120, 104, 82, 0.10);
      }
      .muted {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
      }
      .shell {
        position: relative;
        max-width: 1024px;
        margin: 0 auto;
        padding: 18px;
      }
      .stack {
        display: grid;
        gap: 16px;
      }
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
          grid-template-columns: 1.25fr 0.9fr;
          align-items: end;
        }
      }
      .hero-copy {
        display: grid;
        gap: 14px;
      }
      .hero-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .quick-button {
        width: auto;
        padding: 11px 14px;
        border-radius: 18px;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        background: rgba(255,255,255,0.82);
        border: 1px solid rgba(120, 104, 82, 0.12);
        box-shadow: 0 14px 28px rgba(55, 34, 18, 0.08);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.02em;
      }
      .quick-button svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.9;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .quick-button.primary {
        background: linear-gradient(135deg, rgba(194, 65, 12, 0.92), rgba(251, 146, 60, 0.92));
        color: #fff;
        border-color: transparent;
      }
      .quick-button.teal {
        color: var(--teal);
      }
      .quick-button.violet {
        color: var(--violet);
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
        position: relative;
        overflow: hidden;
        padding: 14px 16px;
        border-radius: 20px;
        background: rgba(255,255,255,0.76);
        border: 1px solid rgba(120, 104, 82, 0.10);
      }
      .metric::after {
        content: "";
        position: absolute;
        width: 88px;
        height: 88px;
        right: -32px;
        bottom: -38px;
        border-radius: 999px;
        background: rgba(194, 65, 12, 0.06);
      }
      .metric-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
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
      .micro-grid {
        display: grid;
        gap: 12px;
      }
      @media (min-width: 760px) {
        .micro-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      .micro-card {
        padding: 14px;
        border-radius: 20px;
        background: rgba(255,255,255,0.78);
        border: 1px solid rgba(120, 104, 82, 0.10);
        display: grid;
        gap: 10px;
      }
      .micro-head {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .micro-head strong {
        display: block;
        font-size: 13px;
        line-height: 1.3;
      }
      .micro-copy {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.55;
      }
      .view-stack {
        display: grid;
        gap: 16px;
      }
      .launcher-grid {
        display: grid;
        gap: 16px;
      }
      @media (min-width: 760px) {
        .launcher-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
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
      button {
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
        box-shadow: none;
      }
      .launcher-card {
        width: 100%;
        display: grid;
        gap: 14px;
        padding: 18px;
        text-align: left;
        border-radius: 24px;
        border: 1px solid rgba(120, 104, 82, 0.12);
        background:
          radial-gradient(circle at top right, rgba(255,255,255,0.62), transparent 34%),
          linear-gradient(180deg, rgba(255,255,255,0.88), rgba(255,252,247,0.94));
        box-shadow: var(--shadow);
        transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
      }
      .launcher-card:hover {
        transform: translateY(-2px);
        border-color: rgba(194, 65, 12, 0.26);
        box-shadow: 0 24px 54px rgba(55, 34, 18, 0.12);
      }
      .launcher-card.featured {
        background:
          radial-gradient(circle at top right, rgba(255,255,255,0.66), transparent 30%),
          linear-gradient(135deg, rgba(255, 241, 230, 0.98), rgba(255, 249, 242, 0.96));
        border-color: rgba(194, 65, 12, 0.22);
      }
      .launcher-card.muted-card {
        background:
          radial-gradient(circle at top right, rgba(255,255,255,0.58), transparent 32%),
          linear-gradient(180deg, rgba(247, 243, 238, 0.96), rgba(255, 252, 247, 0.94));
      }
      .launcher-card-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 14px;
      }
      .launcher-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.10em;
        text-transform: uppercase;
        background: rgba(255,255,255,0.82);
        border: 1px solid rgba(120, 104, 82, 0.10);
        color: var(--accent-strong);
      }
      .launcher-chip.success {
        color: var(--teal);
      }
      .launcher-chip.rose {
        color: var(--rose);
      }
      .launcher-icon {
        width: 50px;
        height: 50px;
        border-radius: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        font-size: 18px;
        font-weight: 800;
        letter-spacing: 0.08em;
        color: #fff;
        background: linear-gradient(135deg, var(--accent), #fb923c);
        box-shadow: 0 16px 28px rgba(194, 65, 12, 0.20);
      }
      .launcher-icon svg {
        width: 22px;
        height: 22px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.9;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .launcher-card[data-launch="daily"] .launcher-icon {
        background: linear-gradient(135deg, var(--teal), #14b8a6);
        box-shadow: 0 16px 28px rgba(17, 94, 89, 0.18);
      }
      .launcher-card[data-launch="defects"] .launcher-icon {
        background: linear-gradient(135deg, var(--violet), #be185d);
        box-shadow: 0 16px 28px rgba(124, 58, 237, 0.18);
      }
      .launcher-card p {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
      }
      .launcher-route {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--accent-strong);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .launcher-route.success {
        color: var(--teal);
      }
      .launcher-route.rose {
        color: var(--rose);
      }
      .launcher-route::after {
        content: ">";
      }
      .card {
        padding: 18px;
      }
      .card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 14px;
      }
      .card-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
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
      .tag.violet {
        background: var(--violet-soft);
        color: var(--violet);
      }
      .mini-button {
        width: auto;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(255,255,255,0.80);
        border: 1px solid rgba(120, 104, 82, 0.16);
        font-size: 12px;
        font-weight: 700;
        color: var(--ink);
      }
      .mini-button.compact {
        padding: 7px 10px;
        font-size: 11px;
      }
      .mini-button.rose {
        background: var(--rose-soft);
        border-color: rgba(190, 24, 93, 0.16);
        color: var(--rose);
      }
      .view-header {
        padding: 20px;
        background:
          radial-gradient(circle at top right, rgba(194, 65, 12, 0.12), transparent 28%),
          linear-gradient(135deg, rgba(255, 248, 240, 0.98), rgba(255, 252, 247, 0.96));
      }
      .view-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }
      .back-link {
        width: auto;
        padding: 9px 12px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        background: rgba(255,255,255,0.78);
        border: 1px solid rgba(120, 104, 82, 0.12);
        color: var(--accent-strong);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.10em;
        text-transform: uppercase;
      }
      .view-title {
        margin-top: 12px;
        font-size: clamp(26px, 5vw, 34px);
        line-height: 1.02;
        letter-spacing: -0.03em;
        font-weight: 800;
      }
      .view-badges {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .workflow-grid {
        display: grid;
        gap: 16px;
      }
      @media (min-width: 920px) {
        .workflow-grid {
          grid-template-columns: 1fr 1fr 0.92fr;
        }
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
      select, input[type="file"], .block-button, a.button {
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
      .block-button, a.button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 13px 16px;
        font-weight: 800;
        text-align: center;
        text-decoration: none;
        cursor: pointer;
      }
      .block-button.primary, a.button.primary {
        background: linear-gradient(135deg, var(--accent), #ea580c);
        border-color: transparent;
        color: #fff;
        box-shadow: 0 16px 30px rgba(194, 65, 12, 0.22);
      }
      .block-button.secondary, a.button.secondary {
        background: rgba(255,255,255,0.8);
        color: var(--ink);
      }
      .note {
        padding: 12px;
        border-radius: 16px;
        background:
          radial-gradient(circle at top right, rgba(255,255,255,0.48), transparent 34%),
          rgba(255,255,255,0.72);
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
        flex-wrap: wrap;
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
      .product-status-row {
        margin-top: 10px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
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
      .toggle span {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        font-weight: 700;
      }
      .toggle span::before {
        width: 18px;
        height: 18px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-size: 10px;
        font-weight: 800;
        flex: 0 0 auto;
      }
      .toggle[data-kind="sync"] span::before {
        content: "S";
        background: linear-gradient(135deg, var(--accent), #fb923c);
      }
      .toggle[data-kind="color"] span::before {
        content: "+";
        background: linear-gradient(135deg, var(--teal), #14b8a6);
      }
      .toggle[data-kind="force"] span::before {
        content: "!";
        background: linear-gradient(135deg, var(--violet), #be185d);
      }
      .toggle input {
        width: 18px;
        height: 18px;
        margin: 0;
        accent-color: var(--accent);
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
        overflow: hidden;
      }
      .activity-index svg {
        width: 12px;
        height: 12px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.9;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .activity-copy {
        flex: 1;
        min-width: 0;
      }
      .activity-title {
        font-size: 13px;
        font-weight: 700;
        line-height: 1.45;
      }
      .activity-item.tone-success .activity-index {
        background: var(--teal-soft);
        color: var(--teal);
      }
      .activity-item.tone-warning .activity-index {
        background: #fef3c7;
        color: #b45309;
      }
      .activity-item.tone-error .activity-index {
        background: var(--rose-soft);
        color: var(--rose);
      }
      .daily-list,
      .placeholder-steps {
        display: grid;
        gap: 12px;
      }
      .daily-item,
      .placeholder-step {
        padding: 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.80);
        border: 1px solid rgba(120, 104, 82, 0.10);
      }
      .daily-item strong,
      .placeholder-step strong {
        display: block;
        font-size: 14px;
        margin-bottom: 6px;
      }
      .placeholder-board {
        padding: 24px;
        text-align: center;
      }
      .placeholder-art {
        width: 68px;
        height: 68px;
        margin: 0 auto 16px;
        border-radius: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, var(--violet), #be185d);
        color: white;
        font-size: 22px;
        font-weight: 800;
        letter-spacing: 0.08em;
        box-shadow: 0 18px 34px rgba(124, 58, 237, 0.18);
      }
      @media (min-width: 760px) {
        .placeholder-steps {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      .dock {
        position: sticky;
        bottom: 14px;
        z-index: 5;
        padding: 14px;
        border-radius: 22px;
        background:
          radial-gradient(circle at top right, rgba(251, 146, 60, 0.22), transparent 28%),
          linear-gradient(135deg, rgba(31, 26, 20, 0.94), rgba(51, 37, 26, 0.94));
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
      .dock .block-button {
        min-width: 180px;
      }
      .launcher-screen {
        gap: 18px;
      }
      .launcher-topbar,
      .launcher-hero,
      .launcher-overview,
      .launcher-tools,
      .list-panel {
        border-color: rgba(120, 104, 82, 0.10);
        background: rgba(255,255,255,0.76);
        box-shadow: 0 10px 30px rgba(55, 34, 18, 0.05);
      }
      .launcher-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 14px 18px;
        flex-wrap: wrap;
      }
      .launcher-brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .brand-mark {
        width: 36px;
        height: 36px;
        border-radius: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(245, 238, 230, 0.96));
        border: 1px solid rgba(120, 104, 82, 0.10);
        color: var(--ink);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.10em;
      }
      .brand-copy strong {
        display: block;
        font-size: 14px;
        font-weight: 700;
      }
      .brand-copy span {
        display: block;
        margin-top: 2px;
        color: var(--muted);
        font-size: 12px;
      }
      .launcher-nav {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .nav-pill {
        width: auto;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid transparent;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }
      .nav-pill.active {
        background: rgba(255,255,255,0.82);
        border-color: rgba(120, 104, 82, 0.10);
        color: var(--ink);
      }
      .nav-pill:not(.active):hover {
        background: rgba(255,255,255,0.64);
      }
      .launcher-hero {
        padding: 28px 20px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.84), rgba(255,252,247,0.90));
      }
      .launcher-hero-copy {
        max-width: 620px;
        display: grid;
        gap: 14px;
      }
      .launcher-kicker {
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .launcher-support {
        max-width: 520px;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.6;
      }
      .launcher-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .launcher-primary {
        width: auto;
        min-width: 172px;
      }
      .launcher-secondary {
        width: auto;
        color: var(--muted);
        font-size: 13px;
        font-weight: 700;
      }
      .launcher-overview,
      .launcher-tools,
      .list-panel {
        padding: 18px 20px;
      }
      .launcher-section-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 16px;
      }
      .launcher-status {
        display: inline-flex;
        align-items: center;
        padding: 7px 11px;
        border-radius: 999px;
        background: rgba(255,255,255,0.82);
        border: 1px solid rgba(120, 104, 82, 0.10);
        color: var(--ink);
        font-size: 12px;
        font-weight: 700;
      }
      .overview-grid {
        display: grid;
        border-top: 1px solid rgba(120, 104, 82, 0.10);
      }
      @media (min-width: 760px) {
        .overview-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      .overview-item {
        display: grid;
        gap: 8px;
        padding: 16px 0;
      }
      .overview-item:not(:last-child) {
        border-bottom: 1px solid rgba(120, 104, 82, 0.10);
      }
      @media (min-width: 760px) {
        .overview-item:not(:last-child) {
          border-bottom: 0;
          border-right: 1px solid rgba(120, 104, 82, 0.10);
          padding-right: 18px;
        }
        .overview-item:not(:first-child) {
          padding-left: 18px;
        }
      }
      .overview-label {
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.10em;
        text-transform: uppercase;
      }
      .overview-item strong {
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .overview-note {
        color: var(--muted);
        font-size: 13px;
      }
      .tool-list,
      .utility-list {
        display: grid;
      }
      .tool-row,
      .utility-row {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 15px 0;
        text-align: left;
        border-bottom: 1px solid rgba(120, 104, 82, 0.10);
      }
      .tool-row:last-child,
      .utility-row:last-child {
        border-bottom: 0;
        padding-bottom: 0;
      }
      .tool-row:first-child,
      .utility-row:first-child {
        padding-top: 0;
      }
      .tool-copy {
        display: grid;
        gap: 4px;
      }
      .tool-copy strong {
        font-size: 16px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .tool-copy span,
      .utility-row span:last-child {
        color: var(--muted);
        font-size: 13px;
      }
      .tool-action {
        color: var(--accent-strong);
        font-size: 13px;
        font-weight: 700;
      }
      .tool-row.primary .tool-copy strong {
        color: var(--ink);
      }
      .activity-compact .activity-item {
        padding: 14px 0;
        background: transparent;
        border: 0;
        border-bottom: 1px solid rgba(120, 104, 82, 0.10);
        border-radius: 0;
      }
      .activity-compact .activity-item:last-child {
        border-bottom: 0;
        padding-bottom: 0;
      }
      .activity-compact .activity-index {
        width: 18px;
        height: 18px;
        font-size: 10px;
      }
      .utility-row span:first-child {
        font-size: 14px;
        font-weight: 600;
      }
      .hidden { display: none !important; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="stack">
        <section id="error" class="error hidden"></section>

        <div id="launcher-view" class="view-stack launcher-screen">
          <section class="panel launcher-topbar">
            <div class="launcher-brand">
              <div class="brand-mark">PT</div>
              <div class="brand-copy">
                <strong>Painting Team</strong>
                <span>Embed tools</span>
              </div>
            </div>
            <nav class="launcher-nav" aria-label="Launcher navigation">
              <span class="nav-pill active">Home</span>
              <button class="nav-pill" data-launch="workflow" type="button">Workflow</button>
              <button class="nav-pill" data-launch="daily" type="button">Daily</button>
              <button class="nav-pill" data-launch="defects" type="button">Defects</button>
            </nav>
          </section>

          <section class="panel launcher-hero">
            <div class="launcher-hero-copy">
              <p class="launcher-kicker">Launcher</p>
              <h1>Workflow tools, simplified.</h1>
              <p class="launcher-support">Start with the live workflow and keep the frame calm.</p>
              <div class="launcher-actions">
                <button class="block-button primary launcher-primary" data-launch="workflow" type="button">Open Workflow</button>
                <button class="launcher-secondary" data-refresh-launcher type="button">Refresh</button>
              </div>
            </div>
          </section>

          <section class="panel launcher-overview">
            <div class="launcher-section-head">
              <div>
                <h2>Overview</h2>
                <p class="muted">Status, availability, next step.</p>
              </div>
              <div class="launcher-status" data-status-text>Connecting...</div>
            </div>
            <div class="overview-grid">
              <div class="overview-item">
                <span class="overview-label">Availability</span>
                <strong>Workflow live</strong>
                <span class="overview-note"><span data-calendar-count>0</span> pages ready</span>
              </div>
              <div class="overview-item">
                <span class="overview-label">Focus</span>
                <strong>Workflow Manager</strong>
                <span class="overview-note">Primary working feature</span>
              </div>
              <div class="overview-item">
                <span class="overview-label">Next</span>
                <strong>Open workflow</strong>
                <span class="overview-note">Choose a page and workbook</span>
              </div>
            </div>
          </section>

          <section class="panel launcher-tools">
            <div class="launcher-section-head">
              <div>
                <h2>Tools</h2>
                <p class="muted">Quiet entry points.</p>
              </div>
            </div>
            <div class="tool-list">
              <button class="tool-row primary" data-launch="workflow" type="button">
                <div class="tool-copy">
                  <strong>Workflow Manager</strong>
                  <span>Live</span>
                </div>
                <span class="tool-action">Open</span>
              </button>
              <button class="tool-row" data-launch="daily" type="button">
                <div class="tool-copy">
                  <strong>Daily Workflow Generator</strong>
                  <span>Preview</span>
                </div>
                <span class="tool-action">Preview</span>
              </button>
              <button class="tool-row" data-launch="defects" type="button">
                <div class="tool-copy">
                  <strong>Bad Defect Tracker</strong>
                  <span>Coming soon</span>
                </div>
                <span class="tool-action">View</span>
              </button>
            </div>
          </section>

          <section class="grid two">
            <section class="panel card list-panel">
              <div class="launcher-section-head">
                <div>
                  <h2>Recent activity</h2>
                  <p class="muted">Latest updates.</p>
                </div>
              </div>
              <div id="activity-feed-home" class="activity activity-compact"></div>
            </section>

            <section class="panel card list-panel">
              <div class="launcher-section-head">
                <div>
                  <h2>Utilities</h2>
                  <p class="muted">Small actions.</p>
                </div>
              </div>
              <div class="utility-list">
                <button class="utility-row" data-refresh-launcher type="button">
                  <span>Refresh launcher</span>
                  <span>Reload</span>
                </button>
                <button class="utility-row" data-launch="workflow" type="button">
                  <span>Open workflow</span>
                  <span>Go</span>
                </button>
                <button class="utility-row" data-launch="daily" type="button">
                  <span>Daily preview</span>
                  <span>View</span>
                </button>
              </div>
            </section>
          </section>
        </div>

        <div id="workflow-view" class="view-stack hidden">
          <section class="panel view-header">
            <div class="view-top">
              <div>
                <button class="back-link" data-back-home type="button">
                  <svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19 12H5"></path>
                    <path d="m11 6-6 6 6 6"></path>
                  </svg>
                  Home
                </button>
                <h1 class="view-title">Workflow</h1>
                <p class="muted" style="margin-top: 10px;">
                  Live tool. Same safe flow.
                </p>
              </div>
              <div class="view-badges">
                <span class="tag">Live tool</span>
                <span class="tag success">Notion-safe</span>
              </div>
            </div>
            <div class="note">
              Standard picker, <code>/embed-api/*</code>, manual file handoff.
              Current status: <strong data-status-text>Connecting...</strong>
            </div>
          </section>

          <section class="workflow-grid">
            <section class="panel card">
              <div class="card-head">
                <div style="display:flex;align-items:center;gap:10px;">
                  <span class="step">1</span>
                  <div>
                    <h2 style="margin:0;">Page</h2>
                    <p class="muted">Pick the target.</p>
                  </div>
                </div>
                <span class="tag">Live Notion</span>
              </div>
              <div class="control">
                <label for="calendar-select">Page</label>
                <select id="calendar-select">
                  <option value="">Loading pages...</option>
                </select>
              </div>
            </section>

            <section class="panel card">
              <div class="card-head">
                <div style="display:flex;align-items:center;gap:10px;">
                  <span class="step">2</span>
                  <div>
                    <h2 style="margin:0;">Workbook</h2>
                    <p class="muted">Upload from device.</p>
                  </div>
                </div>
                <span class="tag success">Mobile-safe</span>
              </div>
              <div class="control">
                <label for="file-input">File</label>
                <input id="file-input" type="file" accept=".xlsx,.xls" />
                <div class="note" id="file-name">No file yet.</div>
              </div>
            </section>

            <section class="panel card">
              <div class="card-head">
                <div style="display:flex;align-items:center;gap:10px;">
                  <span class="step">3</span>
                  <div>
                    <h2 style="margin:0;">Ready</h2>
                    <p class="muted">Live summary.</p>
                  </div>
                </div>
                <span class="tag rose">Review first</span>
              </div>
              <div class="activity">
                <div class="activity-item">
                  <span class="activity-index">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 3v4"></path>
                      <path d="M17 3v4"></path>
                      <path d="M4 9h16"></path>
                      <path d="M5 6h14a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a1 1 0 0 1 1-1Z"></path>
                    </svg>
                  </span>
                  <div class="activity-copy">
                    <div class="activity-title">Page</div>
                    <div id="workflow-target" class="muted">None selected.</div>
                  </div>
                </div>
                <div class="activity-item">
                  <span class="activity-index">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"></path>
                      <path d="M14 3v5h5"></path>
                      <path d="M9 13h6"></path>
                    </svg>
                  </span>
                  <div class="activity-copy">
                    <div class="activity-title">File</div>
                    <div id="workflow-file" class="muted">No workbook uploaded.</div>
                  </div>
                </div>
                <div class="activity-item">
                  <span class="activity-index">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="8"></circle>
                      <path d="m9.5 12 1.7 1.7 3.8-4"></path>
                    </svg>
                  </span>
                  <div class="activity-copy">
                    <div class="activity-title">Selection</div>
                    <div id="workflow-count" class="muted">0 ready to sync.</div>
                  </div>
                </div>
              </div>
            </section>
          </section>

          <section class="panel card">
            <div class="card-head">
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="step">4</span>
                <div>
                  <h2 style="margin:0;">Review</h2>
                  <p class="muted">Grouped by color.</p>
                </div>
              </div>
              <div class="card-actions">
                <button id="select-all-products" class="mini-button" type="button">All</button>
                <span class="tag rose">Review before sync</span>
              </div>
            </div>
            <div id="products-empty" class="empty">Upload a workbook to load products and choose what should sync.</div>
            <div id="products" class="product-groups hidden"></div>
          </section>

          <section class="grid two">
            <section class="panel card">
              <h2>Embed Fit</h2>
              <div class="micro-grid">
                <div class="micro-card">
                  <div class="micro-head">
                    <span class="icon-shell soft">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 13h4l2-8 4 14 2-6h4"></path>
                      </svg>
                    </span>
                    <strong>Focused</strong>
                  </div>
                  <div class="micro-copy">No shell bounce.</div>
                </div>
                <div class="micro-card">
                  <div class="micro-head">
                    <span class="icon-shell soft">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M10 14 14 10"></path>
                        <path d="m7.5 16.5-1 1a3 3 0 1 1-4-4l3-3a3 3 0 0 1 4 0l1 1"></path>
                        <path d="m16.5 7.5 1-1a3 3 0 1 1 4 4l-3 3a3 3 0 0 1-4 0l-1-1"></path>
                      </svg>
                    </span>
                    <strong>Same API</strong>
                  </div>
                  <div class="micro-copy">Bearer flow stays.</div>
                </div>
                <div class="micro-card">
                  <div class="micro-head">
                    <span class="icon-shell soft">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 5v11"></path>
                        <path d="m8 12 4 4 4-4"></path>
                        <path d="M4 19h16"></path>
                      </svg>
                    </span>
                    <strong>Manual file</strong>
                  </div>
                  <div class="micro-copy">Webview-friendly.</div>
                </div>
              </div>
            </section>

            <section class="panel card">
              <div class="card-head">
                <div>
                  <h2>Activity feed</h2>
                  <p class="muted">Recent workflow actions stay visible while you review products.</p>
                </div>
                <span class="tag success">Live feed</span>
              </div>
              <div id="activity-feed-workflow" class="activity"></div>
            </section>
          </section>

          <section class="dock">
            <div class="dock-row">
              <div>
                <div class="dock-title">Sync when ready.</div>
                <div class="dock-copy" id="download-copy">Processed file appears here.</div>
              </div>
              <div class="dock-actions">
                <button id="sync-button" class="block-button primary" type="button" disabled>
                  <svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 13h4l2-8 4 14 2-6h4"></path>
                  </svg>
                  <span>Sync</span>
                </button>
                <a id="download-link" class="button secondary hidden" href="#" download>
                  <svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v11"></path>
                    <path d="m8 12 4 4 4-4"></path>
                    <path d="M4 19h16"></path>
                  </svg>
                  <span>Open file</span>
                </a>
              </div>
            </div>
          </section>
        </div>

        <div id="daily-view" class="view-stack hidden">
          <section class="panel view-header">
            <div class="view-top">
              <div>
                <button class="back-link" data-back-home type="button">
                  <svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19 12H5"></path>
                    <path d="m11 6-6 6 6 6"></path>
                  </svg>
                  Home
                </button>
                <h1 class="view-title">Daily</h1>
                <p class="muted" style="margin-top: 10px;">
                  Live dates. Staged action.
                </p>
              </div>
              <div class="view-badges">
                <span class="tag success">Preview lane</span>
                <span class="tag rose">Placeholder action</span>
              </div>
            </div>
          </section>

          <section class="grid two">
            <section class="panel card">
              <div class="card-head">
                <div>
                  <h2>Dates</h2>
                  <p class="muted">Live schedule feed.</p>
                </div>
                <span class="tag">Live dates</span>
              </div>
              <div id="daily-page-list" class="daily-list"></div>
            </section>

            <section class="panel card">
              <div class="card-head">
                <div>
                  <h2>Status</h2>
                  <p class="muted">Preview only.</p>
                </div>
                <span class="tag rose">Coming next</span>
              </div>
              <div class="note">
                Calendar is live. Generation is not wired here yet.
              </div>
              <div class="control" style="margin-top: 14px;">
                <button class="block-button primary" data-launch="workflow" type="button">
                  <svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 13h4l2-8 4 14 2-6h4"></path>
                  </svg>
                  <span>Workflow</span>
                </button>
                <button class="block-button secondary" type="button" disabled>Soon</button>
              </div>
            </section>
          </section>

          <section class="panel card">
            <div class="card-head">
              <div>
                <h2>Plan</h2>
                <p class="muted">Next safe steps.</p>
              </div>
              <span class="tag success">Staged design</span>
            </div>
            <div class="placeholder-steps">
              <div class="placeholder-step">
                <strong>Pick</strong>
                <div class="muted">Use the live page list.</div>
              </div>
              <div class="placeholder-step">
                <strong>Prepare</strong>
                <div class="muted">Keep the same upload flow.</div>
              </div>
              <div class="placeholder-step">
                <strong>Generate</strong>
                <div class="muted">Stay inside the embed view.</div>
              </div>
            </div>
          </section>
        </div>

        <div id="defects-view" class="view-stack hidden">
          <section class="panel view-header">
            <div class="view-top">
              <div>
                <button class="back-link" data-back-home type="button">
                  <svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19 12H5"></path>
                    <path d="m11 6-6 6 6 6"></path>
                  </svg>
                  Home
                </button>
                <h1 class="view-title">Defects</h1>
                <p class="muted" style="margin-top: 10px;">
                  Visible now. Reserved for later.
                </p>
              </div>
              <div class="view-badges">
                <span class="tag violet">Coming soon</span>
              </div>
            </div>
          </section>

          <section class="panel card placeholder-board">
            <div class="placeholder-art">BD</div>
            <h2>Next tool slot</h2>
            <p class="muted" style="max-width: 560px; margin: 12px auto 0;">
              Kept visible without pretending it is live.
            </p>
            <div class="control" style="max-width: 360px; margin: 18px auto 0;">
              <button class="block-button primary" data-launch="workflow" type="button">
                <svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 13h4l2-8 4 14 2-6h4"></path>
                </svg>
                <span>Workflow</span>
              </button>
            </div>
          </section>

          <section class="grid two">
            <section class="panel card">
              <h2>Phases</h2>
              <div class="placeholder-steps">
                <div class="placeholder-step">
                  <strong>Capture</strong>
                  <div class="muted">Log the issue.</div>
                </div>
                <div class="placeholder-step">
                  <strong>Triage</strong>
                  <div class="muted">Route the owner.</div>
                </div>
                <div class="placeholder-step">
                  <strong>Resolve</strong>
                  <div class="muted">Close back in Notion.</div>
                </div>
              </div>
            </section>

            <section class="panel card">
              <h2>Why placeholder</h2>
              <div class="micro-grid" style="grid-template-columns:1fr;">
                <div class="micro-card">
                  <div class="micro-head">
                    <span class="icon-shell soft">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3 19 6v6c0 4.4-2.9 7-7 9-4.1-2-7-4.6-7-9V6l7-3Z"></path>
                      </svg>
                    </span>
                    <strong>Compatibility first</strong>
                  </div>
                  <div class="micro-copy">Safer than shipping another heavy route.</div>
                </div>
                <div class="micro-card">
                  <div class="micro-head">
                    <span class="icon-shell soft">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 12h16"></path>
                        <path d="M12 4v16"></path>
                      </svg>
                    </span>
                    <strong>Clear roadmap</strong>
                  </div>
                  <div class="micro-copy">Visible now, functional later.</div>
                </div>
              </div>
            </section>
          </section>
        </div>
      </div>
    </div>

    <script>
      (function () {
        const bootstrapError = ${JSON.stringify(bootstrapState.error || '')};
        const errorEl = document.getElementById('error');
        const statusEls = Array.from(document.querySelectorAll('[data-status-text]'));
        const calendarCountEls = Array.from(document.querySelectorAll('[data-calendar-count]'));
        const launcherViewEl = document.getElementById('launcher-view');
        const workflowViewEl = document.getElementById('workflow-view');
        const dailyViewEl = document.getElementById('daily-view');
        const defectsViewEl = document.getElementById('defects-view');
        const calendarSelectEl = document.getElementById('calendar-select');
        const fileInputEl = document.getElementById('file-input');
        const fileNameEl = document.getElementById('file-name');
        const syncButtonEl = document.getElementById('sync-button');
        const productsEl = document.getElementById('products');
        const productsEmptyEl = document.getElementById('products-empty');
        const downloadLinkEl = document.getElementById('download-link');
        const downloadCopyEl = document.getElementById('download-copy');
        const workflowTargetEl = document.getElementById('workflow-target');
        const workflowFileEl = document.getElementById('workflow-file');
        const workflowCountEl = document.getElementById('workflow-count');
        const bulkSelectEl = document.getElementById('select-all-products');
        const dailyPageListEl = document.getElementById('daily-page-list');
        const activityFeedHomeEl = document.getElementById('activity-feed-home');
        const activityFeedWorkflowEl = document.getElementById('activity-feed-workflow');
        const viewMap = {
          launcher: launcherViewEl,
          workflow: workflowViewEl,
          daily: dailyViewEl,
          defects: defectsViewEl
        };

        const state = {
          accessToken: ${JSON.stringify(bootstrapState.accessToken || '')},
          selectedFile: '',
          selectedCalendarId: '',
          calendarPages: [],
          calendarLoaded: false,
          products: [],
          downloadUrl: '',
          currentView: 'launcher',
          activity: [],
          removingProductId: ''
        };

        const escapeHtml = function (value) {
          return String(value || '').replace(/[&<>"']/g, function (match) {
            return {
              '&': '&amp;',
              '<': '&lt;',
              '>': '&gt;',
              '"': '&quot;',
              "'": '&#39;'
            }[match];
          });
        };

        const clearError = function () {
          errorEl.textContent = '';
          errorEl.classList.add('hidden');
        };

        const setStatus = function (message) {
          statusEls.forEach(function (el) {
            el.textContent = message;
          });
        };

        const setCalendarCount = function (count) {
          calendarCountEls.forEach(function (el) {
            el.textContent = String(count);
          });
        };

        const renderActivity = function () {
          const html = state.activity.length
            ? state.activity.map(function (entry, index) {
                return '' +
                  '<div class="activity-item tone-' + escapeHtml(entry.tone || 'info') + '">' +
                    '<span class="activity-index">' + escapeHtml(entry.icon || String(index + 1)) + '</span>' +
                    '<div class="activity-copy">' +
                      '<div class="activity-title">' + escapeHtml(entry.message) + '</div>' +
                      '<div class="muted">' + escapeHtml(entry.time) + '</div>' +
                    '</div>' +
                  '</div>';
              }).join('')
            : '<div class="empty">Waiting for the first action.</div>';

          activityFeedHomeEl.innerHTML = html;
          activityFeedWorkflowEl.innerHTML = html;
        };

        const addActivity = function (message, tone, icon) {
          const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
          state.activity.unshift({
            message: String(message),
            time: timestamp,
            tone: tone || 'info',
            icon: icon || ''
          });
          state.activity = state.activity.slice(0, 6);
          renderActivity();
        };

        const setError = function (message) {
          errorEl.textContent = String(message);
          errorEl.classList.remove('hidden');
          setStatus('Needs attention');
          addActivity(String(message), 'error');
        };

        const setView = function (view) {
          const nextView = viewMap[view] ? view : 'launcher';
          state.currentView = nextView;
          Object.keys(viewMap).forEach(function (key) {
            const element = viewMap[key];
            if (!element) return;
            element.classList.toggle('hidden', key !== nextView);
          });
          if (!window.location.pathname.startsWith('/embed-app')) {
            window.scrollTo(0, 0);
          }
        };

        const updateSyncButton = function () {
          syncButtonEl.disabled = !(state.selectedFile && state.selectedCalendarId && state.products.length) || Boolean(state.removingProductId);
        };

        const updateWorkflowSummary = function () {
          const selectedPage = state.calendarPages.find(function (page) {
            return page.id === state.selectedCalendarId;
          });
          workflowTargetEl.textContent = selectedPage
            ? (selectedPage.title || 'Untitled page') + ' (' + (selectedPage.date || '') + ')'
            : 'None selected.';
          workflowFileEl.textContent = state.selectedFile || 'No file.';
          workflowCountEl.textContent = state.products.filter(function (product) {
            return product.selected;
          }).length + ' selected.';
        };

        const updateBulkSelectLabel = function () {
          if (!state.products.length) {
            bulkSelectEl.textContent = 'All';
            bulkSelectEl.disabled = true;
            return;
          }

          bulkSelectEl.disabled = false;
          bulkSelectEl.textContent = state.products.every(function (product) {
            return product.selected;
          }) ? 'Clear' : 'All';
        };

        const apiFetch = async function (path, init) {
          const headers = new Headers((init && init.headers) || {});
          headers.set('Authorization', 'Bearer ' + state.accessToken);
          return fetch(path, Object.assign({}, init || {}, { headers: headers }));
        };

        const revokeDownload = function () {
          if (state.downloadUrl) {
            URL.revokeObjectURL(state.downloadUrl);
            state.downloadUrl = '';
          }
          downloadLinkEl.className = 'button secondary hidden';
          downloadLinkEl.removeAttribute('href');
          downloadCopyEl.textContent = 'Processed file appears here.';
        };

        const createDownload = function (base64, filename) {
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
          downloadLinkEl.innerHTML =
            '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true">' +
              '<path d="M12 5v11"></path>' +
              '<path d="m8 12 4 4 4-4"></path>' +
              '<path d="M4 19h16"></path>' +
            '</svg>' +
            '<span>Open file</span>';
          downloadLinkEl.classList.remove('hidden');
          downloadCopyEl.textContent = filename + ' is ready.';
        };

        const renderDailyPages = function () {
          if (!state.calendarLoaded) {
            dailyPageListEl.innerHTML = '<div class="empty">Upcoming calendar pages will appear here once the launcher finishes loading.</div>';
            return;
          }

          if (!state.calendarPages.length) {
            dailyPageListEl.innerHTML = '<div class="empty">No upcoming calendar pages were returned for this embed session.</div>';
            return;
          }

          dailyPageListEl.innerHTML = state.calendarPages.map(function (page) {
            return '' +
              '<div class="daily-item">' +
                '<strong>' + escapeHtml(page.date || 'No date') + '</strong>' +
                '<div class="muted">' + escapeHtml(page.title || 'Untitled page') + '</div>' +
              '</div>';
          }).join('');
        };

        const renderProducts = function () {
          if (!state.products.length) {
            productsEl.classList.add('hidden');
            productsEmptyEl.classList.remove('hidden');
            productsEmptyEl.textContent = state.selectedFile
              ? 'No products were found in the uploaded workbook.'
              : 'Upload a workbook to begin.';
            updateBulkSelectLabel();
            updateWorkflowSummary();
            updateSyncButton();
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
            const selectedCount = items.filter(function (item) {
              return item.product.selected;
            }).length;

            const cards = items.map(function (item) {
              const product = item.product;
              const trial = product.trial
                ? '<span class="trial">' + escapeHtml(product.trial) + '</span>'
                : '';
              const syncedStatus = product.alreadySynced
                ? '' +
                  '<div class="product-status-row">' +
                    '<span class="tag success">In Notion</span>' +
                    (state.selectedCalendarId
                      ? '<button class="mini-button compact rose" type="button" data-remove-index="' + item.index + '"' + (state.removingProductId ? ' disabled' : '') + '>' + escapeHtml(state.removingProductId === product.id ? 'Removing…' : 'Remove') + '</button>'
                      : '') +
                  '</div>'
                : '';

              return '' +
                '<article class="product-card">' +
                  '<div class="product-top">' +
                    '<div>' +
                      trial +
                      '<div class="product-title">' + escapeHtml(product.part || 'Untitled part') + '</div>' +
                      '<div class="product-sub">' + escapeHtml(product.date || 'No date') + ' / ' + escapeHtml(product.color || 'No color') + '</div>' +
                    '</div>' +
                    '<div class="product-metrics">' +
                      '<strong>' + escapeHtml(product.qty || 0) + ' pcs</strong>' +
                      '<span>' + escapeHtml(product.ct || 0) + ' sec / part</span>' +
                    '</div>' +
                  '</div>' +
                  syncedStatus +
                  '<div class="product-controls">' +
                    '<label class="toggle" data-kind="sync"><input type="checkbox" data-index="' + item.index + '" data-key="selected"' + (product.selected ? ' checked' : '') + ' /><span>Sync</span></label>' +
                    '<label class="toggle" data-kind="color"><input type="checkbox" data-index="' + item.index + '" data-key="colorAccent"' + (product.colorAccent ? ' checked' : '') + ' /><span>Color</span></label>' +
                    '<label class="toggle" data-kind="force"><input type="checkbox" data-index="' + item.index + '" data-key="override"' + (product.override ? ' checked' : '') + ' /><span>Force</span></label>' +
                  '</div>' +
                '</article>';
            }).join('');

            return '' +
              '<section class="product-group">' +
                '<div class="group-head">' +
                  '<div class="group-meta">' +
                    '<span class="color-chip"><span class="swatch"></span>' + escapeHtml(groupKey) + '</span>' +
                    '<span class="tag">' + items.length + ' items</span>' +
                  '</div>' +
                  '<span class="tag success">' + selectedCount + ' selected</span>' +
                '</div>' +
                '<div class="product-list">' + cards + '</div>' +
              '</section>';
          }).join('');

          updateBulkSelectLabel();
          updateWorkflowSummary();
          updateSyncButton();
        };

        Array.from(document.querySelectorAll('[data-launch]')).forEach(function (button) {
          button.addEventListener('click', function () {
            setView(button.getAttribute('data-launch'));
          });
        });

        Array.from(document.querySelectorAll('[data-refresh-launcher]')).forEach(function (button) {
          button.addEventListener('click', async function () {
            try {
              await loadCalendar();
            } catch (error) {
              setError(error && error.message ? error.message : error);
            }
          });
        });

        Array.from(document.querySelectorAll('[data-back-home]')).forEach(function (button) {
          button.addEventListener('click', function () {
            setView('launcher');
          });
        });

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

        bulkSelectEl.addEventListener('click', function () {
          if (!state.products.length) return;
          const shouldSelect = state.products.some(function (product) {
            return !product.selected;
          });
          state.products = state.products.map(function (product) {
            return Object.assign({}, product, { selected: shouldSelect });
          });
          renderProducts();
          addActivity(
            shouldSelect ? 'Selected all loaded products.' : 'Cleared all loaded product selections.',
            'info'
          );
        });

        const loadCalendar = async function () {
          clearError();
          setStatus('Loading calendar');
          const response = await apiFetch('/embed-api/calendar');
          const data = await response.json();
          if (!response.ok || !Array.isArray(data)) {
            throw new Error((data && data.error) || 'Failed to load calendar.');
          }

          state.calendarLoaded = true;
          state.calendarPages = data;
          calendarSelectEl.innerHTML =
            '<option value="">Pick a page...</option>' +
            data.map(function (page) {
              const title = (page.title || 'Untitled') + ' (' + (page.date || '') + ')';
              return '<option value="' + escapeHtml(page.id) + '">' + escapeHtml(title) + '</option>';
            }).join('');

          renderDailyPages();
          setCalendarCount(data.length);
          updateWorkflowSummary();
          setStatus(state.currentView === 'workflow' ? 'Ready for workbook' : 'Launcher ready');
          addActivity('Calendar loaded and launcher is ready.', 'success');
        };

        const loadProducts = async function () {
          if (!state.selectedFile) return;
          clearError();
          setStatus('Reviewing workbook');
          const response = await apiFetch('/embed-api/load-products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: state.selectedFile, page_id: state.selectedCalendarId || undefined })
          });
          const data = await response.json();
          if (!response.ok || !Array.isArray(data)) {
            throw new Error((data && data.error) || 'Failed to load products.');
          }

          state.removingProductId = '';
          state.products = data;
          renderProducts();
          setStatus('Ready to sync');
          addActivity('Loaded ' + data.length + ' products from ' + state.selectedFile + '.', 'success', '⚙️');
        };

        calendarSelectEl.addEventListener('change', async function (event) {
          state.selectedCalendarId = event.target.value;
          updateWorkflowSummary();
          updateSyncButton();
          if (state.selectedFile) {
            try {
              await loadProducts();
            } catch (error) {
              setError(error && error.message ? error.message : error);
            }
          }
        });

        fileInputEl.addEventListener('change', async function (event) {
          try {
            const file = event.target.files && event.target.files[0];
            if (!file) return;

            clearError();
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
            state.products = [];
            fileNameEl.textContent = data.filename;
            renderProducts();
            updateSyncButton();
            addActivity('Workbook uploaded: ' + data.filename + '.', 'success', '⚙️');
            setView('workflow');
            await loadProducts();
          } catch (error) {
            setError(error && error.message ? error.message : error);
          } finally {
            event.target.value = '';
          }
        });

        syncButtonEl.addEventListener('click', async function () {
          if (!state.selectedFile || !state.selectedCalendarId) return;
          try {
            clearError();
            syncButtonEl.disabled = true;
            setStatus('Syncing to Notion');
            addActivity('Running sync for the selected paint groups.', 'warning', '⚙️');
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
            addActivity('Sync finished. The processed workbook is ready to open.', 'success', '⚙️');
          } catch (error) {
            setError(error && error.message ? error.message : error);
          } finally {
            updateSyncButton();
          }
        });

        const initialize = async function () {
          try {
            clearError();
            if (bootstrapError) {
              throw new Error(bootstrapError);
            }

            if (!state.accessToken) {
              throw new Error('Missing embed access token.');
            }

            addActivity('Embed launcher initialized.', 'info');
            renderActivity();
            renderDailyPages();
            updateBulkSelectLabel();
            updateWorkflowSummary();

            const params = new URLSearchParams(window.location.search);
            const tool = params.get('tool') || '';
            if (tool === 'workflow' || tool === 'workflow-manager') {
              setView('workflow');
            } else if (tool === 'daily' || tool === 'daily-generator') {
              setView('daily');
            } else if (tool === 'defects' || tool === 'bad-defect-tracker') {
              setView('defects');
            } else {
              setView('launcher');
            }

            await loadCalendar();
          } catch (error) {
            setError(error && error.message ? error.message : error);
          }
        };

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

app.post('/api/initialize', async (req, res) => {
  try {
    await handleInitializeCaches(res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    await handleDownloadWorkbook(req.query?.file, res);
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

app.post(
  '/embed-api/initialize',
  applyRateLimit('embed-api', EMBED_API_RATE_LIMIT_MAX, EMBED_API_RATE_LIMIT_WINDOW_SEC),
  requireEmbedScope('embed:read'),
  async (req, res) => {
  try {
    await handleInitializeCaches(res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
);

app.get(
  '/embed-api/download',
  applyRateLimit('embed-api', EMBED_API_RATE_LIMIT_MAX, EMBED_API_RATE_LIMIT_WINDOW_SEC),
  requireEmbedScope('embed:read'),
  async (req, res) => {
  try {
    await handleDownloadWorkbook(req.query?.file, res);
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

app.post('/api/daily-run', async (req, res) => {
  try {
    await handleDailyRun(req.body, res);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/remove-product', async (req, res) => {
  try {
    await handleRemoveProduct(req.body, res);
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

app.post(
  '/embed-api/daily-run',
  applyRateLimit('embed-api', EMBED_API_RATE_LIMIT_MAX, EMBED_API_RATE_LIMIT_WINDOW_SEC),
  requireEmbedScope('embed:write'),
  async (req, res) => {
    try {
      await handleDailyRun(req.body, res);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  '/embed-api/remove-product',
  applyRateLimit('embed-api', EMBED_API_RATE_LIMIT_MAX, EMBED_API_RATE_LIMIT_WINDOW_SEC),
  requireEmbedScope('embed:write'),
  async (req, res) => {
    try {
      await handleRemoveProduct(req.body, res);
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

  if (!STARTUP_CACHE_WARMUP_ENABLED) {
    return;
  }

  console.log('Starting Notion cache warmup...');
  void warmStartupCachesSafely()
    .then((summary) => {
      console.log(
        `Notion cache warmup complete: parts=${summary.partsEntries}, calendarPages=${summary.calendarPages}, nestedDatabases=${summary.nestedDatabases}, warmedDatabases=${summary.warmedDatabases}, failures=${summary.failures.length}`
      );
      summary.failures.forEach((failure) => {
        console.warn(`[notion warmup] ${failure}`);
      });
    })
    .catch((error: any) => {
      console.warn(`[notion warmup] failed: ${error?.message || String(error)}`);
    });
});
