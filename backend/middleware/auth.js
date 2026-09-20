const jwt = require('jsonwebtoken');
const db = require('../db');

// Inlined rather than imported from services/chatService to keep the auth
// middleware free of a dependency on a feature module (chatService requires
// db, which requires dataDir — a cycle risk in the auth path).
const lastPresenceWrite = new Map();
function touchPresence(userId) {
  const now = Date.now();
  if (now - (lastPresenceWrite.get(userId) || 0) < 20000) return;
  lastPresenceWrite.set(userId, now);
  try {
    db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(userId);
  } catch { /* column not migrated yet on an old database — presence is best-effort */ }
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function loadPermissions(roleId) {
  if (!roleId) return {};
  const rows = db.prepare('SELECT * FROM role_permissions WHERE role_id=?').all(roleId);
  const map = {};
  for (const r of rows) {
    map[r.module] = {
      view: !!r.can_view,
      create: !!r.can_create,
      edit: !!r.can_edit,
      delete: !!r.can_delete,
      export: !!r.can_export,
    };
  }
  return map;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  // Only a genuine token problem is a 401. Previously this whole block was
  // wrapped in one try/catch that reported EVERY failure as "Session expired,
  // please log in again" — so a transient database error while loading the
  // user or their permissions silently logged people out and sent them back
  // to the login screen, with a message that pointed at entirely the wrong
  // cause.
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    const expired = e && e.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Session expired, please log in again' : 'Your sign-in could not be verified. Please log in again.',
    });
  }

  try {
    const user = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.active, u.role_id, r.name AS role_name
      FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id=?
    `).get(payload.id);
    if (!user || !user.active) return res.status(401).json({ error: 'Account is inactive or no longer exists' });
    user.permissions = loadPermissions(user.role_id);
    req.user = user;
    // Presence for the team chat: "online" means signed in and using the
    // CRM, so it is refreshed by any authenticated request rather than only
    // by chat traffic — otherwise someone working in Leads all morning shows
    // as offline to their colleagues. Throttled to one write per 20s.
    touchPresence(user.id);
    next();
  } catch (e) {
    // A server-side fault, not an authentication failure. Reporting 500 keeps
    // the user signed in and tells them something true.
    console.error('[auth] failed to load user/permissions:', e);
    return res.status(500).json({ error: 'Could not verify your account right now. Please try again.' });
  }
}

function requirePermission(module, action) {
  return (req, res, next) => {
    const perm = req.user && req.user.permissions && req.user.permissions[module];
    if (!perm || !perm[action]) {
      return res.status(403).json({ error: `You don't have ${action} access to ${module}` });
    }
    next();
  };
}

module.exports = { requireAuth, requirePermission, loadPermissions, JWT_SECRET };
