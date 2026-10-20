const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../../middlewares/asyncHandler');
const validate = require('../../middlewares/validate');
const { ctxFrom } = require('../audit/audit.service');

const updateSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    phone: z.string().regex(/^\+?[0-9]{10,15}$/, 'Invalid phone number'),
    dateOfBirth: z.iso.date(),
    gender: z.enum(['male', 'female', 'other']),
    city: z.string().trim().max(80),
  })
  .partial()
  .strict();

module.exports = function usersRoutes({ usersService, authenticate }) {
  const router = express.Router();
  router.use(authenticate);

  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      res.json(await usersService.getMe(req.user.id));
    })
  );

  router.patch(
    '/me',
    validate({ body: updateSchema }),
    asyncHandler(async (req, res) => {
      res.json(await usersService.updateProfile(req.user, req.body, ctxFrom(req)));
    })
  );

  return router;
};
