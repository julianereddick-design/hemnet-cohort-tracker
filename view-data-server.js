const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.VIEW_SERVER_PORT || 3800;
const BASE_DIR = path.join(__dirname, 'view-data');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function generateIndex(dirPath, urlPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const items = entries
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return b.name.localeCompare(a.name); // newest first
    })
    .map(e => {
      const href = urlPath === '/' ? `/${e.name}` : `${urlPath}/${e.name}`;
      const icon = e.isDirectory() ? '&#128193;' : '&#128196;';
      return `<li>${icon} <a href="${href}">${e.name}${e.isDirectory() ? '/' : ''}</a></li>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html><head><title>View Data — ${urlPath}</title>
<style>body{font-family:Arial,sans-serif;margin:30px;max-width:800px}
a{color:#1565C0;text-decoration:none}a:hover{text-decoration:underline}
li{margin:6px 0;font-size:15px}h1{font-size:20px}</style></head>
<body><h1>View Data: ${urlPath}</h1>
<ul>${items}</ul></body></html>`;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Strip /view-data prefix if present, or serve from root
  let relativePath = urlPath;
  if (urlPath.startsWith('/view-data')) {
    relativePath = urlPath.replace('/view-data', '');
  }

  const filePath = path.join(BASE_DIR, relativePath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const stat = fs.statSync(filePath);

  if (stat.isDirectory()) {
    // Check for index.html
    const indexPath = path.join(filePath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(indexPath));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(generateIndex(filePath, urlPath));
    }
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`View data server running on http://0.0.0.0:${PORT}`);
  console.log(`Serving files from: ${BASE_DIR}`);
});
