class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Authentication required') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You are not allowed to do this') {
    return new AppError(403, 'FORBIDDEN', message);
  }

  static notFound(what = 'Resource') {
    return new AppError(404, 'NOT_FOUND', `${what} not found`);
  }

  static conflict(message, code = 'CONFLICT') {
    return new AppError(409, code, message);
  }

  static unprocessable(message, code = 'UNPROCESSABLE') {
    return new AppError(422, code, message);
  }
}

module.exports = { AppError };
