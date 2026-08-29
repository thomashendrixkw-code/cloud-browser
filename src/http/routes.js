import express from 'express';
import config from '../config.js';
import { createLogger } from '../logger.js';
import { createRateLimiter, rateLimitMiddleware } from '../util/rateLimit.js';
import { InvalidUrlError } from '../util/url.js';
import { SessionLimitError, UserSessionLimitError } from '../browser/sessionPool.js';
import { NavigationError, SessionClosedError } from '../browser/session.js';
import { TimeoutError } from '../util/withTimeout.js';
import { publicEngines } from '../browser/searchEngines.js';
import { authenticateRequest, requireAuth } from './auth.js';

const log = createLogger('http');

export function createApiRouter({ pool, browserManager }) {
  const router = express.Router();

  const sessionLimiter = createRateLimiter({ ...config.rateLimit.session, name: 'session' });
  const navigateLimiter = createRateLimiter({ ...config.rateLimit.navigate, name: 'navigate' });
  // Le mode « polling HTTP » interroge cet endpoint plusieurs fois par seconde :
  // la limite doit rester au-dessus de la cadence nominale.
  const screenshotLimiter = createRateLimiter({
    points: Math.ceil((60_000 / config.stream.pollIntervalMs) * 1.5),
    windowMs: 60_000,
    name: 'screenshot',
  });

  // Toutes les routes de session exigent une identité authentifiée.
  router.use('/session', requireAuth);

  const requireSession = (req, res, next) => {
    const session = pool.get(req.params.id);
    // Une session appartenant à quelqu'un d'autre est traitée comme inexistante :
    // aucun moyen d'énumérer les sessions des autres utilisateurs.
    if (!session || session.owner !== req.user) {
      return res.status(404).json({ error: 'session_not_found', message: 'Session inconnue ou expirée.' });
    }
    req.session = session;
    session.touch();
    next();
  };

  // --- Cycle de vie des sessions -------------------------------------------

  router.post('/session', rateLimitMiddleware(sessionLimiter), async (req, res, next) => {
    try {
      const session = await pool.create(req.user, {
        deviceScaleFactor: req.body?.deviceScaleFactor,
        searchEngine: req.body?.searchEngine,
      });
      res.status(201).json({
        sessionId: session.id,
        viewport: session.viewport,
        mode: session.mode,
        stream: session.streamOptions,
        preferences: session.preferences,
        limits: { maxSessions: config.session.max, idleTimeoutMs: config.session.idleTimeoutMs },
        pollIntervalMs: config.stream.pollIntervalMs,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/session/:id', requireSession, async (req, res, next) => {
    try {
      res.json({ sessionId: req.session.id, ...(await req.session.state()) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/session/:id', requireSession, async (req, res, next) => {
    try {
      await pool.destroy(req.params.id, 'fermeture demandée par le client');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // --- Navigation ------------------------------------------------------------

  router.post('/session/:id/navigate', rateLimitMiddleware(navigateLimiter), requireSession, async (req, res, next) => {
    try {
      const state = await req.session.navigate(req.body?.url);
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.post('/session/:id/back', requireSession, async (req, res, next) => {
    try {
      await req.session.goBack();
      res.json(await req.session.state());
    } catch (err) {
      next(err);
    }
  });

  router.post('/session/:id/forward', requireSession, async (req, res, next) => {
    try {
      await req.session.goForward();
      res.json(await req.session.state());
    } catch (err) {
      next(err);
    }
  });

  router.post('/session/:id/home', requireSession, async (req, res, next) => {
    try {
      res.json(await req.session.showHome());
    } catch (err) {
      next(err);
    }
  });

  router.post('/session/:id/reload', requireSession, async (req, res, next) => {
    try {
      await req.session.reload();
      res.json(await req.session.state());
    } catch (err) {
      next(err);
    }
  });

  // --- Streaming : approche (a), capture JPEG à la demande / en polling ------

  router.get('/session/:id/screenshot', rateLimitMiddleware(screenshotLimiter), requireSession, async (req, res, next) => {
    try {
      const buffer = await req.session.screenshot();
      res.set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Length': String(buffer.length),
      });
      res.end(buffer);
    } catch (err) {
      next(err);
    }
  });

  router.post('/session/:id/mode', requireSession, async (req, res, next) => {
    try {
      const mode = await req.session.setMode(req.body?.mode);
      res.json({ mode });
    } catch (err) {
      next(err);
    }
  });

  /** Catalogue des moteurs, nécessaire à l'accueil de l'application et à l'introduction. */
  router.get('/engines', (req, res) => res.json({ engines: publicEngines(), default: config.session.searchEngine }));

  // --- Supervision -----------------------------------------------------------

  router.get('/health', (req, res) => {
    // Sonde publique volontairement muette : le détail (sessions, RAM, instances)
    // n'est servi qu'à un utilisateur authentifié.
    if (!authenticateRequest(req)) {
      return res.json({ status: 'ok', uptimeSec: Math.round(process.uptime()) });
    }
    res.json({
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      memory: {
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      browser: browserManager.stats(),
      sessions: pool.stats(),
      stream: { defaultMode: config.stream.defaultMode, jpegQuality: config.stream.jpegQuality },
    });
  });

  return router;
}

/** Traduction des erreurs applicatives en codes HTTP. */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof InvalidUrlError) {
    return res.status(400).json({ error: 'invalid_url', message: err.message });
  }
  if (err instanceof UserSessionLimitError) {
    return res.status(429).json({ error: 'user_session_limit', message: err.message, maxPerUser: err.max });
  }
  if (err instanceof SessionLimitError) {
    return res.status(503).json({ error: 'session_limit', message: err.message, maxSessions: err.max });
  }
  if (err instanceof SessionClosedError) {
    return res.status(410).json({ error: 'session_closed', message: err.message });
  }
  if (err instanceof NavigationError) {
    return res.status(502).json({ error: 'navigation_failed', message: err.message });
  }
  if (err instanceof TimeoutError) {
    return res.status(504).json({ error: 'timeout', message: err.message });
  }

  log.error('Erreur non gérée:', err);
  return res.status(500).json({ error: 'internal_error', message: 'Erreur interne du serveur.' });
}

export default createApiRouter;
