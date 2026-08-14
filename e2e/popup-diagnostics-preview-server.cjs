'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const routes = new Map([
  ['/e2e/popup-diagnostics-preview.html', {
    contentType: 'text/html; charset=utf-8',
    file: path.join(root, 'e2e', 'popup-diagnostics-preview.html')
  }],
  ['/v3/data/popup/index.css', {
    contentType: 'text/css; charset=utf-8',
    file: path.join(root, 'v3', 'data', 'popup', 'index.css')
  }]
]);

const server = http.createServer((request, response) => {
  const route = routes.get(new URL(request.url, 'http://127.0.0.1').pathname);
  if (!route || request.method !== 'GET') {
    response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    response.end('Not found');
    return;
  }
  try {
    const bytes = fs.readFileSync(route.file);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': String(bytes.length),
      'content-security-policy': "default-src 'none'; style-src 'self'",
      'content-type': route.contentType,
      'x-content-type-options': 'nosniff'
    });
    response.end(bytes);
  }
  catch (error) {
    response.writeHead(500, {'content-type': 'text/plain; charset=utf-8'});
    response.end('Preview asset unavailable');
  }
});

server.listen(8765, '127.0.0.1', () => {
  process.stdout.write('http://127.0.0.1:8765/e2e/popup-diagnostics-preview.html\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
