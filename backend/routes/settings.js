const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');

// ===== Receipt templates (configurable Institute A / B — see spec: "Receipt templates
// should be configurable from the admin panel"). Seeded with placeholder text until
// real institute names/logos/GST details are supplied. =====
router.get('/receipt-templates', requirePermission('settings', 'view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM receipt_templates').all());
});

router.put('/receipt-templates/:id', requirePermission('settings', 'edit'), (req, res) => {
  const id = req.params.id.toUpperCase();
  if (!['A', 'B'].includes(id)) return res.status(400).json({ error: "id must be 'A' or 'B'" });
  const existing = db.prepare('SELECT * FROM receipt_templates WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  db.prepare(`
    UPDATE receipt_templates SET institute_name=?, logo_url=?, address=?, footer_text=?, gst_details=?, updated_at=datetime('now')
    WHERE id=?
  `).run(m.institute_name, m.logo_url, m.address, m.footer_text, m.gst_details, id);
  res.json(db.prepare('SELECT * FROM receipt_templates WHERE id=?').get(id));
});

// ===== Master option lists (Lead Source, Qualification, Payment Mode) =====
router.get('/master-options', requirePermission('settings', 'view'), (req, res) => {
  const { list_type } = req.query;
  let sql = 'SELECT * FROM master_options WHERE 1=1';
  const params = [];
  if (list_type) { sql += ' AND list_type = ?'; params.push(list_type); }
  sql += ' ORDER BY list_type, sort_order';
  res.json(db.prepare(sql).all(...params));
});

router.post('/master-options', requirePermission('settings', 'create'), (req, res) => {
  const { list_type, label, color, sort_order } = req.body;
  if (!list_type || !label) return res.status(400).json({ error: 'list_type and label are required' });
  const info = db.prepare('INSERT INTO master_options (list_type, label, color, sort_order) VALUES (?,?,?,?)')
    .run(list_type, label, color || null, sort_order || 0);
  res.status(201).json(db.prepare('SELECT * FROM master_options WHERE id=?').get(info.lastInsertRowid));
});

router.put('/master-options/:id', requirePermission('settings', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM master_options WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  db.prepare('UPDATE master_options SET label=?, color=?, sort_order=?, active=? WHERE id=?')
    .run(m.label, m.color, m.sort_order, m.active, req.params.id);
  res.json(db.prepare('SELECT * FROM master_options WHERE id=?').get(req.params.id));
});

router.delete('/master-options/:id', requirePermission('settings', 'delete'), (req, res) => {
  db.prepare('DELETE FROM master_options WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
