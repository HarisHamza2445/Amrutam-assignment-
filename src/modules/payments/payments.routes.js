const express = require('express');
const asyncHandler = require('../../middlewares/asyncHandler');

module.exports = function paymentsRoutes({ paymentsService }) {
  const router = express.Router();

  // called by the payment provider, authenticated by HMAC signature instead of a user token
  router.post(
    '/webhook',
    asyncHandler(async (req, res) => {
      const result = await paymentsService.handleWebhook(req.rawBody, req.get('x-mockpay-signature'), { ip: req.ip, requestId: req.id });
      res.json(result);
    })
  );

  return router;
};
