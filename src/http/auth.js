import crypto from 'node:crypto';
import express from 'express';
import config from '../config.js';
import { createLogger } from '../logger.js';
import { createRateLimiter, rateLimitMiddleware } from '../util/rateLimit.js';
import { parseCookies, secretsMatch, signToken, verifyToken } from '../auth/token.js';

const log = createLogger('auth');

// Identité attribuée quand l'authentification est désactivée (usage local).
export const ANONYMOUS_USER = 'anonyme';

// Clé de signature effective, fixée au démarrage par resolveAccessPolicy().
let secret = null;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

const isLoopback = (host) => LOOPBACK.has(String(host)) || /^127\./.test(String(host));

/**
 * Détermine comment le service est joignable, et renvoie l'adresse d'écoute
 * effective.
 *
 * Le principe : un navigateur distant sans authentification est un proxy
 * ouvert. Plutôt que de refuser de démarrer — ce qui casserait le « cloner et
 * lancer » — le serveur se replie sur la boucle locale tant qu'aucun
 * identifiant n'est configuré. Impossible, donc, d'exposer un proxy ouvert par
 * inadvertance.
 */
export function resolveAccessPolicy() {
  const hasCredentials = config.auth.users.size > 0;
  config.auth.enabled = config.auth.enabled && hasCredentials;

  if (config.auth.enabled) {
    secret = config.auth.secret;
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      log.warn('AUTH_SECRET absent : secret aléatoire généré, les sessions seront invalidées au redémarrage.');
    }
    log.info(`Accès protégé — ${config.auth.users.size} compte(s), session de ${config.auth.sessionTtlMs / 3600000} h.`);
    return { host: config.server.host, authEnabled: true };
  }

  const requestedHost = config.server.host;
  if (isLoopback(requestedHost)) {
    log.info('Aucun identifiant : accès sans authentification, limité à cette machine.');
    return { host: requestedHost, authEnabled: false };
  }

  if (config.auth.allowUnauthenticatedExposure) {
    log.warn(
      `PROXY OUVERT : écoute sur ${requestedHost} sans authentification ` +
        '(ALLOW_UNAUTHENTICATED_EXPOSURE=true). Tout le trafic sortant sera imputé à cette machine.',
    );
    return { host: requestedHost, authEnabled: false };
  }

  log.warn(
    `HOST=${requestedHost} demandé sans identifiants : écoute repliée sur 127.0.0.1.\n` +
      '  Pour ouvrir l’accès à d’autres machines, définissez ACCESS_PASSWORD (ou AUTH_USERS) dans .env.',
  );
  return { host: '127.0.0.1', authEnabled: false };
}

/** Renvoie l'identité portée par la requête (HTTP ou upgrade WebSocket), sinon null. */
export function authenticateRequest(request) {
  if (!config.auth.enabled) return ANONYMOUS_USER;
  if (!secret) return null;
  const token = parseCookies(request.headers?.cookie).get(config.auth.cookieName);
  const payload = verifyToken(token, secret);
  if (!payload?.user || !config.auth.users.has(payload.user)) return null;
  return payload.user;
}

export function requireAuth(req, res, next) {
  const user = authenticateRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'unauthorized', message: 'Authentification requise.' });
  }
  req.user = user;
  next();
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.auth.secureCookie,
    path: '/',
    maxAge: config.auth.sessionTtlMs,
  };
}

export function createAuthRouter() {
  const router = express.Router();
  const loginLimiter = createRateLimiter({ ...config.auth.loginRate, name: 'login' });

  router.post('/login', rateLimitMiddleware(loginLimiter), (req, res) => {
    if (!config.auth.enabled) return res.json({ authenticated: true, user: ANONYMOUS_USER, authEnabled: false });

    const user = String(req.body?.user || 'admin').trim();
    const password = String(req.body?.password ?? '');
    const expected = config.auth.users.get(user);

    // Un utilisateur inconnu passe quand même par une comparaison factice :
    // le temps de réponse ne doit pas révéler l'existence du compte.
    const ok = secretsMatch(password, expected ?? crypto.randomBytes(32).toString('hex')) && expected !== undefined;
    if (!ok) {
      log.warn(`Échec de connexion pour « ${user} » depuis ${req.ip}.`);
      return res.status(401).json({ error: 'invalid_credentials', message: 'Identifiants incorrects.' });
    }

    res.cookie(config.auth.cookieName, signToken({ user }, secret, config.auth.sessionTtlMs), cookieOptions());
    log.info(`Connexion de « ${user} » depuis ${req.ip}.`);
    res.json({ authenticated: true, user, authEnabled: true });
  });

  router.post('/logout', (req, res) => {
    res.clearCookie(config.auth.cookieName, { ...cookieOptions(), maxAge: undefined });
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    const user = authenticateRequest(req);
    res.json({ authenticated: Boolean(user), user: user ?? null, authEnabled: config.auth.enabled });
  });

  return router;
}

export default createAuthRouter;
