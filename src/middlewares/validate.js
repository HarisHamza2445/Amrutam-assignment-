const { AppError } = require('../lib/errors');

// validate({ body, query, params }) with zod schemas; parsed values replace the originals
module.exports = function validate(schemas) {
  return (req, res, next) => {
    const details = [];
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        for (const issue of result.error.issues) {
          details.push({ field: [part, ...issue.path].join('.'), message: issue.message });
        }
      } else if (part === 'query') {
        // req.query is read-only in express 5, so the parsed copy lives on its own property
        req.validQuery = result.data;
      } else {
        req[part] = result.data;
      }
    }
    if (details.length) return next(AppError.badRequest('Validation failed', details));
    next();
  };
};
