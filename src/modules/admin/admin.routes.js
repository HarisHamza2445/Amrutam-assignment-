const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../../middlewares/asyncHandler');
const validate = require('../../middlewares/validate');
const { requireRole, requireMfa } = require('../../middlewares/auth');
const { ctxFrom } = require('../audit/audit.service');

const uuidParam = z.object({ id: z.uuid() });

function defaultRange(query) {
  const to = query.to || new Date().toISOString().slice(0, 10);
  const from = query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

const rangeSchema = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, '"from" must be before "to"');

const auditQuery = z.object({
  actorId: z.uuid().optional(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

module.exports = function adminRoutes({ adminService, analyticsService, auditService, doctorsService, authenticate, config }) {
  const router = express.Router();
  router.use(authenticate, requireRole('admin'), requireMfa(config.REQUIRE_ADMIN_MFA));

  router.get(
    '/analytics/overview',
    validate({ query: rangeSchema }),
    asyncHandler(async (req, res) => {
      res.json(await analyticsService.overview(defaultRange(req.validQuery)));
    })
  );

  router.get(
    '/analytics/daily',
    validate({ query: rangeSchema }),
    asyncHandler(async (req, res) => {
      res.json({ data: await analyticsService.daily(defaultRange(req.validQuery)) });
    })
  );

  router.get(
    '/audit-logs',
    validate({ query: auditQuery }),
    asyncHandler(async (req, res) => {
      res.json(await auditService.search(req.validQuery));
    })
  );

  router.patch(
    '/doctors/:id/verification',
    validate({ params: uuidParam, body: z.object({ isVerified: z.boolean() }) }),
    asyncHandler(async (req, res) => {
      res.json(await doctorsService.setVerified(req.user, req.params.id, req.body.isVerified, ctxFrom(req)));
    })
  );

  router.patch(
    '/users/:id/status',
    validate({ params: uuidParam, body: z.object({ status: z.enum(['active', 'disabled']) }) }),
    asyncHandler(async (req, res) => {
      res.json(await adminService.setUserStatus(req.user, req.params.id, req.body.status, ctxFrom(req)));
    })
  );

  router.get(
    '/jobs/failed',
    asyncHandler(async (req, res) => {
      res.json({ data: await adminService.failedJobs() });
    })
  );

  router.post(
    '/jobs/:id/retry',
    validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
    asyncHandler(async (req, res) => {
      await adminService.retryJob(req.user, req.params.id, ctxFrom(req));
      res.status(202).json({ queued: true });
    })
  );

  return router;
};
