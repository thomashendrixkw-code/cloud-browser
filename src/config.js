import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

/**
 * Chargement d'un .env optionnel, sans dépendance : l'application démarre
 * telle quelle après un clone, et .env ne sert qu'à surcharger les défauts.
 * Les vraies variables d'environnement restent prioritaires.
 */
function loadEnvFile() {
  const file = path.join(rootDir, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = /^(['"]).*\1$/.test(rawValue) ? rawValue.slice(1, -1) : rawValue;
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(String(value));

/**
 * Identifiants d'accès : soit AUTH_USERS="alice:motdepasse,bob:autre",
 * soit le raccourci ACCESS_USER/ACCESS_PASSWORD pour un utilisateur unique.
 */
const parseUsers = (list, singleUser, singlePassword) => {
  const users = new Map();
  for (const entry of String(list ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(':');
    if (index < 1) continue;
    const name = trimmed.slice(0, index).trim();
    const password = trimmed.slice(index + 1);
    if (name && password) users.set(name, password);
  }
  if (singlePassword) users.set((singleUser || 'admin').trim(), singlePassword);
  return users;
};

const env = process.env;

/**
 * GitHub Codespaces se signale par ses propres variables. On s'en sert pour
 * adapter les défauts : conteneur (pas de sandbox Chromium), accès uniquement
 * par le tunnel HTTPS authentifié de GitHub, et un lien réellement cliquable
 * à afficher au démarrage.
 */
const codespaces = {
  enabled: bool(env.CODESPACES, false),
  name: env.CODESPACE_NAME || null,
  domain: env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev',
};

export const config = {
  server: {
    // 8787 plutôt que 8080 : ce dernier est le port proxy par excellence et se
    // retrouve souvent intercepté par un agent local (le WebSocket casse alors).
    port: num(env.PORT, 8787),
    // Boucle locale par défaut : sans identifiants, le serveur s'y limite de
    // toute façon (cf. resolveAccessPolicy).
    host: env.HOST || '127.0.0.1',
    publicDir: path.join(rootDir, 'public'),
    // À n'activer que derrière un reverse proxy de confiance : sinon un client
    // peut falsifier X-Forwarded-For et contourner les limitations de débit.
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL || 'info',
  },

  browser: {
    headless: bool(env.HEADLESS, true),
    // Sandbox activé par défaut, sauf en conteneur Codespace où il est indisponible.
    sandbox: bool(env.CHROMIUM_SANDBOX, !codespaces.enabled),
    executablePath: env.CHROMIUM_PATH || undefined,
    launchTimeoutMs: num(env.BROWSER_LAUNCH_TIMEOUT_MS, 60_000),
    // Rotation périodique du process Chromium pour éviter les fuites mémoire.
    restartIntervalMs: num(env.BROWSER_RESTART_HOURS, 8) * 60 * 60 * 1000,
    // Au-delà de ce délai, un Chromium en drainage est fermé même s'il reste des sessions.
    drainGraceMs: num(env.BROWSER_DRAIN_GRACE_MINUTES, 30) * 60 * 1000,
    args: [
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      // Un onglet headless ne doit jamais être ralenti parce qu'il est « en fond ».
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Qualité d'image : couleurs justes, et anticrénelage en niveaux de gris
      // plutôt qu'en sous-pixels — plus net une fois compressé en JPEG, et sans
      // franges colorées sur le texte.
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--font-render-hinting=none',
    ],
  },

  session: {
    max: num(env.MAX_SESSIONS, 3),
    // 0 = pas de quota individuel (seul MAX_SESSIONS s'applique).
    maxPerUser: num(env.MAX_SESSIONS_PER_USER, 0),
    idleTimeoutMs: num(env.SESSION_IDLE_MINUTES, 10) * 60 * 1000,
    sweepIntervalMs: num(env.SESSION_SWEEP_MS, 30_000),
    viewport: {
      width: num(env.VIEWPORT_WIDTH, 1280),
      height: num(env.VIEWPORT_HEIGHT, 720),
    },
    maxViewport: { width: 1920, height: 1200 },
    minViewport: { width: 400, height: 300 },
    deviceScaleFactor: num(env.DEVICE_SCALE_FACTOR, 1),
    maxDeviceScaleFactor: num(env.MAX_DEVICE_SCALE_FACTOR, 2),
    locale: env.LOCALE || 'fr-FR',
    timezoneId: env.TIMEZONE || 'Europe/Paris',
    userAgent:
      env.USER_AGENT ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    // Vide = page d'accueil intégrée ; une URL http(s) la remplace.
    homeUrl: env.HOME_URL || '',
    searchEngine: env.SEARCH_ENGINE || 'duckduckgo',
  },

  stream: {
    // 'screencast' (CDP Page.startScreencast) ou 'poll' (page.screenshot périodique)
    defaultMode: env.STREAM_MODE === 'poll' ? 'poll' : 'screencast',
    // Derrière le tunnel Codespaces, la qualité utile est celle que le lien
    // absorbe sans gonfler la latence : on part haut et on laisse le régulateur
    // redescendre si le trajet sature.
    jpegQuality: Math.min(100, Math.max(1, num(env.JPEG_QUALITY, codespaces.enabled ? 78 : 60))),
    adaptive: bool(env.ADAPTIVE_QUALITY, true),
    minQuality: Math.min(100, Math.max(10, num(env.MIN_JPEG_QUALITY, 35))),
    maxQuality: Math.min(100, Math.max(10, num(env.MAX_JPEG_QUALITY, 88))),
    // Budget de latence : au-delà, le régulateur baisse la qualité.
    targetLatencyMs: num(env.TARGET_LATENCY_MS, 180),
    pollIntervalMs: Math.max(100, num(env.POLL_INTERVAL_MS, 250)),
    maxBufferedBytes: num(env.MAX_WS_BUFFERED_BYTES, 1024 * 1024),
  },

  timeouts: {
    goto: num(env.GOTO_TIMEOUT_MS, 15_000),
    action: num(env.ACTION_TIMEOUT_MS, 10_000),
    screenshot: num(env.SCREENSHOT_TIMEOUT_MS, 8_000),
    close: num(env.CLOSE_TIMEOUT_MS, 5_000),
  },

  codespaces: {
    ...codespaces,
    /** URL publique du port transmis par GitHub, si l'on est dans un Codespace. */
    forwardedUrl(port) {
      return codespaces.enabled && codespaces.name ? `https://${codespaces.name}-${port}.${codespaces.domain}` : null;
    },
  },

  auth: {
    // Active dès que des identifiants existent. Sans identifiants, le service
    // reste utilisable mais confiné à la machine locale.
    enabled: bool(env.AUTH_ENABLED, true),
    // Seul moyen d'exposer volontairement un service sans authentification.
    allowUnauthenticatedExposure: bool(env.ALLOW_UNAUTHENTICATED_EXPOSURE, false),
    users: parseUsers(env.AUTH_USERS, env.ACCESS_USER, env.ACCESS_PASSWORD),
    // Sans secret fixe, un redémarrage invalide les sessions ouvertes.
    secret: env.AUTH_SECRET || null,
    cookieName: env.AUTH_COOKIE_NAME || 'cb_auth',
    sessionTtlMs: num(env.AUTH_SESSION_HOURS, 12) * 60 * 60 * 1000,
    // À activer dès que le service est servi en HTTPS (reverse proxy TLS).
    secureCookie: bool(env.AUTH_SECURE_COOKIE, false),
    loginRate: {
      points: num(env.AUTH_RATE_POINTS, 10),
      windowMs: num(env.AUTH_RATE_WINDOW_MS, 15 * 60 * 1000),
    },
  },

  security: {
    allowedProtocols: ['http:', 'https:'],
    blockPrivateHosts: bool(env.BLOCK_PRIVATE_HOSTS, true),
    dnsTimeoutMs: num(env.DNS_TIMEOUT_MS, 3_000),
  },

  rateLimit: {
    navigate: {
      points: num(env.NAVIGATE_RATE_POINTS, 20),
      windowMs: num(env.NAVIGATE_RATE_WINDOW_MS, 60_000),
    },
    session: {
      points: num(env.SESSION_RATE_POINTS, 10),
      windowMs: num(env.SESSION_RATE_WINDOW_MS, 60_000),
    },
  },
};

export default config;
