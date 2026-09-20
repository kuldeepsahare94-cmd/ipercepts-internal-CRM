const express = require('express');
const router = express.Router();
const db = require('../db');
const { relatedActivity } = require('../services/relatedActivity');
const { requirePermission } = require('../middleware/auth');
const { fireWorkflows } = require('../services/workflowAutomation');

router.get('/', requirePermission('contacts', 'view'), (req, res) => {
  const { account_id, status, owner_id, q } = req.query;
  let sql = `SELECT c.*, a.account_name FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id WHERE 1=1`;
  const params = [];
  if (account_id) { sql += ' AND c.account_id = ?'; params.push(account_id); }
  if (status) { sql += ' AND c.contact_status = ?'; params.push(status); }
  if (owner_id) { sql += ' AND c.owner_id = ?'; params.push(owner_id); }
  if (q) { sql += ' AND (c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.mobile LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY c.first_name';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requirePermission('contacts', 'view'), (req, res) => {
  const contact = db.prepare(`
    SELECT c.*, a.account_name FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id WHERE c.id=?
  `).get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const opportunities = db.prepare('SELECT * FROM opportunities WHERE primary_contact_id=? ORDER BY created_at DESC').all(req.params.id);
  const quotations = db.prepare('SELECT * FROM quotations WHERE contact_id=? ORDER BY quote_date DESC').all(req.params.id);
  const tickets = db.prepare('SELECT * FROM tickets WHERE contact_id=? ORDER BY created_at DESC').all(req.params.id);
  res.json({ ...contact, opportunities, quotations, tickets, ...relatedActivity('contacts', req.params.id) });
});

router.post('/', requirePermission('contacts', 'create'), (req, res) => {
  const b = req.body;
  if (!b.first_name) return res.status(400).json({ error: 'first_name is required' });
  const info = db.prepare(`
    INSERT INTO contacts (
      salutation, first_name, middle_name, last_name, job_title, department, account_id, email, secondary_email, phone, mobile,
      whatsapp, linkedin, website, date_of_birth, country, state, city, address, postal_code, contact_type, contact_status,
      owner_id, team, lead_source, tags, notes, last_contacted, next_followup
    ) VALUES (@salutation, @first_name, @middle_name, @last_name, @job_title, @department, @account_id, @email, @secondary_email, @phone, @mobile,
      @whatsapp, @linkedin, @website, @date_of_birth, @country, @state, @city, @address, @postal_code, @contact_type, @contact_status,
      @owner_id, @team, @lead_source, @tags, @notes, @last_contacted, @next_followup)
  `).run({
    salutation: null, middle_name: null, last_name: null, job_title: null, department: null, account_id: null, email: null,
    secondary_email: null, phone: null, mobile: null, whatsapp: null, linkedin: null, website: null, date_of_birth: null,
    country: null, state: null, city: null, address: null, postal_code: null, contact_type: null,
    contact_status: 'Active', owner_id: null, team: null, lead_source: null, tags: null, notes: null, last_contacted: null,
    next_followup: null,
    ...b,
  });
  const created = db.prepare('SELECT * FROM contacts WHERE id=?').get(info.lastInsertRowid);
  fireWorkflows('contacts', 'record_created', created, null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM contacts WHERE id=?').get(created.id));
});

router.put('/:id', requirePermission('contacts', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM contacts WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  db.prepare(`
    UPDATE contacts SET salutation=?, first_name=?, middle_name=?, last_name=?, job_title=?, department=?, account_id=?, email=?,
      secondary_email=?, phone=?, mobile=?, whatsapp=?, linkedin=?, website=?, date_of_birth=?, country=?, state=?, city=?,
      address=?, postal_code=?, contact_type=?, contact_status=?, owner_id=?, team=?, lead_source=?, tags=?, notes=?,
      last_contacted=?, next_followup=?, updated_at=datetime('now')
    WHERE id=?
  `).run(m.salutation, m.first_name, m.middle_name, m.last_name, m.job_title, m.department, m.account_id, m.email, m.secondary_email,
    m.phone, m.mobile, m.whatsapp, m.linkedin, m.website, m.date_of_birth, m.country, m.state, m.city, m.address, m.postal_code,
    m.contact_type, m.contact_status, m.owner_id, m.team, m.lead_source, m.tags, m.notes, m.last_contacted, m.next_followup,
    req.params.id);
  const updated = db.prepare('SELECT * FROM contacts WHERE id=?').get(req.params.id);
  fireWorkflows('contacts', 'record_updated', updated, existing, req.user.id);
  fireWorkflows('contacts', 'field_changed', updated, existing, req.user.id);
  res.json(db.prepare('SELECT * FROM contacts WHERE id=?').get(req.params.id));
});

router.delete('/:id', requirePermission('contacts', 'delete'), (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
