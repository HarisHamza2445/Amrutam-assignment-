const { withRetry, backoffDelay } = require('../../src/lib/retry');

describe('backoffDelay', () => {
  it('grows exponentially and respects the cap', () => {
    const max = () => 0.999999;
    expect(backoffDelay(0, { baseDelayMs: 100, random: max })).toBe(99);
    expect(backoffDelay(3, { baseDelayMs: 100, random: max })).toBe(799);
    expect(backoffDelay(20, { baseDelayMs: 100, maxDelayMs: 5000, random: max })).toBe(4999);
  });

  it('is jittered between 0 and the ceiling', () => {
    expect(backoffDelay(5, { random: () => 0 })).toBe(0);
  });
});

describe('withRetry', () => {
  it('retries until it succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { retries: 5, baseDelayMs: 1 }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the retry budget', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('down');
        },
        { retries: 2, baseDelayMs: 1 }
      )
    ).rejects.toThrow('down');
    expect(calls).toBe(3);
  });

  it('does not retry errors that are not retryable', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('bad input'), { retryable: false });
        },
        { retries: 5, baseDelayMs: 1, shouldRetry: (e) => e.retryable }
      )
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
