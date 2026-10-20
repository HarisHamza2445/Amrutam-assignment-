const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../../middlewares/asyncHandler');
const validate = require('../../middlewares/validate');
const { requireRole } = require('../../middlewares/auth');
const { ctxFrom } = require('../audit/audit.service');

const idParam = z.object({ id: z.uuid() });
const datetime = z.iso.datetime({ offset: true });

const profileSchema = z.object({
  specialization: z.string().trim().min(2).max(80),
  qualifications: z.string().trim().max(300).optional(),
  experienceYears: z.number().int().min(0).max(70),
  consultationFee: z.number().int().min(0).max(10_000_000),
  languages: z
    .array(z.string().trim().min(2).max(30))
    .min(1)
    .max(10)
    .transform((list) => [...new Set(list.map((l) => l.toLowerCase()))]),
  bio: z.string().trim().max(2000).optional(),
});

const searchSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  specialization: z.string().trim().max(80).optional(),
  language: z.string().trim().max(30).optional(),
  minFee: z.coerce.number().int().min(0).optional(),
  maxFee: z.coerce.number().int().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  availableOn: z.iso.date().optional(),
  sort: z.enum(['rating', 'fee_asc', 'fee_desc', 'experience']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const slotsQuery = z.object({
  from: datetime.optional(),
  to: datetime.optional(),
  status: z.enum(['open', 'all']).optional(),
});

const createSlotsSchema = z.object({
  slots: z.array(z.object({ startsAt: datetime, endsAt: datetime })).min(1).max(60),
});

module.exports = function doctorsRoutes({ doctorsService, authenticate }) {
  const router = express.Router();
  const doctorOnly = [authenticate, requireRole('doctor')];

  router.get(
    '/',
    validate({ query: searchSchema }),
    asyncHandler(async (req, res) => {
      res.json(await doctorsService.search(req.validQuery));
    })
  );

  router.put(
    '/me',
    doctorOnly,
    validate({ body: profileSchema }),
    asyncHandler(async (req, res) => {
      res.json(await doctorsService.upsertMyProfile(req.user, req.body, ctxFrom(req)));
    })
  );

  router.post(
    '/me/slots',
    doctorOnly,
    validate({ body: createSlotsSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json({ data: await doctorsService.createSlots(req.user, req.body.slots, ctxFrom(req)) });
    })
  );

  router.delete(
    '/me/slots/:id',
    doctorOnly,
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      res.json(await doctorsService.blockSlot(req.user, req.params.id, ctxFrom(req)));
    })
  );

  router.get(
    '/:id',
    validate({ params: idParam }),
    asyncHandler(async (req, res) => {
      res.json(await doctorsService.getById(req.params.id));
    })
  );

  router.get(
    '/:id/slots',
    validate({ params: idParam, query: slotsQuery }),
    asyncHandler(async (req, res) => {
      res.json({ data: await doctorsService.listSlots(req.params.id, req.validQuery) });
    })
  );

  return router;
};
