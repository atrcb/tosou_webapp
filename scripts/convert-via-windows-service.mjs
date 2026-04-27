#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

const parseArgs = (argv) => {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = '1';
      continue;
    }

    result[key] = next;
    index += 1;
  }
  return result;
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const options = parseArgs(args);
const inputDir = options['input-dir'];
const outputPath = options.output;
const rootName = options['root-name'] || (options.input ? path.basename(options.input) : '');
const converterUrl = (process.env.WINDOWS_CONVERTER_URL || '').replace(/\/+$/, '');
const converterToken = process.env.WINDOWS_CONVERTER_TOKEN || '';
const timeoutMs = Number.parseInt(process.env.WINDOWS_CONVERTER_REQUEST_TIMEOUT_MS || '840000', 10);

if (!inputDir) {
  fail('Missing --input-dir for Windows CAD converter bridge.');
}
if (!outputPath) {
  fail('Missing --output for Windows CAD converter bridge.');
}
if (!rootName) {
  fail('Missing --root-name for Windows CAD converter bridge.');
}
if (!converterUrl) {
  fail('WINDOWS_CONVERTER_URL is not configured.');
}
if (!converterToken) {
  fail('WINDOWS_CONVERTER_TOKEN is not configured.');
}
if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
  fail('This converter bridge requires Node 20+ fetch/FormData/Blob support.');
}

const readRegularFiles = async (directory) => {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    files.push(path.join(directory, entry.name));
  }
  return files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
};

const fileToBlob = async (filePath) => {
  if (typeof fs.openAsBlob === 'function') {
    return fs.openAsBlob(filePath);
  }
  return new Blob([await fs.promises.readFile(filePath)]);
};

const readErrorMessage = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const payload = await response.json().catch(() => null);
    if (payload?.error) {
      return String(payload.error);
    }
    if (payload?.message) {
      return String(payload.message);
    }
  }

  const text = await response.text().catch(() => '');
  return text.trim() || `HTTP ${response.status}`;
};

const main = async () => {
  const files = await readRegularFiles(inputDir);
  if (!files.length) {
    fail(`No files found in ${inputDir}.`);
  }

  const form = new FormData();
  form.append('rootName', rootName);
  form.append('rootFileName', rootName);

  for (const filePath of files) {
    form.append('files', await fileToBlob(filePath), path.basename(filePath));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 840000);

  let response;
  try {
    response = await fetch(`${converterUrl}/convert`, {
      body: form,
      headers: {
        Authorization: `Bearer ${converterToken}`,
      },
      method: 'POST',
      signal: controller.signal,
    });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Windows CAD converter request timed out.'
      : `Windows CAD converter request failed: ${error?.message || error}`;
    fail(message);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    fail(`Windows CAD converter failed (${response.status}): ${detail}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    fail('Windows CAD converter returned an empty GLB.');
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, bytes);
};

main().catch((error) => {
  fail(error?.message || String(error));
});
