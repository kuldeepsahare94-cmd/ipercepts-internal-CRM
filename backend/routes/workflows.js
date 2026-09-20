// Settings -> Workflows (the general Workflow Builder's backend).
// Mount in server.js as: app.use('/api/workflows', requireAuth, require('./routes/workflows'));

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');

router.get('/', requirePermission('workflows', 'view'), (req, res) => {
  const rows = db.prepare(`
    SELECT w.*, m.plural_label AS module_label, m.api_name AS module_api_name FROM crm_workflows w
    JOIN modules m ON m.id = w.module_id ORDER BY w.created_at DESC
  `).all();
  res.json(rows);
});

router.get('/:id', requirePermission('workflows', 'view'), (req, res) => {
  const row = db.prepare('SELECT * FROM crm_workflows WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.get('/:id/runs', requirePermission('workflows', 'view'), (req, res) => {
  const rows = db.prepare('SELECT * FROM crm_workflow_runs WHERE workflow_id=? ORDER BY created_at DESC LIMIT 50').all(req.params.id);
  res.json(rows);
});

const VALID_TRIGGERS = new Set(['record_created', 'record_updated', 'field_changed']);
const VALID_ACTIONS = new Set(['update_field', 'create_record', 'create_notification', 'webhook']);

function validate(body) {
  if (!body.name) throw Object.assign(new Error('name is required'), { status: 400 });
  if (!body.module_id) throw Object.assign(new Error('module_id is required'), { status: 400 });
  if (!VALID_TRIGGERS.has(body.trigger_type)) throw Object.assign(new Error(`trigger_type must be one of: ${[...VALID_TRIGGERS].join(', ')}`), { status: 400 });
  if (body.trigger_type === 'field_changed' && !body.trigger_field) throw Object.assign(new Error('trigger_field is required for field_changed triggers'), { status: 400 });
  const actions = body.actions || [];
  if (!Array.isArray(actions) || actions.length === 0) throw Object.assign(new Error('at least one action is required'), { status: 400 });
  for (const a of actions) {
    if (!VALID_ACTIONS.has(a.type)) throw Object.assign(new Error(`Unknown action type "${a.type}" — must be one of: ${[...VALID_ACTIONS].join(', ')}`), { status: 400 });
  }
}

router.post('/', requirePermission('workflows', 'create'), (req, res) => {
  try {
    validate(req.body);
    const info = db.prepare(`
      INSERT INTO crm_workflows (name, module_id, trigger_type, trigger_field, conditions_json, actions_json, active, created_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(req.body.name, req.body.module_id, req.body.trigger_type, req.body.trigger_field || null,
      JSON.stringify(req.body.conditions || []), JSON.stringify(req.body.actions || []),
      req.body.active === false ? 0 : 1, req.user.id);
    res.status(201).json(db.prepare('SELECT * FROM crm_workflows WHERE id=?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
});

router.put('/:id', requirePermission('workflows', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM crm_workflows WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  try {
    const merged = { ...existing, ...req.body };
    validate({ ...merged, actions: req.body.actions ?? JSON.parse(existing.actions_json) });
    db.prepare(`
      UPDATE crm_workflows SET name=?, module_id=?, trigger_type=?, trigger_field=?, conditions_json=?, actions_json=?, active=?, updated_at=datetime('now')
      WHERE id=?
    `).run(merged.name, merged.module_id, merged.trigger_type, merged.trigger_field || null,
      JSON.stringify(req.body.conditions ?? JSON.parse(existing.conditions_json)),
      JSON.stringify(req.body.actions ?? JSON.parse(existing.actions_json)),
      merged.active ? 1 : 0, req.params.id);
    res.json(db.prepare('SELECT * FROM crm_workflows WHERE id=?').get(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
});

router.delete('/:id', requirePermission('workflows', 'delete'), (req, res) => {
  db.prepare('DELETE FROM crm_workflows WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
