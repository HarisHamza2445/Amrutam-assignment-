const { getPagination, pageMeta } = require('../../lib/pagination');

function createAuditService({ db }) {
  /**
   * Pass `client` when inside a transaction so the audit row commits (or rolls back)
   * together with the change it describes.
   */
  async function record(entry, client = db) {
    const { actor, action, entityType, entityId, metadata = {}, ctx = {} } = entry;
    await client.query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, metadata, ip, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actor?.id ?? null, actor?.role ?? 'system', action, entityType, entityId ? String(entityId) : null, metadata, ctx.ip ?? null, ctx.requestId ?? null]
    );
  }

  async function search(filters) {
    const { page, limit, offset } = getPagination(filters, { defaultLimit: 50, maxLimit: 200 });
    const where = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };

    if (filters.actorId) add('actor_id = ?', filters.actorId);
    if (filters.action) add('action = ?', filters.action);
    if (filters.entityType) add('entity_type = ?', filters.entityType);
    if (filters.entityId) add('entity_id = ?', filters.entityId);
    // the date range also lets postgres prune partitions
    if (filters.from) add('created_at >= ?', filters.from);
    if (filters.to) add('created_at < ?', filters.to);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows, count] = await Promise.all([
      db.query(
        `SELECT id, actor_id, actor_role, action, entity_type, entity_id, metadata, ip, request_id, created_at
         FROM audit_logs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      db.query(`SELECT count(*)::int AS total FROM audit_logs ${whereSql}`, params),
    ]);

    return { data: rows.rows.map(toDto), meta: pageMeta({ page, limit }, count.rows[0].total) };
  }

  return { record, search };
}

function toDto(row) {
  return {
    id: String(row.id),
    actorId: row.actor_id,
    actorRole: row.actor_role,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata,
    ip: row.ip,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

// helper so controllers don't repeat themselves
const ctxFrom = (req) => ({ ip: req.ip, requestId: req.id });

module.exports = { createAuditService, ctxFrom };
