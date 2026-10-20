const { randomToken, hmacSha256 } = require('../../lib/crypto');

// Stand-in for Razorpay/Stripe. The real client would make HTTP calls; this one just pretends,
// with an optional failure rate so the retry path actually gets exercised in dev.
function createMockPaymentProvider({ webhookSecret, failureRate = 0 } = {}) {
  // eslint-disable-next-line no-unused-vars
  async function refund({ providerPaymentId, amount, idempotencyKey }) {
    if (Math.random() < failureRate) {
      const err = new Error('mockpay: temporarily unavailable');
      err.retryable = true;
      throw err;
    }
    return { refundId: `rfnd_${randomToken(10)}`, providerPaymentId, amount, status: 'processed' };
  }

  // used by tests and the demo script to produce a webhook exactly like the provider would
  function signWebhook(event) {
    const body = JSON.stringify(event);
    return { body, signature: hmacSha256(webhookSecret, body) };
  }

  return { name: 'mockpay', refund, signWebhook };
}

module.exports = { createMockPaymentProvider };
