import { chromium } from 'playwright';
import config from '../config.js';
import { createLogger } from '../logger.js';
import { withTimeout, safeTimeout } from '../util/withTimeout.js';

const log = createLogger('browser');

let instanceSeq = 0;

/**
 * Gère UNE instance Chromium partagée par toutes les sessions.
 *
 * Chaque session prend un « bail » (lease) sur l'instance courante. Lors de la
 * rotation périodique (anti fuite mémoire), l'instance courante passe en mode
 * drainage : les sessions déjà ouvertes continuent de l'utiliser, les nouvelles
 * sessions obtiennent une instance neuve. L'ancienne est fermée dès que son
 * dernier bail est libéré (ou au bout du délai de grâce).
 */
export class BrowserManager {
  #current = null;
  #draining = new Set();
  #launching = null;
  #rotationTimer = null;
  #closed = false;

  async start() {
    await this.#ensureCurrent();
    if (config.browser.restartIntervalMs > 0) {
      this.#rotationTimer = setInterval(
        () => this.rotate('rotation périodique').catch((err) => log.error('Rotation échouée:', err)),
        config.browser.restartIntervalMs,
      );
      if (typeof this.#rotationTimer.unref === 'function') this.#rotationTimer.unref();
    }
    return this;
  }

  async #launch() {
    const args = [...config.browser.args];
    if (!config.browser.sandbox) {
      log.warn(
        config.codespaces.enabled
          ? 'Sandbox Chromium désactivé : indisponible dans un conteneur Codespace.'
          : 'Sandbox Chromium DÉSACTIVÉ (CHROMIUM_SANDBOX=false).',
      );
      args.push('--no-sandbox', '--disable-setuid-sandbox');
    }
    const browser = await withTimeout(
      chromium.launch({
        headless: config.browser.headless,
        chromiumSandbox: config.browser.sandbox,
        executablePath: config.browser.executablePath,
        args,
      }),
      config.browser.launchTimeoutMs,
      'chromium.launch',
    );

    const instance = {
      id: ++instanceSeq,
      browser,
      createdAt: Date.now(),
      leases: new Set(),
      draining: false,
      closing: false,
    };

    browser.on('disconnected', () => {
      log.warn(`Chromium #${instance.id} déconnecté.`);
      if (this.#current === instance) this.#current = null;
      this.#draining.delete(instance);
    });

    log.info(`Chromium #${instance.id} démarré (sandbox=${config.browser.sandbox}, headless=${config.browser.headless}).`);
    return instance;
  }

  async #ensureCurrent() {
    if (this.#closed) throw new Error('BrowserManager arrêté.');
    if (this.#current?.browser?.isConnected()) return this.#current;
    if (!this.#launching) {
      this.#launching = this.#launch()
        .then((instance) => {
          this.#current = instance;
          return instance;
        })
        .finally(() => {
          this.#launching = null;
        });
    }
    return this.#launching;
  }

  /**
   * Crée un BrowserContext isolé (cookies/storage propres à l'utilisateur) sur
   * l'instance Chromium courante et renvoie le contexte + la libération du bail.
   */
  async acquireContext(contextOptions = {}) {
    const instance = await this.#ensureCurrent();
    const context = await withTimeout(
      instance.browser.newContext(contextOptions),
      config.timeouts.action,
      'browser.newContext',
    );

    const lease = { instanceId: instance.id, released: false };
    instance.leases.add(lease);

    const release = async () => {
      if (lease.released) return;
      lease.released = true;
      instance.leases.delete(lease);
      await safeTimeout(context.close(), config.timeouts.close, 'context.close');
      if (instance.draining && instance.leases.size === 0) await this.#closeInstance(instance);
    };

    return { context, release, instanceId: instance.id };
  }

  /** Bascule sur une nouvelle instance sans couper les sessions en cours. */
  async rotate(reason = 'manuelle') {
    const old = this.#current;
    if (!old) return this.#ensureCurrent();

    log.info(`Rotation Chromium #${old.id} (${reason}) — ${old.leases.size} session(s) à drainer.`);
    old.draining = true;
    this.#current = null;
    this.#draining.add(old);

    try {
      await this.#ensureCurrent();
    } catch (err) {
      // Si la nouvelle instance ne démarre pas, on garde l'ancienne active.
      log.error('Nouvelle instance indisponible, on conserve l’ancienne:', err);
      old.draining = false;
      this.#draining.delete(old);
      this.#current = old;
      throw err;
    }

    if (old.leases.size === 0) {
      await this.#closeInstance(old);
    } else {
      const timer = setTimeout(() => {
        log.warn(`Délai de grâce dépassé pour Chromium #${old.id}, fermeture forcée.`);
        this.#closeInstance(old).catch(() => {});
      }, config.browser.drainGraceMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return this.#current;
  }

  async #closeInstance(instance) {
    if (instance.closing) return;
    instance.closing = true;
    this.#draining.delete(instance);
    if (this.#current === instance) this.#current = null;
    await safeTimeout(instance.browser.close(), config.timeouts.close, 'browser.close');
    log.info(`Chromium #${instance.id} fermé.`);
  }

  stats() {
    return {
      currentInstanceId: this.#current?.id ?? null,
      currentUptimeMs: this.#current ? Date.now() - this.#current.createdAt : 0,
      currentLeases: this.#current?.leases.size ?? 0,
      drainingInstances: [...this.#draining].map((i) => ({ id: i.id, leases: i.leases.size })),
      connected: Boolean(this.#current?.browser?.isConnected()),
    };
  }

  async shutdown() {
    this.#closed = true;
    clearInterval(this.#rotationTimer);
    const instances = [...this.#draining];
    if (this.#current) instances.push(this.#current);
    this.#current = null;
    this.#draining.clear();
    await Promise.all(instances.map((i) => safeTimeout(i.browser.close(), config.timeouts.close, 'browser.close')));
  }
}

export default BrowserManager;
