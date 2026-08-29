/**
 * Test de bout en bout, sans dépendance réseau.
 *
 * Un serveur statique local sert de site cible, ce qui rend le test hermétique :
 * aucun site externe à solliciter, aucun résultat qui dépende d'Internet.
 * BLOCK_PRIVATE_HOSTS=false est donc nécessaire ici — et uniquement ici —
 * puisque la protection anti-SSRF refuse par construction les adresses locales.
 *
 *   npm test
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Port libre attribué par le système, pour ne rien présumer de la machine. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const FIXTURE_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<title>Page de test</title></head><body style="font:16px sans-serif;padding:40px">
<h1 id="titre">Cloud Browser — page de test</h1><p>Contenu servi localement.</p></body></html>`;

async function main() {
  const appPort = await freePort();
  const fixturePort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;

  const fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  });
  await new Promise((r) => fixture.listen(fixturePort, '127.0.0.1', r));

  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      MAX_SESSIONS: '2',
      BLOCK_PRIVATE_HOSTS: 'false',
      AUTH_ENABLED: 'false',
      SESSION_IDLE_MINUTES: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(d.toString()));
  server.stderr.on('data', (d) => serverLog.push(d.toString()));

  const stop = async () => {
    server.kill('SIGTERM');
    await Promise.race([new Promise((r) => server.once('exit', r)), wait(8000)]);
    await new Promise((r) => fixture.close(r));
  };

  const json = async (p, options = {}) => {
    const response = await fetch(base + p, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };

  try {
    // Démarrage
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
      if (!ready) await wait(500);
    }
    check('le serveur démarre et répond', ready);
    if (!ready) throw new Error(`serveur injoignable\n${serverLog.join('')}`);

    // Catalogue et session
    const engines = await json('/api/engines');
    check('catalogue des moteurs', engines.status === 200 && engines.body.engines.length > 0, `${engines.body?.engines?.length} moteurs`);

    const created = await json('/api/session', { method: 'POST', body: { searchEngine: 'bing' } });
    const id = created.body?.sessionId;
    check('création de session', created.status === 201 && Boolean(id));
    check('préférence de moteur retenue', created.body?.preferences?.searchEngine === 'bing');

    // WebSocket : état initial, page d'accueil, frames
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/ws?sessionId=${id}`);
    let frames = 0;
    let firstFrameIsJpeg = null;
    const messages = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        frames += 1;
        if (firstFrameIsJpeg === null) firstFrameIsJpeg = data[0] === 0xff && data[1] === 0xd8;
        return;
      }
      messages.push(JSON.parse(data.toString()));
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await wait(2500);
    check('message « ready » reçu', messages.some((m) => m.type === 'ready'));
    check('page d’accueil affichée', (await json(`/api/session/${id}`)).body.title === 'Nouvel onglet');

    // Navigation vers le site local
    const navigated = await json(`/api/session/${id}/navigate`, {
      method: 'POST',
      body: { url: `http://127.0.0.1:${fixturePort}/` },
    });
    check('navigation vers la page de test', navigated.status === 200 && navigated.body.title === 'Page de test', navigated.body?.title);
    await wait(1500);
    check('frames JPEG reçues', frames > 0 && firstFrameIsJpeg === true, `${frames} frames`);

    // Capture unitaire
    const shot = await fetch(`${base}/api/session/${id}/screenshot`);
    const buffer = Buffer.from(await shot.arrayBuffer());
    check('capture JPEG par HTTP', shot.status === 200 && buffer[0] === 0xff && buffer[1] === 0xd8, `${buffer.length} octets`);

    // Interactions
    ws.send(JSON.stringify({ type: 'wheel', x: 0.5, y: 0.5, deltaY: 200 }));
    ws.send(JSON.stringify({ type: 'key', action: 'down', key: 'a' }));
    ws.send(JSON.stringify({ type: 'key', action: 'up', key: 'a' }));
    ws.send(JSON.stringify({ type: 'settings', jpegQuality: 40, adaptive: false }));
    await wait(1200);
    const tuned = await json(`/api/session/${id}`);
    check('réglages de flux appliqués', tuned.body.stream.jpegQuality === 40 && tuned.body.stream.adaptive === false);
    check('aucune erreur remontée par le socket', !messages.some((m) => m.type === 'error'));

    // Retour à l'accueil
    await json(`/api/session/${id}/home`, { method: 'POST' });
    check('retour à la page d’accueil', (await json(`/api/session/${id}`)).body.title === 'Nouvel onglet');

    // Validation d'URL
    const blocked = await json(`/api/session/${id}/navigate`, { method: 'POST', body: { url: 'file:///etc/passwd' } });
    check('protocole file:// refusé', blocked.status === 400 && blocked.body.error === 'invalid_url');

    // Limite de sessions (MAX_SESSIONS=2)
    const second = await json('/api/session', { method: 'POST' });
    const third = await json('/api/session', { method: 'POST' });
    check('limite de sessions respectée', second.status === 201 && third.status === 503, `2e=${second.status}, 3e=${third.status}`);
    if (second.body?.sessionId) await json(`/api/session/${second.body.sessionId}`, { method: 'DELETE' });

    // Cycle de vie
    ws.close();
    check('suppression de session', (await json(`/api/session/${id}`, { method: 'DELETE' })).status === 204);
    check('session introuvable après suppression', (await json(`/api/session/${id}`)).status === 404);
  } catch (error) {
    failed += 1;
    console.error('  ✗ exception :', error.message);
  } finally {
    await stop();
  }

  console.log(`\n${passed} réussite(s), ${failed} échec(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
