import http from 'node:http';
import path from 'node:path';
import express from 'express';
import config from './config.js';
import { createLogger } from './logger.js';
import BrowserManager from './browser/browserManager.js';
import SessionPool from './browser/sessionPool.js';
import { createApiRouter, errorHandler } from './http/routes.js';
import { authenticateRequest, createAuthRouter, resolveAccessPolicy } from './http/auth.js';
import { createWsServer } from './ws/wsServer.js';

const log = createLogger('server');

async function main() {
  // Détermine l'adresse d'écoute : sans identifiants, on reste en local.
  const access = resolveAccessPolicy();

  const browserManager = await new BrowserManager().start();
  const pool = new SessionPool(browserManager).start();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.server.trustProxy);
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    next();
  });

  app.use('/api/auth', createAuthRouter());
  app.use('/api', createApiRouter({ pool, browserManager }));

  // L'interface n'est servie qu'à une identité valide ; sinon, page de connexion.
  // Le shell HTML est explicitement non mis en cache : une copie en cache
  // court-circuiterait cette garde après une expiration de session.
  app.get(['/', '/index.html'], (req, res) => {
    if (!authenticateRequest(req)) return res.redirect(302, '/login.html');
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(config.server.publicDir, 'index.html'));
  });
  // Les assets restent revalidés (ETag) plutôt que mis en cache aveuglément.
  app.use(express.static(config.server.publicDir, { index: false, maxAge: 0, etag: true }));
  app.use((req, res) => res.status(404).json({ error: 'not_found', message: 'Ressource introuvable.' }));
  app.use(errorHandler);

  const server = http.createServer(app);
  createWsServer({ server, pool });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.server.port, access.host, resolve);
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      log.error(
        `Le port ${config.server.port} est déjà utilisé.\n` +
          `  Lancez sur un autre port : PORT=${config.server.port + 1} npm start`,
      );
      // Chromium est déjà lancé à ce stade : ne pas le laisser orphelin.
      await browserManager.shutdown().catch(() => {});
      process.exit(1);
    }
    await browserManager.shutdown().catch(() => {});
    throw err;
  }
  log.info(`Cloud browser prêt sur http://${access.host === '0.0.0.0' ? 'localhost' : access.host}:${config.server.port}`);
  const forwarded = config.codespaces.forwardedUrl(config.server.port);
  if (forwarded) {
    log.info(`Codespace détecté — accès via ${forwarded}`);
    log.info('Le port est transmis par le tunnel privé de GitHub : seul votre compte y accède.');
  }
  log.info(
    `Auth=${access.authEnabled ? 'activée' : 'désactivée (accès local)'} · ` +
      `Sessions max=${config.session.max} · inactivité=${config.session.idleTimeoutMs / 60000} min · ` +
      `mode=${config.stream.defaultMode} · rotation Chromium=${config.browser.restartIntervalMs / 3600000} h`,
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Signal ${signal} reçu, arrêt en cours…`);
    const force = setTimeout(() => {
      log.error('Arrêt propre trop long, sortie forcée.');
      process.exit(1);
    }, 15_000);
    force.unref();

    server.close();
    await pool.shutdown().catch((err) => log.error('Fermeture des sessions:', err));
    await browserManager.shutdown().catch((err) => log.error('Fermeture de Chromium:', err));
    clearTimeout(force);
    log.info('Arrêt terminé.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error('Promesse rejetée non gérée:', reason));
  process.on('uncaughtException', (err) => {
    log.error('Exception non capturée:', err);
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  log.error('Démarrage impossible:', err);
  process.exit(1);
});
