#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const ignoredDirectories = new Set(['.git', 'node_modules']);
const checks = [];

function relative(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

function walk(directory) {
  const files = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function localReference(rawUrl, htmlFile) {
  const trimmed = rawUrl.trim();
  if (
    !trimmed
    || trimmed.startsWith('#')
    || trimmed.startsWith('//')
    || /^[a-z][a-z\d+.-]*:/i.test(trimmed)
  ) {
    return null;
  }

  const withoutFragment = trimmed.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) {
    return null;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    return { rawUrl, error: 'contains invalid percent-encoding' };
  }

  const resolved = decoded.startsWith('/')
    ? path.resolve(projectRoot, `.${decoded}`)
    : path.resolve(path.dirname(htmlFile), decoded);
  const insideProject = resolved === projectRoot
    || resolved.startsWith(`${projectRoot}${path.sep}`);

  if (!insideProject) {
    return { rawUrl, error: 'resolves outside the project root' };
  }

  return { rawUrl, resolved };
}

function extractReferences(html, htmlFile) {
  const references = [];
  const attributePattern = /<([a-z][\w:-]*)\b[^>]*?\b(src|href|poster)\s*=\s*(["'])(.*?)\3/gi;
  let match;

  while ((match = attributePattern.exec(html)) !== null) {
    const reference = localReference(match[4], htmlFile);
    if (reference) {
      references.push({
        ...reference,
        tag: match[1].toLowerCase(),
        attribute: match[2].toLowerCase(),
      });
    }
  }

  return references;
}

const requiredProjectFiles = [
  'index.html',
  'package.json',
  'scripts/dev-server.sh',
  'scripts/probe.js',
];
const missingProjectFiles = requiredProjectFiles.filter(
  (file) => !fs.existsSync(path.join(projectRoot, file)),
);
addCheck(
  'required project files exist',
  missingProjectFiles.length === 0,
  missingProjectFiles.length
    ? `missing: ${missingProjectFiles.join(', ')}`
    : `${requiredProjectFiles.length} files found`,
);

let packageJson;
try {
  packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const devCommand = packageJson.scripts && packageJson.scripts.dev;
  addCheck(
    'package.json defines a development server',
    typeof devCommand === 'string'
      && /(http\.server|\bserve\b)/.test(devCommand),
    typeof devCommand === 'string' ? `dev: ${devCommand}` : 'scripts.dev is missing',
  );
} catch (error) {
  addCheck('package.json is valid JSON', false, error.message);
}

const allFiles = walk(projectRoot);
const htmlFiles = allFiles.filter((file) => path.extname(file).toLowerCase() === '.html');
const javaScriptFiles = allFiles.filter((file) => path.extname(file).toLowerCase() === '.js');
addCheck(
  'HTML entry point is discoverable',
  htmlFiles.includes(path.join(projectRoot, 'index.html')),
  htmlFiles.length
    ? `${htmlFiles.length} HTML file(s): ${htmlFiles.map(relative).join(', ')}`
    : 'no HTML files found',
);

const allReferences = [];
for (const htmlFile of htmlFiles) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  for (const reference of extractReferences(html, htmlFile)) {
    allReferences.push({ ...reference, htmlFile });
  }
}

const brokenReferences = [];
for (const reference of allReferences) {
  if (reference.error) {
    brokenReferences.push(
      `${relative(reference.htmlFile)} -> ${reference.rawUrl} (${reference.error})`,
    );
    continue;
  }

  if (!fs.existsSync(reference.resolved)) {
    brokenReferences.push(
      `${relative(reference.htmlFile)} -> ${reference.rawUrl} (not found)`,
    );
  }
}
addCheck(
  'local HTML references resolve',
  htmlFiles.length > 0 && brokenReferences.length === 0,
  brokenReferences.length
    ? brokenReferences.join('; ')
    : `${allReferences.length} local reference(s) checked`,
);

const requiredJavaScript = allReferences.filter(
  (reference) => reference.tag === 'script' && reference.attribute === 'src',
);
const missingJavaScript = requiredJavaScript.filter(
  (reference) => reference.error || !fs.existsSync(reference.resolved),
);
addCheck(
  'required JavaScript files exist',
  requiredJavaScript.length > 0 && missingJavaScript.length === 0,
  requiredJavaScript.length === 0
    ? 'index.html does not reference a local JavaScript entry point'
    : missingJavaScript.length
      ? `missing: ${missingJavaScript.map((item) => item.rawUrl).join(', ')}`
      : `${requiredJavaScript.length} script reference(s) found`,
);

const syntaxErrors = [];
for (const javaScriptFile of javaScriptFiles) {
  const result = spawnSync(process.execPath, ['--check', javaScriptFile], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const diagnostic = (result.stderr || result.stdout || 'unknown syntax error')
      .trim()
      .replace(/\s+/g, ' ');
    syntaxErrors.push(`${relative(javaScriptFile)}: ${diagnostic}`);
  }
}
addCheck(
  'JavaScript syntax passes node --check',
  javaScriptFiles.length > 0 && syntaxErrors.length === 0,
  syntaxErrors.length
    ? syntaxErrors.join('; ')
    : `${javaScriptFiles.length} JavaScript file(s) checked`,
);

console.log('Egg Agent Survivor environment probe');
console.log(`Project root: ${projectRoot}`);
console.log('');

for (const check of checks) {
  console.log(`[${check.passed ? 'PASS' : 'FAIL'}] ${check.name} — ${check.detail}`);
}

const failed = checks.filter((check) => !check.passed);
console.log('');
console.log(`Summary: ${checks.length - failed.length} passed, ${failed.length} failed`);
console.log(`PROBE_RESULT=${failed.length === 0 ? 'PASS' : 'FAIL'}`);

process.exitCode = failed.length === 0 ? 0 : 1;
