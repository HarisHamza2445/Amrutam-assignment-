const crypto = require('crypto');

const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

module.exports = function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && VALID_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.set('x-request-id', req.id);
  next();
};
