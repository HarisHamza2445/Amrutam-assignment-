const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../../middlewares/asyncHandler');
const validate = require('../../middlewares/validate');
const { requireRole } = require('../../middlewares/auth');
const { ctxFrom } = require('../audit/audit.service');
const { STATUS } = require('./consultation.state');

const idParam = z.object({ id: z.uuid() });

const bookSchema = z.object({
  slotId: z.uuid(),
  reason: z.string().trim().max(1000).optional(),
});

const listSchema = z.object({
  status: z.enum(Object.values(STATUS)).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  doctorId: z.uuid().optional(),
  patientId: z.uuid().optional(),
  upcoming: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

module.exports = function consultationsRoutes({ consultationsService, prescriptionsRoutes, authenticate, idempotent, userLimiter }) {
  const router = express.Router();
  router.use(authenticate, userLimiter);

  router.post(
    '/',
    requireRole('patient'),
    validate({ body: bookSchema }),
    idempotent,
    asyncHandler(async (req, res) => {
      res.status(201).json(await consultationsService.book(req.user, req.body, ctxFrom(req)));
    })
  );

  router.get(
    '/',
    validate({ query: listSchema }),
    asyncHandler(async (req, res) => {
      res.json(await consultationsService.list(req.user, req.validQuery));
    })
  );

  router.get(
    '/:id',
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      res.json(await consultationsService.get(req.user, req.params.id, ctxFrom(req)));
    })
  );

  router.post(
    '/:id/cancel',
    validate({ params: idParam, body: z.object({ reason: z.string().trim().max(500).optional() }) }),
    idempotent,
    asyncHandler(async (req, res) => {
      res.json(await consultationsService.cancel(req.user, req.params.id, req.body, ctxFrom(req)));
    })
  );

  router.post(
    '/:id/start',
    requireRole('doctor'),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      res.json(await consultationsService.start(req.user, req.params.id, ctxFrom(req)));
    })
  );

  router.post(
    '/:id/complete',
    requireRole('doctor'),
    validate({ params: idParam, body: z.object({ notes: z.string().trim().max(5000).optional() }) }),
    asyncHandler(async (req, res) => {
      res.json(await consultationsService.complete(req.user, req.params.id, ctxFrom(req), req.body));
    })
  );

  router.post(
    '/:id/no-show',
    requireRole('doctor'),
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      res.json(await consultationsService.markNoShow(req.user, req.params.id, ctxFrom(req)));
    })
  );

  router.use('/:id/prescription', prescriptionsRoutes);

  return router;
};
