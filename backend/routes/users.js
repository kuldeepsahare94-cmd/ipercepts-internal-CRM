const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');

router.get('/', requirePermission('users', 'view'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.active, u.role_id, r.name AS role_name, u.created_at
    FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.created_at DESC
  `).all();
  res.json(rows);
});

router.post('/', requirePermission('users', 'create'), (req, res) => {
  const { username, password, full_name, role_id, active } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role_id, active) VALUES (?,?,?,?,?)
    `).run(username, hash, full_name || null, role_id || null, active === false ? 0 : 1);
    res.status(201).json(db.prepare('SELECT id, username, full_name, role_id, active, created_at FROM users WHERE id=?').get(info.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requirePermission('users', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { username, password, full_name, role_id, active } = req.body;

  if (req.user && req.user.id === Number(req.params.id) && active === false) {
    return res.status(400).json({ error: "You can't deactivate your own account while logged in." });
  }

  const newHash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;
  db.prepare(`
    UPDATE users SET username=?, password_hash=?, full_name=?, role_id=?, active=? WHERE id=?
  `).run(
    username ?? existing.username,
    newHash,
    full_name !== undefined ? full_name : existing.full_name,
    role_id !== undefined ? role_id : existing.role_id,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    req.params.id
  );
  res.json(db.prepare('SELECT id, username, full_name, role_id, active, created_at FROM users WHERE id=?').get(req.params.id));
});

router.delete('/:id', requirePermission('users', 'delete'), (req, res) => {
  if (req.user && req.user.id === Number(req.params.id)) {
    return res.status(400).json({ error: "You can't delete your own account while logged in." });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
