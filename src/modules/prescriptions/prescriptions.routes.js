const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../../middlewares/asyncHandler');
const validate = require('../../middlewares/validate');
const { requireRole } = require('../../middlewares/auth');
const { ctxFrom } = require('../audit/audit.service');

const idParam = z.object({ id: z.uuid() });

const medication = z.object({
  name: z.string().trim().min(1).max(120),
  dosage: z.string().trim().min(1).max(60),
  frequency: z.string().trim().min(1).max(60),
  durationDays: z.number().int().min(1).max(365),
  instructions: z.string().trim().max(300).optional(),
});

const createSchema = z.object({
  medications: z.array(medication).min(1).max(30),
  diagnosis: z.string().trim().max(2000).optional(),
  advice: z.string().trim().max(2000).optional(),
  followUpDate: z.iso.date().optional(),
});

// mounted at /consultations/:id/prescription
function nestedRoutes({ prescriptionsService, idempotent }) {
  const router = express.Router({ mergeParams: true });

  router.post(
    '/',
    requireRole('doctor'),
    validate({ params: idParam, body: createSchema }),
    idempotent,
    asyncHandler(async (req, res) => {
      res.status(201).json(await prescriptionsService.create(req.user, req.params.id, req.body, ctxFrom(req)));
    })
  );

  router.get(
    '/',
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      res.json(await prescriptionsService.getForConsultation(req.user, req.params.id, ctxFrom(req)));
    })
  );

  return router;
}

// mounted at /prescriptions
function patientRoutes({ prescriptionsService, authenticate }) {
  const router = express.Router();
  router.get(
    '/',
    authenticate,
    requireRole('patient'),
    asyncHandler(async (req, res) => {
      res.json(await prescriptionsService.listMine(req.user, req.query));
    })
  );
  return router;
}

module.exports = { nestedRoutes, patientRoutes };
