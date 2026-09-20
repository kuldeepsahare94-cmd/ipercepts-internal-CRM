// A small factory instead of 5 near-copies of the same CRUD boilerplate.
// Each activity module (Calls, Meetings, Tasks, Notes, Emails) shares the
// same shape: a polymorphic related_module/related_record_id pair, simple
// flat fields, permission-checked against its own module api_name. Column
// names are never taken from user input — each caller passes an explicit,
// fixed whitelist — so this stays just as SQL-injection-safe as writing
// each route out by hand.

const express = require('express');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { fireWorkflows } = require('../services/workflowAutomation');

// config: {
//   moduleApiName, tableName, titleColumn (the required "what is this called" column),
//   columns: [ {name, default} ... ]  — every writable column besides id/timestamps
// }
function createActivityRouter(config) {
  const router = express.Router();
  const { moduleApiName, tableName, columns } = config;
  const columnNames = columns.map((c) => c.name);

  router.get('/', requirePermission(moduleApiName, 'view'), (req, res) => {
    const { related_module, related_record_id, status, q } = req.query;
    let sql = `SELECT * FROM ${tableName} WHERE 1=1`;
    const params = [];
    if (related_module) { sql += ' AND related_module=?'; params.push(related_module); }
    if (related_record_id) { sql += ' AND related_record_id=?'; params.push(related_record_id); }
    if (status) { sql += ' AND status=?'; params.push(status); }
    if (q) { sql += ` AND (${config.titleColumn} LIKE ?)`; params.push(`%${q}%`); }
    sql += ' ORDER BY created_at DESC LIMIT 200';
    res.json(db.prepare(sql).all(...params));
  });

  router.get('/:id', requirePermission(moduleApiName, 'view'), (req, res) => {
    const row = db.prepare(`SELECT * FROM ${tableName} WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  router.post('/', requirePermission(moduleApiName, 'create'), (req, res) => {
    const b = req.body;
    if (!b[config.titleColumn]) return res.status(400).json({ error: `${config.titleColumn} is required` });
    const values = { ...Object.fromEntries(columns.map((c) => [c.name, c.default ?? null])), ...b, created_by: req.user.id };
    const info = db.prepare(`
      INSERT INTO ${tableName} (${columnNames.join(', ')}, created_by)
      VALUES (${columnNames.map((n) => `@${n}`).join(', ')}, @created_by)
    `).run(values);
    const created = db.prepare(`SELECT * FROM ${tableName} WHERE id=?`).get(info.lastInsertRowid);
    fireWorkflows(moduleApiName, 'record_created', created, null, req.user.id);
    // Re-fetch: a workflow's update_field action may have just changed this
    // same record — the response must reflect that, not the pre-workflow
    // snapshot (a real bug caught and fixed the same way in Opportunities/
    // Tickets back in Phase 16).
    res.status(201).json(db.prepare(`SELECT * FROM ${tableName} WHERE id=?`).get(created.id));
  });

  router.put('/:id', requirePermission(moduleApiName, 'edit'), (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${tableName} WHERE id=?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const merged = { ...existing, ...req.body };
    const setClause = columnNames.map((n) => `${n}=@${n}`).join(', ');
    db.prepare(`UPDATE ${tableName} SET ${setClause}, updated_at=datetime('now') WHERE id=@id`).run({ ...merged, id: req.params.id });
    const updated = db.prepare(`SELECT * FROM ${tableName} WHERE id=?`).get(req.params.id);
    fireWorkflows(moduleApiName, 'record_updated', updated, existing, req.user.id);
    fireWorkflows(moduleApiName, 'field_changed', updated, existing, req.user.id);
    res.json(db.prepare(`SELECT * FROM ${tableName} WHERE id=?`).get(req.params.id));
  });

  router.delete('/:id', requirePermission(moduleApiName, 'delete'), async (req, res) => {
    // `beforeDelete` lets a module clean up things that live outside its own
    // table. Meetings use it to remove the matching event from connected
    // Google and Outlook calendars — without it, deleting a meeting from a
    // record page would leave a ghost event in everyone's calendar forever,
    // with no way to get rid of it from the CRM.
    //
    // It runs BEFORE the row is deleted, because the link between a meeting
    // and its external event is keyed on the meeting. It never blocks the
    // delete: if the provider cannot be reached, the CRM still removes its own
    // record and the failure is logged rather than shown as a delete error.
    if (typeof config.beforeDelete === 'function') {
      try {
        await config.beforeDelete(Number(req.params.id), req);
      } catch (err) {
        console.warn(`[${moduleApiName}] beforeDelete hook failed for ${req.params.id}: ${err.message}`);
      }
    }
    db.prepare(`DELETE FROM ${tableName} WHERE id=?`).run(req.params.id);
    res.status(204).end();
  });

  return router;
}

module.exports = { createActivityRouter };
