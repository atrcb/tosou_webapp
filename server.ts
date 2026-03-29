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

// Allow embedding in Notion iframe (web + mobile app webviews)
const FRAME_ANCESTORS = [
  "'self'",
  'https://www.notion.so',
  'https://notion.so',
  'https://*.notion.so',
  'https://www.notion.site',
  'https://notion.site',
  'https://*.notion.site'
].join(' ');

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
  // Use CSP frame-ancestors instead of X-Frame-Options (supports allow-list).
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS};`);
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

const buildEmbedBootstrapScript = (assetScriptPath: string) => `<script type="module">
(() => {
  const params = new URLSearchParams(window.location.search);
  const linkToken = params.get('token');
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font:14px system-ui;background:#f8fafc;color:#475569;">Loading embedded app...</div>';
  }
  const renderFatal = (message) => {
    document.body.innerHTML = '<pre style="padding:16px;color:#b91c1c;font:14px system-ui;white-space:pre-wrap;">' + String(message) + '</pre>';
  };

  if (!linkToken) {
    renderFatal('Missing token query parameter.');
    return;
  }

  const sessionPromise = fetch('/embed/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: linkToken })
  }).then(async (response) => {
    const data = await response.json();
    if (!response.ok || !data.accessToken) {
      throw new Error(data.error || 'Failed to create embed session.');
    }
    return data.accessToken;
  });

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

const isIosLikeUserAgent = (userAgent: string): boolean => {
  const ua = userAgent || '';
  return /iPad|iPhone|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua));
};

const shouldServeLiteEmbedApp = (req: express.Request): boolean => {
  const forceLite = String(req.query?.lite || '').toLowerCase();
  if (forceLite === '1' || forceLite === 'true') {
    return true;
  }

  return isIosLikeUserAgent(req.get('user-agent') || '');
};

const renderEmbeddedLiteApp = (res: express.Response) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Notion Embed</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: #f8fafc;
        color: #0f172a;
      }
      .shell {
        max-width: 920px;
        margin: 0 auto;
        padding: 16px;
      }
      .stack { display: grid; gap: 16px; }
      .card {
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 14px;
        padding: 16px;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
      }
      .hero {
        background: linear-gradient(135deg, #eef2ff 0%, #f8fafc 100%);
        border-color: #c7d2fe;
      }
      h1, h2, h3, p { margin: 0; }
      h1 { font-size: 20px; font-weight: 700; }
      h2 { font-size: 15px; font-weight: 700; margin-bottom: 12px; }
      p.muted, .muted { color: #475569; font-size: 13px; }
      .status {
        margin-top: 8px;
        font-size: 13px;
        color: #334155;
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
      label {
        display: block;
        font-size: 12px;
        font-weight: 700;
        color: #475569;
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      select, input[type="file"], button, a.button {
        width: 100%;
        border-radius: 10px;
        border: 1px solid #cbd5e1;
        background: #fff;
        color: #0f172a;
        font: inherit;
      }
      select, input[type="file"] {
        padding: 10px 12px;
      }
      button, a.button {
        padding: 11px 14px;
        font-weight: 600;
        text-align: center;
        text-decoration: none;
        cursor: pointer;
      }
      button.primary, a.button.primary {
        background: #4f46e5;
        border-color: #4f46e5;
        color: #fff;
      }
      button.secondary, a.button.secondary {
        background: #fff;
        color: #334155;
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      .actions {
        display: grid;
        gap: 10px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-radius: 999px;
        background: #e0e7ff;
        color: #4338ca;
        font-size: 12px;
        font-weight: 700;
      }
      .note {
        padding: 12px;
        border-radius: 10px;
        background: #eff6ff;
        color: #1d4ed8;
        font-size: 13px;
      }
      .error {
        padding: 12px;
        border-radius: 10px;
        background: #fef2f2;
        color: #b91c1c;
        white-space: pre-wrap;
      }
      .products {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      th, td {
        padding: 10px 8px;
        border-bottom: 1px solid #e2e8f0;
        text-align: left;
        vertical-align: top;
      }
      th {
        color: #475569;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      td.right, th.right { text-align: right; }
      .badge {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 999px;
        background: #fee2e2;
        color: #b91c1c;
        font-size: 10px;
        font-weight: 700;
      }
      .hidden { display: none; }
      .footer {
        font-size: 12px;
        color: #64748b;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="stack">
        <section class="card hero">
          <span class="pill">iOS Compatibility Mode</span>
          <h1 style="margin-top: 12px;">Painting Team Workflow Manager</h1>
          <p class="muted" style="margin-top: 8px;">
            This lightweight embed avoids the full desktop bundle and uses the standard file picker and manual download flow for Notion on iPad.
          </p>
          <div id="status" class="status">Initializing…</div>
        </section>

        <section id="error" class="error hidden"></section>

        <section class="grid two">
          <div class="card">
            <h2>1. Calendar</h2>
            <label for="calendar-select">Target Page</label>
            <select id="calendar-select">
              <option value="">Loading…</option>
            </select>
          </div>

          <div class="card">
            <h2>2. Excel File</h2>
            <label for="file-input">Upload Workbook</label>
            <input id="file-input" type="file" accept=".xlsx,.xls" />
            <p id="file-name" class="muted" style="margin-top: 10px;">No file uploaded.</p>
          </div>
        </section>

        <section class="card">
          <h2>3. Sync</h2>
          <div class="actions">
            <div class="note">
              On iPad and inside Notion, the processed workbook is prepared as a manual download after sync completes.
            </div>
            <button id="sync-button" class="primary" disabled>Sync To Notion</button>
            <a id="download-link" class="button secondary hidden" href="#" download>Open Processed Excel</a>
          </div>
        </section>

        <section class="card">
          <h2>Products</h2>
          <div id="products-empty" class="muted">Upload a workbook to load products.</div>
          <div id="products" class="products hidden"></div>
        </section>

        <section class="card">
          <h2>Activity</h2>
          <div id="log" class="footer">Waiting for input.</div>
        </section>
      </div>
    </div>

    <script>
      (function () {
        const params = new URLSearchParams(window.location.search);
        const linkToken = params.get('token');
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
          accessToken: '',
          selectedFile: '',
          selectedCalendarId: '',
          products: [],
          downloadUrl: '',
          downloadName: 'updated_plan.xlsx'
        };

        const setStatus = (message) => {
          statusEl.textContent = message;
        };

        const setError = (message) => {
          errorEl.textContent = String(message);
          errorEl.classList.remove('hidden');
          setStatus('Failed');
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
          state.downloadName = filename;
          downloadLinkEl.href = state.downloadUrl;
          downloadLinkEl.download = filename;
          downloadLinkEl.className = 'button primary';
          downloadLinkEl.textContent = 'Open Processed Excel';
          downloadLinkEl.classList.remove('hidden');
        };

        const renderProducts = () => {
          if (!state.products.length) {
            productsEl.classList.add('hidden');
            productsEmptyEl.classList.remove('hidden');
            productsEmptyEl.textContent = 'Upload a workbook to load products.';
            return;
          }

          productsEmptyEl.classList.add('hidden');
          productsEl.classList.remove('hidden');

          const rows = state.products.map((product, index) => {
            const trial = product.trial ? '<div><span class="badge">' + product.trial + '</span></div>' : '';
            return '<tr>' +
              '<td><input type="checkbox" data-index="' + index + '" data-key="selected"' + (product.selected ? ' checked' : '') + ' /></td>' +
              '<td><input type="checkbox" data-index="' + index + '" data-key="colorAccent"' + (product.colorAccent ? ' checked' : '') + ' /></td>' +
              '<td><input type="checkbox" data-index="' + index + '" data-key="override"' + (product.override ? ' checked' : '') + ' /></td>' +
              '<td>' + trial + '<div>' + (product.part || '') + '</div><div class="muted">' + (product.color || '') + '</div></td>' +
              '<td class="right">' + (product.qty || 0) + '</td>' +
              '<td class="right">' + (product.ct || 0) + '</td>' +
            '</tr>';
          }).join('');

          productsEl.innerHTML =
            '<table>' +
              '<thead>' +
                '<tr>' +
                  '<th>Sync</th>' +
                  '<th>Color</th>' +
                  '<th>Override</th>' +
                  '<th>Part</th>' +
                  '<th class="right">Qty</th>' +
                  '<th class="right">C/T</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table>';

          Array.prototype.forEach.call(productsEl.querySelectorAll('input[type="checkbox"]'), function (input) {
            input.addEventListener('change', function (event) {
              const target = event.target;
              const index = Number(target.getAttribute('data-index'));
              const key = target.getAttribute('data-key');
              if (!Number.isNaN(index) && key) {
                state.products[index][key] = target.checked;
              }
            });
          });
        };

        const loadCalendar = async () => {
          setStatus('Loading calendar…');
          const response = await apiFetch('/embed-api/calendar');
          const data = await response.json();
          if (!response.ok || !Array.isArray(data)) {
            throw new Error((data && data.error) || 'Failed to load calendar.');
          }

          calendarSelectEl.innerHTML =
            '<option value="">Select a calendar page…</option>' +
            data.map(function (page) {
              const title = (page.title || 'Untitled') + ' (' + (page.date || '') + ')';
              return '<option value="' + page.id + '">' + title + '</option>';
            }).join('');

          setStatus('Ready');
          log('Calendar loaded.');
        };

        const loadProducts = async () => {
          if (!state.selectedFile) return;
          setStatus('Loading products…');
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
          setStatus('Products loaded');
          log('Loaded ' + data.length + ' products from ' + state.selectedFile + '.');
        };

        const initialize = async () => {
          try {
            if (!linkToken) {
              throw new Error('Missing token query parameter.');
            }

            setStatus('Creating session…');
            const sessionResponse = await fetch('/embed/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: linkToken })
            });
            const sessionData = await sessionResponse.json();
            if (!sessionResponse.ok || !sessionData.accessToken) {
              throw new Error((sessionData && sessionData.error) || 'Failed to create embed session.');
            }

            state.accessToken = sessionData.accessToken;
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
            setStatus('Uploading file…');
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
            fileNameEl.textContent = 'Uploaded: ' + data.filename;
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
            setStatus('Syncing with Notion…');
            log('Running sync…');
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

const renderEmbeddedDistApp = (res: express.Response) => {
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
  const bootstrap = buildEmbedBootstrapScript(assetScriptPath);
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

app.get(['/embed', '/embed/'], (_req, res) => {
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
      const setStatus = (text, isError = false) => {
        statusEl.textContent = text;
        statusEl.className = isError ? 'err' : 'muted';
      };

      (async () => {
        try {
          const params = new URLSearchParams(window.location.search);
          const linkToken = params.get('token');
          if (!linkToken) throw new Error('Missing token query parameter.');

          setStatus('Exchanging token...');
          const sessionResp = await fetch('/embed/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: linkToken })
          });
          const sessionData = await sessionResp.json();
          if (!sessionResp.ok || !sessionData.accessToken) {
            throw new Error(sessionData.error || 'Failed to create embed session.');
          }

          setStatus('Loading calendar data...');
          const dataResp = await fetch('/embed-api/calendar', {
            headers: { Authorization: 'Bearer ' + sessionData.accessToken }
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
    return renderEmbeddedLiteApp(res);
  }
  return renderEmbeddedDistApp(res);
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
