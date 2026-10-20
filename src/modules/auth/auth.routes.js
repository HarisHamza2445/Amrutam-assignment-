const express = require('express');
const asyncHandler = require('../../middlewares/asyncHandler');
const validate = require('../../middlewares/validate');
const schemas = require('./auth.schemas');

module.exports = function authRoutes({ authService, authenticate, authLimiter }) {
  const router = express.Router();
  const meta = (req) => ({ ip: req.ip, requestId: req.id, userAgent: req.get('user-agent') });

  router.post(
    '/register',
    authLimiter,
    validate({ body: schemas.register }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await authService.register(req.body, meta(req)));
    })
  );

  router.post(
    '/login',
    authLimiter,
    validate({ body: schemas.login }),
    asyncHandler(async (req, res) => {
      res.json(await authService.login(req.body, meta(req)));
    })
  );

  router.post(
    '/login/mfa',
    authLimiter,
    validate({ body: schemas.loginMfa }),
    asyncHandler(async (req, res) => {
      res.json(await authService.loginWithMfa(req.body, meta(req)));
    })
  );

  router.post(
    '/refresh',
    authLimiter,
    validate({ body: schemas.refresh }),
    asyncHandler(async (req, res) => {
      res.json(await authService.refresh(req.body, meta(req)));
    })
  );

  router.post(
    '/logout',
    validate({ body: schemas.refresh }),
    asyncHandler(async (req, res) => {
      await authService.logout(req.body);
      res.status(204).end();
    })
  );

  router.post(
    '/mfa/setup',
    authenticate,
    asyncHandler(async (req, res) => {
      res.json(await authService.setupMfa(req.user.id));
    })
  );

  router.post(
    '/mfa/enable',
    authenticate,
    authLimiter,
    validate({ body: schemas.mfaCode }),
    asyncHandler(async (req, res) => {
      await authService.enableMfa(req.user, req.body, meta(req));
      res.json({ mfaEnabled: true, message: 'MFA enabled. Please log in again.' });
    })
  );

  router.post(
    '/mfa/disable',
    authenticate,
    authLimiter,
    validate({ body: schemas.mfaCode }),
    asyncHandler(async (req, res) => {
      await authService.disableMfa(req.user, req.body, meta(req));
      res.json({ mfaEnabled: false });
    })
  );

  return router;
};
