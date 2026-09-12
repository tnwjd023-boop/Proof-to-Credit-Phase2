'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PUBLIC_FILES = Object.freeze({
  '/ui/': 'ui/index.html',
  '/ui/index.html': 'ui/index.html',
  '/ui/app.js': 'ui/app.js',
  '/ui/styles.css': 'ui/styles.css',
  '/ui/aggregate.html': 'ui/aggregate.html',
  '/ui/aggregate.js': 'ui/aggregate.js',
  '/ui/aggregate.css': 'ui/aggregate.css',
  '/runs/20260906-t05/manifest.json': 'runs/20260906-t05/manifest.json',
  '/runs/20260906-t05/negative.json': 'runs/20260906-t05/negative.json',
});
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

function resolvePublicFile(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://127.0.0.1').pathname);
  } catch {
    throw new Error('Not found');
  }
  const relative = PUBLIC_FILES[pathname];
  if (!relative) throw new Error('Not found');
  return path.join(ROOT, relative);
}

function contentType(filePath) {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  })[path.extname(filePath)] || 'application/octet-stream';
}

function createUiServer() {
  return http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Method not allowed');
      return;
    }

    if (request.url === '/') {
      response.writeHead(302, { Location: '/ui/' });
      response.end();
      return;
    }

    let filePath;
    try {
      filePath = resolvePublicFile(request.url || '/');
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    fs.readFile(filePath, (error, body) => {
      if (error) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentType(filePath),
        ...SECURITY_HEADERS,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    });
  });
}

function cliPort(argv) {
  const index = argv.indexOf('--port');
  if (index === -1) return 4173;
  const port = Number(argv[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port value');
  return port;
}

if (require.main === module) {
  const port = cliPort(process.argv.slice(2));
  const server = createUiServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Proof-to-Credit read-only UI: http://127.0.0.1:${port}/ui/`);
  });
}

module.exports = { createUiServer, resolvePublicFile };
