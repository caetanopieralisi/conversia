// Retry com backoff exponencial e jitter.
// Jitter importa: sem ele, N conversas que falham no mesmo segundo tentam de novo
// no mesmo segundo, e o pico que derrubou a API acontece de novo.

class TimeoutError extends Error {
  constructor(message) { super(message); this.name = 'TimeoutError'; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { attempts = 3, baseDelayMs = 500, maxDelayMs = 8000, shouldRetry = () => true } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i === attempts - 1 || !shouldRetry(e)) throw e;
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** i);
      await sleep(exp / 2 + Math.random() * (exp / 2)); // jitter total entre 50% e 100%
    }
  }
  throw lastError;
}

module.exports = { withRetry, sleep, TimeoutError };
