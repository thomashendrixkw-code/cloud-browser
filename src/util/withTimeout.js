export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`Timeout (${ms} ms) sur : ${label}`);
    this.name = 'TimeoutError';
    this.label = label;
    this.timeoutMs = ms;
  }
}

/**
 * Enveloppe toute promesse Playwright dans un timeout dur : aucune action ne doit
 * pouvoir bloquer indéfiniment une session (et donc le serveur).
 */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}

/** Variante « best effort » : ne rejette jamais, utile pour les fermetures/nettoyages. */
export async function safeTimeout(promise, ms, label = 'operation') {
  try {
    return await withTimeout(promise, ms, label);
  } catch {
    return undefined;
  }
}

export default withTimeout;
