// Zero-dependency server. `npm start`, then:
//   http://localhost:8090  the game
//   http://localhost:8091  the hunter monitor (every hunter's camera + what it's deciding); a
//                          friend on your network can open http://<your-ip>:8091
// The game POSTs its state to /state ~10×/s; monitors receive it live on /stream (Server-Sent Events).
import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const root = import.meta.dirname;
const port = +process.env.PORT || 8090;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.md': 'text/markdown' };
const monitors = new Set();
let latest = null;

function handler(home) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/state' && req.method === 'POST') { // from the game
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4e6) req.destroy(); });
      req.on('end', () => { latest = body; for (const m of monitors) m.write(`data: ${body}\n\n`); res.writeHead(204).end(); });
      return;
    }
    if (url.pathname === '/stream') { // to the monitors
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      if (latest) res.write(`data: ${latest}\n\n`);
      monitors.add(res);
      req.on('close', () => monitors.delete(res));
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '');
    const file = join(root, rel || home);
    if (file !== root && !file.startsWith(root + sep)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  };
}

const lan = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
http.createServer(handler('index.html')).listen(port, () => console.log(`Exfil game     http://localhost:${port}`));
http.createServer(handler('spectator.html')).listen(port + 1, () => {
  console.log(`Hunter monitor http://localhost:${port + 1}`);
  for (const ip of lan) console.log(`  for a friend on your network: http://${ip}:${port + 1}`);
});
