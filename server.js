#!/usr/bin/env node
/*
 * Zero-dependency static web server for this site.
 *
 *   npm start                     -> http://localhost:3000 (and opens your browser)
 *   node server.js --port 8080    -> custom port   (or: PORT=8080 node server.js)
 *   node server.js --host 0.0.0.0 -> custom bind address (or: HOST=...)
 *
 * Why a server is needed: the site is a Next.js production build. Every asset is
 * linked with a root path (/_next/static/...), which only resolves when this folder
 * is served as the root of an http:// site - not when index.html is opened as a file.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

const ROOT = __dirname;
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const requestedPort = Number(option('--port') || process.env.PORT || 3000);
const host = option('--host') || process.env.HOST || undefined; // undefined = all interfaces
const openBrowser = args.includes('--open');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

const reportedMissing = new Set();

function logMissing(pathname) {
  if (reportedMissing.has(pathname)) return;
  reportedMissing.add(pathname);
  console.log(`  [missing] ${pathname}  (not included in this copy of the site)`);
}

function sendNotFound(req, res, pathname, { blocked = false } = {}) {
  if (!blocked) logMissing(pathname);
  // Page-like URLs (e.g. /portfolio) get the friendly 404 page; assets get plain text.
  const looksLikePage = !path.extname(pathname) || pathname.endsWith('.html');
  const notFoundPage = path.join(ROOT, '404.html');
  if (looksLikePage && fs.existsSync(notFoundPage)) {
    res.writeHead(404, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(notFoundPage).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': MIME_TYPES['.txt'] });
  res.end(req.method === 'HEAD' ? undefined : `404 Not Found: ${pathname}\n`);
}

function serveFile(req, res, filePath, stat) {
  const headers = {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': 'no-cache', // always revalidate, so edits show up on reload
    'Accept-Ranges': 'bytes',
  };

  const since = req.headers['if-modified-since'];
  if (since && Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(since) / 1000)) {
    res.writeHead(304, headers);
    return res.end();
  }

  // Byte-range support: needed for <video> seeking (and for any video playback in Safari).
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const size = stat.size;
    let start;
    let end;
    if (range[1] === '') {
      start = Math.max(0, size - Number(range[2])); // suffix range: last N bytes
      end = size - 1;
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }

  let pathname;
  try {
    // Query strings such as "?dpl=..." are cache-busters added by Next.js: ignore them.
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (pathname.includes('\0')) {
    res.writeHead(400);
    return res.end('Bad request');
  }

  // Never serve hidden files/folders (.git, .env, ...) and never leave the site folder.
  const filePathRaw = path.join(ROOT, pathname);
  if (pathname.split('/').some((segment) => segment.startsWith('.')) ||
      (filePathRaw !== ROOT && !filePathRaw.startsWith(ROOT + path.sep))) {
    return sendNotFound(req, res, pathname, { blocked: true });
  }

  fs.stat(filePathRaw, (err, stat) => {
    if (!err && stat.isDirectory()) {
      const indexFile = path.join(filePathRaw, 'index.html');
      return fs.stat(indexFile, (indexErr, indexStat) =>
        indexErr ? sendNotFound(req, res, pathname) : serveFile(req, res, indexFile, indexStat));
    }
    if (err || !stat.isFile()) return sendNotFound(req, res, pathname);
    serveFile(req, res, filePathRaw, stat);
  });
});

function launchBrowser(url) {
  const command = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(command, () => { /* no browser available (e.g. on a server) - that's fine */ });
}

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  Port ${port} is busy, trying ${port + 1}...`);
      return listen(port + 1, attemptsLeft - 1);
    }
    console.error(`  Could not start the server: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const url = `http://localhost:${port}`;
    console.log('');
    console.log('  Triptych website (local copy) is running:');
    console.log(`    ${url}`);
    console.log('');
    console.log('  Press Ctrl+C to stop.');
    console.log('');
    if (openBrowser) launchBrowser(url);
  });
}

listen(requestedPort, 10);
