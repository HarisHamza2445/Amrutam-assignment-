const { z } = require('zod');
const { AppError } = require('../../lib/errors');
const { hmacSha256, safeEqual } = require('../../lib/crypto');
const { withRetry } = require('../../lib/retry');
const { counters } = require('../../lib/metrics');

const eventSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['payment.succeeded', 'payment.failed', 'refund.succeeded']),
  data: z.object({
    orderId: z.string().min(1).max(100),
    paymentId: z.string().max(100).optional(),
  }),
});

function createPaymentsService({ db, audit, queue, provider, config, logger }) {
  function verifySignature(rawBody, signature) {
    if (!rawBody || !signature) return false;
    return safeEqual(hmacSha256(config.PAYMENT_WEBHOOK_SECRET, rawBody), signature);
  }

  async function handleWebhook(rawBody, signature, ctx) {
    if (!verifySignature(rawBody, signature)) {
      counters.payments.inc({ type: 'unknown', result: 'bad_signature' });
      throw AppError.unauthorized('Invalid webhook signature');
    }

    const parsed = eventSchema.safeParse(JSON.parse(rawBody.toString('utf8')));
    if (!parsed.success) throw AppError.badRequest('Unrecognised webhook payload');
    const event = parsed.data;

    const outcome = await db.transaction(async (client) => {
      // providers retry webhooks freely; recording the event id first makes repeats a no-op
      const inserted = await client.query(
        `INSERT INTO payment_events (event_id, type, payload) VALUES ($1, $2, $3)
         ON CONFLICT (event_id) DO NOTHING`,
        [event.id, event.type, event]
      );
      if (!inserted.rowCount) return 'duplicate';

      const { rows } = await client.query('SELECT * FROM payments WHERE provider_order_id = $1 FOR UPDATE', [event.data.orderId]);
      const payment = rows[0];
      if (!payment) return 'unknown_order';
      await client.query('UPDATE payment_events SET payment_id = $2 WHERE event_id = $1', [event.id, payment.id]);

      if (event.type === 'payment.succeeded') return onSucceeded(client, payment, event, ctx);
      if (event.type === 'payment.failed') return onFailed(client, payment, ctx);
      return onRefunded(client, payment, ctx);
    });

    counters.payments.inc({ type: event.type, result: outcome });
    return { received: true, outcome };
  }

  async function onSucceeded(client, payment, event, ctx) {
    if (['succeeded', 'refund_pending', 'refunded'].includes(payment.status)) return 'ignored';

    const { rows } = await client.query('SELECT * FROM consultations WHERE id = $1 FOR UPDATE', [payment.consultation_id]);
    const consultation = rows[0];

    if (payment.status !== 'pending' || consultation.status !== 'pending_payment') {
      // money was captured after we gave up on it (hold expired, patient cancelled) - refund it
      await client.query(
        `UPDATE payments SET status = 'refund_pending', provider_payment_id = $2, updated_at = now() WHERE id = $1`,
        [payment.id, event.data.paymentId ?? null]
      );
      await queue.enqueue('payments.refund', { paymentId: payment.id }, { client, dedupeKey: `refund:${payment.id}` });
      await audit.record(
        { action: 'payment.late_refund', entityType: 'payment', entityId: payment.id, metadata: { consultationStatus: consultation.status }, ctx },
        client
      );
      return 'refunding_late_payment';
    }

    await client.query(
      `UPDATE payments SET status = 'succeeded', provider_payment_id = $2, updated_at = now() WHERE id = $1`,
      [payment.id, event.data.paymentId ?? null]
    );
    await client.query(`UPDATE consultations SET status = 'confirmed', updated_at = now() WHERE id = $1`, [consultation.id]);
    await client.query(
      `UPDATE availability_slots SET status = 'booked', held_until = NULL, updated_at = now() WHERE id = $1`,
      [consultation.slot_id]
    );
    await queue.enqueue('notify.booking_confirmed', { consultationId: consultation.id }, { client });
    await audit.record(
      { action: 'payment.succeeded', entityType: 'payment', entityId: payment.id, metadata: { consultationId: consultation.id, amount: payment.amount }, ctx },
      client
    );
    return 'confirmed';
  }

  async function onFailed(client, payment, ctx) {
    if (payment.status !== 'pending') return 'ignored';

    await client.query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`, [payment.id]);
    const { rows } = await client.query(
      `UPDATE consultations SET status = 'expired', updated_at = now()
       WHERE id = $1 AND status = 'pending_payment' RETURNING slot_id`,
      [payment.consultation_id]
    );
    if (rows[0]) {
      await client.query(
        `UPDATE availability_slots SET status = 'open', held_until = NULL, updated_at = now() WHERE id = $1 AND status = 'held'`,
        [rows[0].slot_id]
      );
    }
    await audit.record({ action: 'payment.failed', entityType: 'payment', entityId: payment.id, ctx }, client);
    return 'released';
  }

  async function onRefunded(client, payment, ctx) {
    if (payment.status !== 'refund_pending') return 'ignored';
    await client.query(`UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1`, [payment.id]);
    await audit.record({ action: 'payment.refunded', entityType: 'payment', entityId: payment.id, ctx }, client);
    return 'refunded';
  }

  // job handler. The provider call happens outside any DB transaction so we never hold row
  // locks while waiting on the network.
  async function processRefund({ paymentId }) {
    const { rows } = await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    const payment = rows[0];
    if (!payment || payment.status !== 'refund_pending') return;

    // the idempotency key means a retried job can't refund the same payment twice at the provider
    const result = await withRetry(
      () =>
        provider.refund({
          providerPaymentId: payment.provider_payment_id,
          amount: payment.amount,
          idempotencyKey: `refund_${payment.id}`,
        }),
      { retries: 3, baseDelayMs: 200, shouldRetry: (err) => err.retryable }
    );

    await db.transaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1 AND status = 'refund_pending'`,
        [paymentId]
      );
      if (rowCount) {
        await audit.record(
          { action: 'payment.refunded', entityType: 'payment', entityId: paymentId, metadata: { refundId: result.refundId, amount: payment.amount } },
          client
        );
      }
    });
    logger.info({ paymentId, refundId: result.refundId }, 'refund processed');
  }

  return { handleWebhook, processRefund, verifySignature };
}

module.exports = { createPaymentsService };
