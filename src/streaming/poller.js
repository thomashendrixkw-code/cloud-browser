import config from '../config.js';
import { createLogger } from '../logger.js';
import { withTimeout } from '../util/withTimeout.js';

const log = createLogger('poller');

/**
 * Approche « simple » : page.screenshot() JPEG à intervalle régulier.
 * Plus robuste (aucune dépendance au CDP) mais plus coûteuse en CPU et plus
 * latente. Une capture ne se lance jamais tant que la précédente n'est pas finie.
 */
export class PollingStreamer {
  static mode = 'poll';

  #page;
  #onFrame;
  #canSend;
  #timer = null;
  #busy = false;
  #running = false;
  #frames = 0;
  #dropped = 0;
  #errors = 0;

  constructor({
    page,
    onFrame,
    canSend = () => true,
    intervalMs = config.stream.pollIntervalMs,
    quality = config.stream.jpegQuality,
  }) {
    this.#page = page;
    this.#onFrame = onFrame;
    this.#canSend = canSend;
    this.intervalMs = intervalMs;
    this.quality = quality;
  }

  get mode() {
    return PollingStreamer.mode;
  }

  async start() {
    if (this.#running) return;
    this.#running = true;
    this.#timer = setInterval(() => this.#tick(), this.intervalMs);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
    await this.#tick();
    log.debug(`Polling démarré (${this.intervalMs} ms).`);
  }

  async #tick() {
    if (!this.#running || this.#busy) return;
    if (!this.#canSend()) {
      this.#dropped += 1;
      return;
    }
    this.#busy = true;
    try {
      const buffer = await withTimeout(
        this.#page.screenshot({ type: 'jpeg', quality: this.quality, timeout: config.timeouts.screenshot }),
        config.timeouts.screenshot + 1_000,
        'page.screenshot',
      );
      if (!this.#running) return;
      this.#frames += 1;
      this.#onFrame(buffer, null);
    } catch (err) {
      this.#errors += 1;
      // Une page en cours de navigation refuse la capture : on réessaiera au tick suivant.
      log.debug('Capture ignorée:', err.message);
    } finally {
      this.#busy = false;
    }
  }

  setQuality(quality) {
    this.quality = quality;
  }

  setInterval(intervalMs) {
    if (intervalMs === this.intervalMs) return;
    this.intervalMs = intervalMs;
    if (!this.#running) return;
    clearInterval(this.#timer);
    this.#timer = setInterval(() => this.#tick(), this.intervalMs);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  async stop() {
    this.#running = false;
    clearInterval(this.#timer);
    this.#timer = null;
    log.debug(`Polling arrêté (${this.#frames} frames, ${this.#errors} erreurs).`);
  }

  stats() {
    return { mode: this.mode, frames: this.#frames, dropped: this.#dropped, errors: this.#errors };
  }
}

export default PollingStreamer;
