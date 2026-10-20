function getPagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

function pageMeta({ page, limit }, total) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) || 0 };
}

module.exports = { getPagination, pageMeta };
