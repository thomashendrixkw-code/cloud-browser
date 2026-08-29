import { WebSocketServer } from 'ws';
import config from '../config.js';
import { createLogger } from '../logger.js';
import { createRateLimiter } from '../util/rateLimit.js';
import { InvalidUrlError } from '../util/url.js';
import { authenticateRequest } from '../http/auth.js';

const log = createLogger('ws');

const HEARTBEAT_MS = 30_000;
// Au-delà, on jette les événements « non critiques » (déplacements souris, molette)
// plutôt que d'accumuler du retard sur la page réelle.
const MAX_PENDING_INPUTS = 32;
const LOW_PRIORITY = new Set(['mouse:move', 'wheel']);
const INPUT_TYPES = new Set(['mouse', 'wheel', 'key', 'text']);

/**
 * Transport temps réel : frames JPEG en binaire (serveur -> client),
 * événements d'interaction en JSON (client -> serveur).
 */
export function createWsServer({ server, pool }) {
  const wss = new WebSocketServer({ noServer: true });
  const socketsBySession = new Map();
  const navigateLimiter = createRateLimiter({ ...config.rateLimit.navigate, name: 'ws-navigate' });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // L'upgrade porte le même cookie que les requêtes HTTP : on refuse avant
    // même d'établir le WebSocket si l'identité n'est pas valide.
    const user = authenticateRequest(request);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // L'algorithme de Nagle regroupe les petits paquets : sur un clic ou une
    // frappe, cela ajoute jusqu'à 40 ms avant même de quitter la machine.
    socket.setNoDelay(true);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, url, user);
    });
  });

  wss.on('connection', (ws, request, url, user) => {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const session = pool.get(sessionId);

    if (!session) {
      send(ws, { type: 'error', code: 'session_not_found', message: 'Session inconnue ou expirée.' });
      ws.close(4004, 'session_not_found');
      return;
    }
    if (session.owner !== user) {
      log.warn(`Refus : « ${user} » a tenté de reprendre la session ${sessionId} de « ${session.owner} ».`);
      send(ws, { type: 'error', code: 'forbidden', message: 'Cette session appartient à un autre utilisateur.' });
      ws.close(4003, 'forbidden');
      return;
    }

    // Une seule connexion active par session : la précédente est remplacée.
    const previous = socketsBySession.get(sessionId);
    if (previous && previous !== ws && previous.readyState === previous.OPEN) {
      send(previous, { type: 'error', code: 'replaced', message: 'Session reprise depuis un autre onglet.' });
      previous.close(4009, 'replaced');
    }
    socketsBySession.set(sessionId, ws);

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Deux files distinctes : les interactions ne doivent jamais attendre
    // derrière une navigation lente, qui peut durer plusieurs secondes.
    const lanes = {
      input: { chain: Promise.resolve(), pending: 0 },
      control: { chain: Promise.resolve(), pending: 0 },
    };
    // pushEnabled = false quand le client choisit le polling HTTP : le serveur
    // cesse alors de produire des frames (aucune capture inutile).
    const ctx = { pushEnabled: true };

    // Backpressure : si le socket accumule du retard, on saute les frames.
    session.setCanSend(
      () => ctx.pushEnabled && ws.readyState === ws.OPEN && ws.bufferedAmount < config.stream.maxBufferedBytes,
    );

    const onFrame = (buffer) => {
      if (!ctx.pushEnabled || ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount >= config.stream.maxBufferedBytes) return;
      ws.send(buffer, { binary: true });
    };
    const onState = (state) => send(ws, { type: 'state', ...state });
    const onNotice = (notice) => send(ws, { type: 'notice', ...notice });
    const onClosed = ({ reason }) => {
      send(ws, { type: 'closed', reason });
      ws.close(4001, 'session_closed');
    };

    session.on('frame', onFrame);
    session.on('state', onState);
    session.on('notice', onNotice);
    session.once('closed', onClosed);

    session.state().then((state) => {
      send(ws, {
        type: 'ready',
        sessionId,
        state,
        config: {
          maxSessions: config.session.max,
          idleTimeoutMs: config.session.idleTimeoutMs,
          pollIntervalMs: config.stream.pollIntervalMs,
          jpegQuality: config.stream.jpegQuality,
        },
      });
    });
    // Amorçage : une capture immédiate évite un écran noir avant la 1re frame.
    session.screenshot().then(onFrame).catch(() => {});

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', code: 'bad_message', message: 'Message JSON invalide.' });
        return;
      }
      if (!message || typeof message.type !== 'string') return;

      const kind = message.type === 'mouse' ? `mouse:${message.action}` : message.type;
      const lane = INPUT_TYPES.has(message.type) ? lanes.input : lanes.control;
      // Sous saturation, on sacrifie les événements non critiques plutôt que
      // d'accumuler du retard sur la page réelle.
      if (lane.pending >= MAX_PENDING_INPUTS && LOW_PRIORITY.has(kind)) return;

      lane.pending += 1;
      lane.chain = lane.chain
        .then(() => handleMessage({ ws, session, message, navigateLimiter, ctx }))
        .catch((err) => {
          send(ws, { type: 'error', code: err.name ?? 'error', message: err.message });
        })
        .finally(() => {
          lane.pending -= 1;
        });
    });

    const cleanup = () => {
      session.off('frame', onFrame);
      session.off('state', onState);
      session.off('notice', onNotice);
      session.off('closed', onClosed);
      session.setCanSend(() => false);
      if (socketsBySession.get(sessionId) === ws) socketsBySession.delete(sessionId);
      // La session survit à la déconnexion : le client peut se reconnecter,
      // le balayage d'inactivité s'occupera de la fermer si nécessaire.
    };

    ws.on('close', cleanup);
    ws.on('error', (err) => {
      log.warn(`Socket en erreur (session ${sessionId}):`, err.message);
      cleanup();
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}

async function handleMessage({ ws, session, message, navigateLimiter, ctx }) {
  switch (message.type) {
    case 'navigate': {
      const check = navigateLimiter.consume(session.id);
      if (!check.allowed) {
        send(ws, {
          type: 'error',
          code: 'rate_limited',
          message: `Trop de navigations. Réessayez dans ${Math.ceil(check.retryAfterMs / 1000)} s.`,
        });
        return;
      }
      try {
        await session.navigate(message.url);
      } catch (err) {
        const code = err instanceof InvalidUrlError ? 'invalid_url' : 'navigation_failed';
        send(ws, { type: 'error', code, message: err.message });
      }
      return;
    }
    case 'back':
      await session.goBack();
      return;
    case 'forward':
      await session.goForward();
      return;
    case 'reload':
      await session.reload();
      return;
    case 'home':
      await session.showHome();
      return;
    case 'stop':
      await session.stopLoading();
      return;

    case 'mouse': {
      const { action, x, y, button = 0, clickCount = 1 } = message;
      if (action === 'move') return session.mouseMove(x, y);
      if (action === 'down') return session.mouseDown(x, y, button, clickCount);
      if (action === 'up') return session.mouseUp(x, y, button, clickCount);
      if (action === 'click') return session.click(x, y, { button, clickCount });
      if (action === 'dblclick') return session.click(x, y, { button, clickCount: 2 });
      return;
    }
    case 'wheel':
      return session.wheel(message.x, message.y, message.deltaX, message.deltaY);
    case 'key':
      if (message.action === 'down') return session.keyDown(message.key);
      if (message.action === 'up') return session.keyUp(message.key);
      return;
    case 'text':
      return session.insertText(message.text);

    case 'mode': {
      const mode = await session.setMode(message.mode);
      send(ws, { type: 'notice', level: 'info', message: `Mode de streaming : ${mode === 'poll' ? 'polling' : 'screencast CDP'}.` });
      return;
    }
    case 'settings':
      await session.setStreamOptions(message);
      if (message.searchEngine !== undefined) await session.setPreferences({ searchEngine: message.searchEngine });
      return;
    case 'telemetry': {
      // Signal de bufferbloat : le trajet réel, mesuré par le client.
      const quality = session.applyTelemetry({
        rtt: message.rtt,
        backlog: message.backlog,
        bufferedBytes: ws.bufferedAmount,
      });
      if (quality !== null) send(ws, { type: 'quality', value: quality });
      return;
    }
    case 'viewport':
      await session.setViewport(message.width, message.height);
      return;
    case 'refresh': {
      // Capture unitaire à la demande (utile en mode polling ou après une pause).
      const buffer = await session.screenshot();
      if (ws.readyState === ws.OPEN) ws.send(buffer, { binary: true });
      return;
    }
    case 'stream': {
      // Active/désactive la poussée de frames (bascule vers le polling HTTP).
      ctx.pushEnabled = message.enabled !== false;
      if (ctx.pushEnabled) {
        const buffer = await session.screenshot().catch(() => null);
        if (buffer && ws.readyState === ws.OPEN) ws.send(buffer, { binary: true });
      }
      return;
    }
    case 'stats':
      send(ws, { type: 'stats', ...session.stats() });
      return;
    case 'ping':
      session.touch();
      send(ws, { type: 'pong', t: message.t ?? Date.now() });
      return;
    default:
      send(ws, { type: 'error', code: 'unknown_type', message: `Type de message inconnu : ${message.type}` });
  }
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

export default createWsServer;
