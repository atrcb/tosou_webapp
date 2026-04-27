#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const HOST = process.env.WINDOWS_CONVERTER_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.WINDOWS_CONVERTER_PORT || '8732', 10);
const TOKEN = process.env.WINDOWS_CONVERTER_TOKEN || '';
const WORK_ROOT = process.env.CAD_CONVERTER_WORK_DIR || path.join(os.tmpdir(), 'notion-cad-converter-worker');
const INCOMING_DIR = path.join(WORK_ROOT, 'incoming');
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CAD_CONVERTER_TIMEOUT_MS || '900000', 10);
const EDRAWINGS_TIMEOUT_MS = Number.parseInt(process.env.EDRAWINGS_EXPORT_TIMEOUT_MS || '600000', 10);
const EDRAWINGS_STL_EXPORTER_EXE =
  process.env.EDRAWINGS_STL_EXPORTER_EXE ||
  path.join(__dirname, 'edrawings-stl-exporter', 'bin', 'EdrawingsStlExporter.exe');
const BLENDER_EXE = process.env.BLENDER_EXE || 'blender';
const BLENDER_SCRIPT = path.join(__dirname, 'stl-to-glb.py');
const MAX_UPLOAD_MB = Number.parseInt(process.env.CAD_CONVERTER_MAX_UPLOAD_MB || '500', 10);
const CAD_EXTENSIONS = new Set(['easm', 'eprt', 'sldprt', 'sldasm']);
const E_DRAWINGS_EXTENSIONS = new Set(['easm', 'eprt']);

class HttpError extends Error {
  constructor(status, message, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const execFileAsync = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

const runExecutable = async (file, args, options = {}) => {
  try {
    return await execFileAsync(file, args, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: REQUEST_TIMEOUT_MS,
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || '').trim();
    throw new HttpError(500, `${path.basename(file)} failed.`, detail);
  }
};

const sanitizeFilename = (value, fallback = 'model') => {
  const withoutPath = String(value || '').split(/[/\\]+/).pop() || '';
  const cleaned = withoutPath
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');

  if (!cleaned) {
    return fallback;
  }

  const ext = path.extname(cleaned);
  const stem = (ext ? cleaned.slice(0, -ext.length) : cleaned).trim() || fallback;
  const safeExt = ext && /^[.A-Za-z0-9_]+$/.test(ext) ? ext.toLowerCase() : '';
  return `${stem}${safeExt}`;
};

const getExtension = (filename) => path.extname(filename).replace(/^\./, '').toLowerCase();
const stripExtension = (filename) => {
  const ext = path.extname(filename);
  return (ext ? filename.slice(0, -ext.length) : filename).trim() || 'model';
};

const safeRemove = async (target) => {
  await fs.promises.rm(target, { force: true, recursive: true }).catch(() => undefined);
};

const getBearerToken = (req) => {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
};

const isAuthorized = (provided) => {
  if (!TOKEN || !provided || provided.length !== TOKEN.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN));
};

const requireToken = (req, res, next) => {
  if (!TOKEN) {
    res.status(500).json({ error: 'WINDOWS_CONVERTER_TOKEN is not configured on the Windows worker.' });
    return;
  }
  if (!isAuthorized(getBearerToken(req))) {
    res.status(401).json({ error: 'Missing or invalid converter token.' });
    return;
  }
  next();
};

const upload = multer({
  dest: INCOMING_DIR,
  limits: {
    fileSize: Math.max(1, MAX_UPLOAD_MB) * 1024 * 1024,
    files: 64,
  },
});

const stageUploadedFiles = async (files, inputDir, requestedRootName) => {
  const usedNames = new Set();
  let root = null;
  const normalizedRequested = sanitizeFilename(requestedRootName || '').toLowerCase();

  for (const file of files) {
    const originalName = sanitizeFilename(file.originalname || file.filename || 'model');
    const ext = path.extname(originalName);
    const stem = stripExtension(originalName);
    let safeName = originalName;
    let duplicateIndex = 2;

    while (usedNames.has(safeName.toLowerCase())) {
      safeName = `${stem}-${duplicateIndex}${ext}`;
      duplicateIndex += 1;
    }
    usedNames.add(safeName.toLowerCase());

    const destination = path.join(inputDir, safeName);
    await fs.promises.rename(file.path, destination);

    const extension = getExtension(safeName);
    const staged = { extension, name: safeName, path: destination };
    if (!root && normalizedRequested && safeName.toLowerCase() === normalizedRequested) {
      root = staged;
    }
    if (!root && CAD_EXTENSIONS.has(extension)) {
      root = staged;
    }
  }

  return root;
};

const assertReadableFile = async (filePath, description) => {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0) {
    throw new HttpError(500, `${description} was not created.`);
  }
};

const convertCadToGlb = async ({ extension, rootPath, stlPath, glbPath }) => {
  try {
    await runExecutable(
      EDRAWINGS_STL_EXPORTER_EXE,
      ['--input', rootPath, '--output', stlPath, '--timeout-ms', String(EDRAWINGS_TIMEOUT_MS)],
      { cwd: path.dirname(rootPath) },
    );
    await assertReadableFile(stlPath, 'STL export');
  } catch (error) {
    if (error instanceof HttpError && E_DRAWINGS_EXTENSIONS.has(extension)) {
      throw new HttpError(
        422,
        'eDrawings could not export this EASM/EPRT file to STL. If it was shared without Allow STL export enabled, it is protected from conversion.',
        error.detail || error.message,
      );
    }
    throw error;
  }

  await runExecutable(
    BLENDER_EXE,
    ['--background', '--python', BLENDER_SCRIPT, '--', stlPath, glbPath],
    { cwd: repoRoot },
  );
  await assertReadableFile(glbPath, 'GLB output');
};

const checkBlender = async () => {
  try {
    const result = await execFileAsync(BLENDER_EXE, ['--version'], {
      maxBuffer: 1024 * 1024,
      timeout: 10000,
      windowsHide: true,
    });
    return {
      ok: true,
      version: String(result.stdout || '').split(/\r?\n/).find(Boolean) || 'Blender available',
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.stderr || error?.stdout || error?.message || error).trim(),
    };
  }
};

const checkEdrawings = async () => {
  try {
    await fs.promises.access(EDRAWINGS_STL_EXPORTER_EXE, fs.constants.X_OK);
  } catch {
    return {
      ok: false,
      error: `Exporter not found: ${EDRAWINGS_STL_EXPORTER_EXE}`,
    };
  }

  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'eDrawings health check only works on Windows.',
    };
  }

  try {
    await execFileAsync(
      EDRAWINGS_STL_EXPORTER_EXE,
      ['--health', '--timeout-ms', '15000'],
      { maxBuffer: 1024 * 1024, timeout: 20000, windowsHide: true },
    );
    return { ok: true, exporter: EDRAWINGS_STL_EXPORTER_EXE };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.stderr || error?.stdout || error?.message || error).trim(),
    };
  }
};

await fs.promises.mkdir(INCOMING_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');

app.get('/health', async (req, res) => {
  const [edrawings, blender] = await Promise.all([checkEdrawings(), checkBlender()]);
  const ok = Boolean(TOKEN) && edrawings.ok && blender.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    checks: {
      blender,
      edrawings,
      tokenConfigured: Boolean(TOKEN),
    },
  });
});

app.post('/convert', requireToken, upload.array('files', 64), async (req, res) => {
  const uploadFiles = req.files || [];
  const jobId = crypto.randomUUID();
  const jobDir = path.join(WORK_ROOT, 'jobs', jobId);
  const inputDir = path.join(jobDir, 'input');
  const outputDir = path.join(jobDir, 'output');

  try {
    if (!uploadFiles.length) {
      throw new HttpError(400, 'No CAD files were uploaded.');
    }

    await fs.promises.mkdir(inputDir, { recursive: true });
    await fs.promises.mkdir(outputDir, { recursive: true });

    const root = await stageUploadedFiles(
      uploadFiles,
      inputDir,
      req.body?.rootName || req.body?.rootFileName,
    );
    if (!root) {
      throw new HttpError(400, 'No EASM, EPRT, SLDPRT, or SLDASM root file was uploaded.');
    }

    const stlPath = path.join(outputDir, `${stripExtension(root.name)}.stl`);
    const glbPath = path.join(outputDir, `${stripExtension(root.name)}.glb`);
    await convertCadToGlb({
      extension: root.extension,
      glbPath,
      rootPath: root.path,
      stlPath,
    });

    res.setHeader('Cache-Control', 'no-store');
    res.type('model/gltf-binary');
    res.sendFile(glbPath, (error) => {
      safeRemove(jobDir);
      if (error) {
        console.error('Failed to send converted GLB:', error);
      }
    });
  } catch (error) {
    for (const file of uploadFiles) {
      await fs.promises.unlink(file.path).catch(() => undefined);
    }
    await safeRemove(jobDir);
    const status = error instanceof HttpError ? error.status : 500;
    const detail = error instanceof HttpError ? error.detail : '';
    res.status(status).json({
      error: error?.message || 'CAD conversion failed.',
      detail: detail || undefined,
    });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: error?.message || 'Windows CAD worker failed.' });
});

app.listen(PORT, HOST, () => {
  console.log(`Windows CAD converter listening on http://${HOST}:${PORT}`);
});
