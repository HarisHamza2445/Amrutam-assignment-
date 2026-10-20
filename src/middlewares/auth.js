const jwt = require('jsonwebtoken');
const { AppError } = require('../lib/errors');

function authenticate({ secret }) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next(AppError.unauthorized());

    try {
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'], audience: 'amrutam-api' });
      if (payload.typ !== 'access') throw new Error('wrong token type');
      req.user = { id: payload.sub, role: payload.role, mfa: Boolean(payload.mfa) };
      next();
    } catch {
      next(AppError.unauthorized('Invalid or expired token'));
    }
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) return next(AppError.forbidden());
    next();
  };
}

// admins have to log in with a second factor before touching admin endpoints
function requireMfa(enabled) {
  return (req, res, next) => {
    if (enabled && !req.user?.mfa) {
      return next(new AppError(403, 'MFA_REQUIRED', 'This action needs a session verified with MFA'));
    }
    next();
  };
}

module.exports = { authenticate, requireRole, requireMfa };
