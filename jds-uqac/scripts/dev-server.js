// Serveur local pour tester sans Vercel : npm run dev  ->  http://localhost:3000
// (stockage en mémoire si les variables Upstash ne sont pas définies ; mot de passe admin : "admin")
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/rpc.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const port = Number(process.env.PORT) || 3000;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/rpc') return handler(req, res);
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!extname(path)) path += '.html'; // comme cleanUrls sur Vercel
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(data);
    } catch {
      res.writeHead(404).end('404');
    }
  })
  .listen(port, () => console.log(`JDS UQAC en local : http://localhost:${port}  (admin : http://localhost:${port}/admin)`));
