// Sends a signed webhook like the payment provider would.
//   node scripts/fake-webhook.js <orderId> [payment.succeeded|payment.failed]
const crypto = require('crypto');
const config = require('../src/config');
const { createMockPaymentProvider } = require('../src/modules/payments/mockProvider');

const [orderId, type = 'payment.succeeded'] = process.argv.slice(2);
if (!orderId) {
  console.error('usage: node scripts/fake-webhook.js <orderId> [payment.succeeded|payment.failed]');
  process.exit(1);
}

const provider = createMockPaymentProvider({ webhookSecret: config.PAYMENT_WEBHOOK_SECRET });
const event = { id: `evt_${crypto.randomUUID()}`, type, data: { orderId, paymentId: `pay_${crypto.randomBytes(6).toString('hex')}` } };
const { body, signature } = provider.signWebhook(event);
const url = `${process.env.API_URL || `http://localhost:${config.PORT}`}/api/v1/payments/webhook`;

fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mockpay-signature': signature }, body })
  .then(async (res) => console.log(res.status, await res.text()))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
