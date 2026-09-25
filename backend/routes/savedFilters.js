// Saved list filters: a named set of filter conditions on one module's list.
// Mount: app.use('/api/saved-filters', requireAuth, require('./routes/savedFilters'));
const express = require('express');
const router = express.Router();
const db = require('../db');

const canView = (req, module) => !!req.user.permissions?.[module]?.view;
const shape = (r, userId) => ({
  id: r.id, module: r.module, name: r.name, match: r.match, shared: !!r.shared,
  filters: (() => { try { return JSON.parse(r.filters_json); } catch { return []; } })(),
  mine: r.user_id === userId, owner_name: r.owner_name || null, updated_at: r.updated_at,
});

// Mine plus anything shared, for one module.
router.get('/', (req, res) => {
  const module = String(req.query.module || '');
  if (!module) return res.status(400).json({ error: 'module is required' });
  if (!canView(req, module)) return res.status(403).json({ error: `You don't have view access to ${module}` });
  const rows = db.prepare(`SELECT f.*, COALESCE(u.full_name, u.username) owner_name FROM saved_list_filters f
    LEFT JOIN users u ON u.id = f.user_id
    WHERE f.module=? AND (f.user_id=? OR f.shared=1) ORDER BY f.name COLLATE NOCASE`).all(module, req.user.id);
  res.json(rows.map((r) => shape(r, req.user.id)));
});

function validate(b) {
  const name = String(b.name || '').trim();
  if (!name) throw Object.assign(new Error('Give the filter a name.'), { status: 400 });
  if (name.length > 80) throw Object.assign(new Error('Keep the name under 80 characters.'), { status: 400 });
  if (!Array.isArray(b.filters) || !b.filters.length) throw Object.assign(new Error('Add at least one condition before saving.'), { status: 400 });
  const filters = b.filters.slice(0, 30).map((f) => ({
    field: String(f.field || ''), op: String(f.op || ''), value: f.value ?? null, value2: f.value2 ?? null,
  })).filter((f) => f.field && f.op);
  return { name, filters, match: b.match === 'any' ? 'any' : 'all', shared: b.shared ? 1 : 0 };
}

router.post('/', (req, res) => {
  const module = String(req.body.module || '');
  if (!module || !canView(req, module)) return res.status(403).json({ error: 'No access to this module' });
  try {
    const v = validate(req.body);
    const dup = db.prepare('SELECT id FROM saved_list_filters WHERE module=? AND user_id=? AND name=? COLLATE NOCASE').get(module, req.user.id, v.name);
    if (dup) {
      db.prepare("UPDATE saved_list_filters SET filters_json=?, match=?, shared=?, updated_at=datetime('now') WHERE id=?")
        .run(JSON.stringify(v.filters), v.match, v.shared, dup.id);
      return res.json(shape(db.prepare('SELECT * FROM saved_list_filters WHERE id=?').get(dup.id), req.user.id));
    }
    const info = db.prepare('INSERT INTO saved_list_filters (module, name, filters_json, match, shared, user_id) VALUES (?,?,?,?,?,?)')
      .run(module, v.name, JSON.stringify(v.filters), v.match, v.shared, req.user.id);
    res.status(201).json(shape(db.prepare('SELECT * FROM saved_list_filters WHERE id=?').get(info.lastInsertRowid), req.user.id));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM saved_list_filters WHERE id=?').get(req.params.id);
  if (!row) return res.status(204).end();
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'Only the person who saved this filter can delete it.' });
  db.prepare('DELETE FROM saved_list_filters WHERE id=?').run(row.id);
  res.status(204).end();
});

module.exports = router;
