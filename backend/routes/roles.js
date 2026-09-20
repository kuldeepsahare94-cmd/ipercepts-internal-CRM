const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');

// The modules a NEWLY CREATED role gets permission rows for.
//
// This list had been left at the education-era set — students, courses,
// admissions, companies, placements — long after those modules were removed.
// The effect was that creating a new role produced rows for modules that no
// longer exist and NO rows for most modules that do, so a user in a new role
// found half the CRM missing. It is now the real module list, and it must be
// kept in step with the matrix in frontend/src/pages/Roles.jsx.
const MODULES = ['leads', 'accounts', 'contacts', 'opportunities', 'quotations', 'products',
  'subscriptions', 'tickets', 'calls', 'meetings', 'tasks', 'notes', 'emails', 'payments',
  'documents', 'teams', 'workflows', 'reports', 'users', 'chat', 'calendar', 'settings',
  'assistant', 'whatsapp', 'lead_sources'];

router.get('/', requirePermission('users', 'view'), (req, res) => {
  const roles = db.prepare('SELECT * FROM roles ORDER BY id').all();
  const perms = db.prepare('SELECT * FROM role_permissions').all();
  res.json(roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.role_id === r.id) })));
});

router.post('/', requirePermission('users', 'create'), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO roles (name, is_system) VALUES (?,0)').run(name);
  const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,0,0,0,0,0)');
  for (const mod of MODULES) insertPerm.run(info.lastInsertRowid, mod);
  res.status(201).json(db.prepare('SELECT * FROM roles WHERE id=?').get(info.lastInsertRowid));
});

// Update the full permission matrix for a role at once
router.put('/:id/permissions', requirePermission('users', 'edit'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  const { permissions } = req.body; // [{module, can_view, can_create, can_edit, can_delete, can_export}, ...]
  const upsert = db.prepare(`
    INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(role_id, module) DO UPDATE SET can_view=excluded.can_view, can_create=excluded.can_create,
      can_edit=excluded.can_edit, can_delete=excluded.can_delete, can_export=excluded.can_export
  `);
  const tx = db.transaction((rows) => {
    for (const p of rows) upsert.run(req.params.id, p.module, +!!p.can_view, +!!p.can_create, +!!p.can_edit, +!!p.can_delete, +!!p.can_export);
  });
  tx(permissions || []);
  res.json(db.prepare('SELECT * FROM role_permissions WHERE role_id=?').all(req.params.id));
});

router.delete('/:id', requirePermission('users', 'delete'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  if (role.is_system) return res.status(400).json({ error: 'Built-in roles cannot be deleted' });
  db.prepare('DELETE FROM roles WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
