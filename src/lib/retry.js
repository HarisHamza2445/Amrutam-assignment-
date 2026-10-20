const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// exponential backoff with "full jitter": wait a random time in [0, base * 2^attempt], capped
function backoffDelay(attempt, { baseDelayMs = 100, maxDelayMs = 30000, random = Math.random } = {}) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

async function withRetry(fn, { retries = 3, baseDelayMs = 100, maxDelayMs = 5000, shouldRetry = () => true } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      await sleep(backoffDelay(attempt, { baseDelayMs, maxDelayMs }));
      attempt += 1;
    }
  }
}

module.exports = { withRetry, backoffDelay, sleep };
