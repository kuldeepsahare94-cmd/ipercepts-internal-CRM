const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, loadPermissions, JWT_SECRET } = require('../middleware/auth');

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  if (!user.active) return res.status(403).json({ error: 'This account has been deactivated. Contact your admin.' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  const role = user.role_id ? db.prepare('SELECT id, name FROM roles WHERE id=?').get(user.role_id) : null;
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });

  // Signing in is the clearest possible sign of life — without this, someone
  // who has just logged in shows as offline in the team chat until their
  // first authenticated request happens to land.
  try {
    db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(user.id);
  } catch { /* pre-migration database — presence is best-effort */ }
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role,
      role_name: role ? role.name : null,
      permissions: loadPermissions(user.role_id),
    },
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
