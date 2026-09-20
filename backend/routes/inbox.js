// Email inbox — reading what came in, replying, and correcting matches.
//
// Mount: app.use('/api/inbox', requireAuth, require('./routes/inbox'));

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { syncAccount, syncAll } = require('../services/inboundEmail');
const { sendEmail } = require('../services/email');

const { UPLOAD_DIR } = require('../dataDir');

const LIST_COLS = `e.id, e.subject, e.from_address, e.to_address, e.direction, e.status,
  e.thread_key, e.is_read, e.has_attachments, e.matched_by, e.received_at, e.sent_at,
  e.related_module, e.related_record_id,
  substr(COALESCE(e.body,''), 1, 160) AS preview`;

// GET /api/inbox?filter=all|unread|unmatched&q=&module=&record_id=
router.get('/', requirePermission('emails', 'view'), (req, res) => {
  const { filter, q, module: mod, record_id, limit } = req.query;
  let sql = `SELECT ${LIST_COLS} FROM emails e WHERE 1=1`;
  const params = [];

  if (filter === 'unread') sql += " AND e.is_read=0 AND e.direction='Inbound'";
  if (filter === 'unmatched') sql += " AND e.related_record_id IS NULL AND e.direction='Inbound'";
  if (filter === 'inbound') sql += " AND e.direction='Inbound'";
  if (filter === 'sent') sql += " AND e.direction='Outbound'";
  if (mod) { sql += ' AND e.related_module=?'; params.push(mod); }
  if (record_id) { sql += ' AND e.related_record_id=?'; params.push(record_id); }
  if (q) {
    sql += ' AND (e.subject LIKE ? OR e.from_address LIKE ? OR e.body LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY COALESCE(e.received_at, e.sent_at, e.created_at) DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 100, 500));

  const rows = db.prepare(sql).all(...params);
  const counts = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction='Inbound' THEN 1 ELSE 0 END),0) inbound,
      COALESCE(SUM(CASE WHEN direction='Inbound' AND is_read=0 THEN 1 ELSE 0 END),0) unread,
      COALESCE(SUM(CASE WHEN direction='Inbound' AND related_record_id IS NULL THEN 1 ELSE 0 END),0) unmatched,
      COALESCE(SUM(CASE WHEN direction='Outbound' THEN 1 ELSE 0 END),0) sent
    FROM emails`).get();
  res.json({ emails: rows, counts });
});

// One message plus its whole thread, so a reply has context.
router.get('/:id', requirePermission('emails', 'view'), (req, res) => {
  const email = db.prepare('SELECT * FROM emails WHERE id=?').get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Message not found' });
  const thread = email.thread_key
    ? db.prepare(`SELECT ${LIST_COLS}, e.body, e.body_html FROM emails e WHERE e.thread_key=?
                  ORDER BY COALESCE(e.received_at, e.sent_at, e.created_at)`).all(email.thread_key)
    : [];
  const attachments = db.prepare('SELECT id, file_name, mime_type, size_bytes FROM email_attachments WHERE email_id=?')
    .all(req.params.id);
  res.json({ email, thread, attachments });
});

router.post('/:id/read', requirePermission('emails', 'view'), (req, res) => {
  db.prepare('UPDATE emails SET is_read=? WHERE id=?').run(req.body?.read === false ? 0 : 1, req.params.id);
  res.json({ ok: true });
});

// Manually attach a message to the right record. Needed because automatic
// matching deliberately refuses to guess — this is how a human corrects it.
router.post('/:id/link', requirePermission('emails', 'edit'), (req, res) => {
  const { related_module, related_record_id } = req.body || {};
  if (!related_module || !related_record_id) {
    return res.status(400).json({ error: 'related_module and related_record_id are required' });
  }
  const email = db.prepare('SELECT id FROM emails WHERE id=?').get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Message not found' });
  db.prepare(`UPDATE emails SET related_module=?, related_record_id=?, matched_by='linked manually', updated_at=datetime('now') WHERE id=?`)
    .run(related_module, related_record_id, req.params.id);
  res.json(db.prepare('SELECT * FROM emails WHERE id=?').get(req.params.id));
});

// Reply, keeping the thread intact and logging the outbound copy.
router.post('/:id/reply', requirePermission('emails', 'create'), async (req, res) => {
  const original = db.prepare('SELECT * FROM emails WHERE id=?').get(req.params.id);
  if (!original) return res.status(404).json({ error: 'Message not found' });
  // The composer sends HTML plus a plain-text fallback. Both go out, so
  // clients that refuse HTML still show something readable.
  const html = (req.body?.html || '').trim();
  const body = (req.body?.body || '').trim();
  if (!body && !html) return res.status(400).json({ error: 'A reply body is required' });

  const to = req.body.to || original.from_address;
  const subject = req.body.subject
    || (/^re:/i.test(original.subject || '') ? original.subject : `Re: ${original.subject || ''}`.trim());

  try {
    const sent = await sendEmail({ to, subject, text: body || undefined, html: html || undefined, userId: req.user.id });
    db.prepare(`
      INSERT INTO emails (subject, from_address, to_address, related_module, related_record_id,
        direction, status, body, body_html, message_id, in_reply_to, thread_key, is_read, created_by, sent_at, received_at)
      VALUES (?,?,?,?,?, 'Outbound', 'Sent', ?,?,?,?,?, 1, ?, datetime('now'), datetime('now'))
    `).run(subject, sent.sent_from || '', to, original.related_module, original.related_record_id,
      body, html || null, sent.messageId || null, original.message_id || null, original.thread_key, req.user.id);
    res.json({ ok: true, sent_from: sent.sent_from, to });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/attachments/:id/download', requirePermission('emails', 'view'), (req, res) => {
  const att = db.prepare('SELECT * FROM email_attachments WHERE id=?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const filePath = path.resolve(UPLOAD_DIR, att.stored_name);
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'The stored file is no longer available.' });
  res.download(filePath, att.file_name || 'attachment');
});

// Manual sync trigger, plus the state of each mailbox.
router.post('/sync', requirePermission('emails', 'view'), async (req, res) => {
  try {
    const results = req.body?.account_id
      ? [await syncAccount(req.body.account_id)]
      : await syncAll();
    if (results.length === 0) {
      return res.status(400).json({ error: 'No mailbox has inbound enabled. Turn it on in Settings → Email.' });
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sync/status', requirePermission('emails', 'view'), (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, a.from_email, a.imap_host, a.inbound_enabled
    FROM email_accounts a LEFT JOIN email_sync_state s ON s.account_id = a.id
    WHERE a.inbound_enabled=1`).all());
});

module.exports = router;
