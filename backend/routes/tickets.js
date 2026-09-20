const express = require('express');
const router = express.Router();
const db = require('../db');
const { relatedActivity } = require('../services/relatedActivity');
const { requirePermission } = require('../middleware/auth');
const { fireEvent } = require('../services/whatsapp/workflowEngine');
const { fireWorkflows } = require('../services/workflowAutomation');

function resolveMobile(accountId, contactId) {
  if (contactId) {
    const c = db.prepare('SELECT whatsapp, mobile FROM contacts WHERE id=?').get(contactId);
    if (c) return c.whatsapp || c.mobile || null;
  }
  if (accountId) {
    const a = db.prepare('SELECT whatsapp, phone FROM accounts WHERE id=?').get(accountId);
    if (a) return a.whatsapp || a.phone || null;
  }
  return null;
}

function nextTicketNumber() {
  const count = db.prepare('SELECT COUNT(*) c FROM tickets').get().c;
  return `TKT-${String(count + 1).padStart(5, '0')}`;
}

const OPEN_STATUSES = ['New', 'Open', 'Pending', 'Waiting for Customer', 'In Progress'];

router.get('/', requirePermission('tickets', 'view'), (req, res) => {
  const { account_id, status, priority, assigned_agent_id, q } = req.query;
  let sql = `SELECT t.*, a.account_name,
      CASE WHEN t.sla_due_at IS NOT NULL AND t.sla_due_at < datetime('now') AND t.status NOT IN ('Resolved','Closed')
           THEN 1 ELSE 0 END AS sla_breached,
      CASE WHEN t.first_response_at IS NOT NULL THEN CAST((julianday(t.first_response_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS first_response_minutes,
      CASE WHEN t.resolved_at IS NOT NULL THEN CAST((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS resolution_minutes
    FROM tickets t LEFT JOIN accounts a ON a.id = t.account_id WHERE 1=1`;
  const params = [];
  if (account_id) { sql += ' AND t.account_id = ?'; params.push(account_id); }
  if (status) { sql += ' AND t.status = ?'; params.push(status); }
  if (priority) { sql += ' AND t.priority = ?'; params.push(priority); }
  if (assigned_agent_id) { sql += ' AND t.assigned_agent_id = ?'; params.push(assigned_agent_id); }
  if (q) { sql += ' AND (t.subject LIKE ? OR t.ticket_number LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY t.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Kanban board grouped by status (Tickets don't use the configurable
// pipeline engine like Opportunities — a fixed helpdesk status list matches
// the master prompt's spec and the rest of this codebase's simpler
// TEXT-status convention, e.g. admissions/companies).
router.get('/kanban', requirePermission('tickets', 'view'), (req, res) => {
  const statuses = ['New', 'Open', 'Pending', 'Waiting for Customer', 'In Progress', 'Resolved', 'Closed'];
  const byStatus = db.prepare(`
    SELECT t.*, a.account_name,
      CASE WHEN t.first_response_at IS NOT NULL THEN CAST((julianday(t.first_response_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS first_response_minutes,
      CASE WHEN t.resolved_at IS NOT NULL THEN CAST((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS resolution_minutes
    FROM tickets t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.status=? ORDER BY t.updated_at DESC
  `);
  res.json(statuses.map((status) => ({ status, cards: byStatus.all(status) })));
});

router.get('/:id', requirePermission('tickets', 'view'), (req, res) => {
  const ticket = db.prepare(`
    SELECT t.*, a.account_name, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name,
      CASE WHEN t.first_response_at IS NOT NULL THEN CAST((julianday(t.first_response_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS first_response_minutes,
      CASE WHEN t.resolved_at IS NOT NULL THEN CAST((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS resolution_minutes
    FROM tickets t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.id=?
  `).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const replies = db.prepare('SELECT * FROM ticket_replies WHERE ticket_id=? ORDER BY created_at').all(req.params.id);
  res.json({ ...ticket, replies, ...relatedActivity('tickets', req.params.id) });
});

router.post('/', requirePermission('tickets', 'create'), (req, res) => {
  const b = req.body;
  if (!b.subject) return res.status(400).json({ error: 'subject is required' });
  const info = db.prepare(`
    INSERT INTO tickets (
      ticket_number, subject, account_id, contact_id, email, phone, category, subcategory, priority, status,
      source, assigned_agent_id, team, sla_due_at, sla_tier, description, tags, attachments
    ) VALUES (@ticket_number, @subject, @account_id, @contact_id, @email, @phone, @category, @subcategory, @priority, @status,
      @source, @assigned_agent_id, @team, @sla_due_at, @sla_tier, @description, @tags, @attachments)
  `).run({
    ticket_number: b.ticket_number || nextTicketNumber(),
    account_id: null, contact_id: null, email: null, phone: null, category: null, subcategory: null,
    priority: 'Medium', status: 'New', source: null, assigned_agent_id: null, team: null, sla_due_at: null, sla_tier: null,
    description: null, tags: null, attachments: null,
    ...b,
  });
  const created = db.prepare('SELECT * FROM tickets WHERE id=?').get(info.lastInsertRowid);
  const account = created.account_id && db.prepare('SELECT account_name FROM accounts WHERE id=?').get(created.account_id);
  fireEvent('ticket_created', {
    entityType: 'ticket', entityId: created.id, mobile: resolveMobile(created.account_id, created.contact_id),
    fields: { ticket_number: created.ticket_number, subject: created.subject, priority: created.priority, account_name: account?.account_name || '' },
  });
  fireWorkflows('tickets', 'record_created', created, null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM tickets WHERE id=?').get(created.id));
});

router.put('/:id', requirePermission('tickets', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  const resolvedAt = (m.status === 'Resolved' && existing.status !== 'Resolved') ? new Date().toISOString() : m.resolved_at;
  const closedAt = (m.status === 'Closed' && existing.status !== 'Closed') ? new Date().toISOString() : m.closed_at;

  db.prepare(`
    UPDATE tickets SET subject=?, account_id=?, contact_id=?, email=?, phone=?, category=?, subcategory=?, priority=?,
      status=?, source=?, assigned_agent_id=?, team=?, sla_due_at=?, sla_tier=?, description=?, tags=?, attachments=?,
      resolved_at=?, closed_at=?, resolution=?, updated_at=datetime('now')
    WHERE id=?
  `).run(m.subject, m.account_id, m.contact_id, m.email, m.phone, m.category, m.subcategory, m.priority, m.status,
    m.source, m.assigned_agent_id, m.team, m.sla_due_at, m.sla_tier, m.description, m.tags, m.attachments,
    resolvedAt, closedAt, m.resolution, req.params.id);
  const updated = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (m.status === 'Resolved' && existing.status !== 'Resolved') {
    fireEvent('ticket_resolved', {
      entityType: 'ticket', entityId: updated.id, mobile: resolveMobile(updated.account_id, updated.contact_id),
      fields: { ticket_number: updated.ticket_number, subject: updated.subject, resolution: updated.resolution || '' },
    });
  }
  fireWorkflows('tickets', 'record_updated', updated, existing, req.user.id);
  fireWorkflows('tickets', 'field_changed', updated, existing, req.user.id);
  res.json(db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id));
});

// Body: { body, is_internal }
router.post('/:id/replies', requirePermission('tickets', 'edit'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  if (!b.body) return res.status(400).json({ error: 'body is required' });
  const info = db.prepare('INSERT INTO ticket_replies (ticket_id, is_internal, body, created_by) VALUES (?,?,?,?)')
    .run(req.params.id, b.is_internal ? 1 : 0, b.body, req.user.id);

  // First customer-visible reply sets first_response_at, matching the SLA fields in the spec.
  if (!b.is_internal && !ticket.first_response_at) {
    db.prepare(`UPDATE tickets SET first_response_at=datetime('now') WHERE id=?`).run(req.params.id);
  }
  res.status(201).json(db.prepare('SELECT * FROM ticket_replies WHERE id=?').get(info.lastInsertRowid));
});

router.delete('/:id', requirePermission('tickets', 'delete'), (req, res) => {
  db.prepare('DELETE FROM tickets WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
