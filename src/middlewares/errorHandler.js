const { AppError } = require('../lib/errors');

function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let error = err;

  if (err.type === 'entity.parse.failed') {
    error = AppError.badRequest('Malformed JSON body');
  } else if (err.type === 'entity.too.large') {
    error = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  } else if (err.code === '23505') {
    error = AppError.conflict('This record already exists');
  } else if (err.code === '22P02') {
    error = AppError.badRequest('Invalid identifier');
  } else if (!(err instanceof AppError)) {
    req.log?.error({ err }, 'unhandled error');
    error = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
  }

  if (error.status >= 500 && err instanceof AppError) req.log?.error({ err }, 'server error');

  res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      requestId: req.id,
    },
  });
}

module.exports = { notFound, errorHandler };
