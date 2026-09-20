const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { fireEvent } = require('../services/whatsapp/workflowEngine');
const { fireWorkflows } = require('../services/workflowAutomation');
const { computeLeadScore } = require('../services/leadScore');

router.get('/', requirePermission('leads', 'view'), (req, res) => {
  const { status, source, counselor, q } = req.query;
  let sql = `SELECT l.*, c.course_name AS interested_course_name FROM leads l
    LEFT JOIN courses c ON c.id = l.interested_course_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND l.status = ?'; params.push(status); }
  if (source) { sql += ' AND l.source = ?'; params.push(source); }
  if (counselor) { sql += ' AND l.assigned_counselor = ?'; params.push(counselor); }
  if (q) { sql += ' AND (l.student_name LIKE ? OR l.mobile LIKE ? OR l.email LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY l.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requirePermission('leads', 'view'), (req, res) => {
  const lead = db.prepare(`SELECT l.*, c.course_name AS interested_course_name FROM leads l
    LEFT JOIN courses c ON c.id = l.interested_course_id WHERE l.id=?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const activities = db.prepare('SELECT * FROM lead_activities WHERE lead_id=? ORDER BY created_at DESC').all(req.params.id);
  const { score, label } = computeLeadScore(lead, activities.length);
  res.json({ ...lead, activities, lead_score: score, lead_score_label: label });
});

router.post('/', requirePermission('leads', 'create'), (req, res) => {
  const b = req.body;
  if (!b.student_name) return res.status(400).json({ error: 'student_name is required' });
  const info = db.prepare(`
    INSERT INTO leads (student_name, account_name, mobile, alternate_mobile, email, gender, date_of_birth, address, city,
      qualification, source, interested_course_id, status, follow_up_date, assigned_counselor, remarks,
      lead_rating, lead_score, campaign, product_interest, service_interest)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    b.student_name, b.account_name || null, b.mobile || null, b.alternate_mobile || null, b.email || null, b.gender || null,
    b.date_of_birth || null, b.address || null, b.city || null, b.qualification || null, b.source || null,
    b.interested_course_id || null, b.status || 'New', b.follow_up_date || null, b.assigned_counselor || null, b.remarks || null,
    b.lead_rating || null, b.lead_score ?? null, b.campaign || null, b.product_interest || null, b.service_interest || null
  );
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(info.lastInsertRowid);
  const leadFields = { student_name: lead.student_name, mobile: lead.mobile, source: lead.source, city: lead.city, assigned_counselor: lead.assigned_counselor, status: lead.status, follow_up_date: lead.follow_up_date };
  fireEvent('lead_created', { entityType: 'lead', entityId: lead.id, mobile: lead.mobile, fields: leadFields });
  if (lead.assigned_counselor) fireEvent('lead_assigned', { entityType: 'lead', entityId: lead.id, mobile: lead.mobile, fields: leadFields });
  if (lead.follow_up_date) fireEvent('follow_up_scheduled', { entityType: 'lead', entityId: lead.id, mobile: lead.mobile, fields: leadFields });
  res.status(201).json(lead);
});

router.put('/:id', requirePermission('leads', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  db.prepare(`
    UPDATE leads SET student_name=?, account_name=?, mobile=?, alternate_mobile=?, email=?, gender=?, date_of_birth=?, address=?, city=?,
      qualification=?, source=?, interested_course_id=?, status=?, follow_up_date=?, assigned_counselor=?, remarks=?,
      lead_rating=?, lead_score=?, campaign=?, product_interest=?, service_interest=?
    WHERE id=?
  `).run(
    m.student_name, m.account_name, m.mobile, m.alternate_mobile, m.email, m.gender, m.date_of_birth, m.address, m.city,
    m.qualification, m.source, m.interested_course_id, m.status, m.follow_up_date, m.assigned_counselor, m.remarks,
    m.lead_rating, m.lead_score, m.campaign, m.product_interest, m.service_interest,
    req.params.id
  );
  if (req.body.status && req.body.status !== existing.status) {
    db.prepare('INSERT INTO lead_activities (lead_id, type, note) VALUES (?,?,?)')
      .run(req.params.id, 'status_change', `${existing.status} → ${req.body.status}`);
  }
  if (req.body.follow_up_date && req.body.follow_up_date !== existing.follow_up_date) {
    db.prepare('INSERT INTO lead_activities (lead_id, type, note) VALUES (?,?,?)')
      .run(req.params.id, 'schedule', `Follow-up scheduled for ${req.body.follow_up_date}`);
  }
  const updated = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  const leadFields = { student_name: updated.student_name, mobile: updated.mobile, source: updated.source, city: updated.city, assigned_counselor: updated.assigned_counselor, status: updated.status, follow_up_date: updated.follow_up_date };
  if (req.body.status && req.body.status !== existing.status) fireEvent('lead_status_changed', { entityType: 'lead', entityId: updated.id, mobile: updated.mobile, fields: leadFields });
  if (req.body.assigned_counselor && req.body.assigned_counselor !== existing.assigned_counselor) fireEvent('lead_assigned', { entityType: 'lead', entityId: updated.id, mobile: updated.mobile, fields: leadFields });
  if (req.body.follow_up_date && req.body.follow_up_date !== existing.follow_up_date) fireEvent('follow_up_scheduled', { entityType: 'lead', entityId: updated.id, mobile: updated.mobile, fields: leadFields });
  res.json(updated);
});

router.delete('/:id', requirePermission('leads', 'delete'), (req, res) => {
  db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  res.status(204).end();
});

router.post('/:id/activities', requirePermission('leads', 'edit'), (req, res) => {
  const { type, note, created_by } = req.body;
  const info = db.prepare('INSERT INTO lead_activities (lead_id, type, note, created_by) VALUES (?,?,?,?)')
    .run(req.params.id, type || 'note', note || '', created_by || null);
  res.status(201).json(db.prepare('SELECT * FROM lead_activities WHERE id=?').get(info.lastInsertRowid));
});

// ===== Lead -> Contact/Account/Opportunity conversion =====
// Lead history stays intact: the lead row is kept, only its converted_*
// columns get set. This replaces the old Lead -> Student conversion (which
// only made sense for the placement/education vertical) with the standard
// CRM relationship model from the master prompt: Lead -> Contact -> Account
// -> Opportunity. Optional body: { account_name } to name the Account
// something other than the lead's own name (e.g. their actual company).
router.post('/:id/convert', requirePermission('leads', 'edit'), (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.converted_contact_id) {
    return res.status(400).json({ error: 'Lead already converted', contact_id: lead.converted_contact_id });
  }

  // ---- Account name: the COMPANY, never the person -----------------------
  // This used to fall back to lead.student_name, and the UI sent no body at
  // all, so every converted Account was named after the contact person —
  // "Adarsh Kashyap" instead of "Smart Business Solution". An Account is an
  // organisation; naming it after a person makes the record meaningless and
  // is painful to unpick later.
  //
  // Whichever column this install uses for the lead's company is checked in
  // turn; `account_name` is what the CSV importer creates.
  const firstNonEmpty = (...vals) => {
    for (const v of vals) {
      const s = v === null || v === undefined ? '' : String(v).trim();
      if (s) return s;
    }
    return '';
  };

  const leadCompany = firstNonEmpty(
    lead.account_name, lead.company_name, lead.company,
    lead.organisation, lead.organization,
  );
  const accountName = firstNonEmpty(req.body?.account_name, leadCompany);

  if (!accountName) {
    return res.status(400).json({
      error: 'An account (customer) name is required to convert this lead.',
      reason: 'This lead has no company name on it, so there is nothing to name the Account after. '
            + 'Add the company to the lead, or supply account_name with the request.',
      field: 'account_name',
    });
  }

  const tx = db.transaction(() => {
    // Two leads from the same company should join one Account, not create
    // two identical ones.
    const existingAccount = db.prepare('SELECT id FROM accounts WHERE LOWER(TRIM(account_name)) = LOWER(TRIM(?))')
      .get(accountName);

    let accountId;
    let accountReused = false;
    if (existingAccount) {
      accountId = existingAccount.id;
      accountReused = true;
    } else {
      accountId = db.prepare(`INSERT INTO accounts (account_name, city, lead_source, status) VALUES (?,?,?,'Active')`)
        .run(accountName, lead.city || null, lead.source || null).lastInsertRowid;
    }

    // Person name. The two sources (the first_name/last_name columns, and
    // splitting the single display name) must not be mixed: taking the first
    // name from a split while taking the last name from the column produced
    // "Adarsh Adarsh Kashyap" for a lead whose last_name column held the
    // whole name. Pick one source, then split within it if needed.
    let firstName;
    let lastName;

    if (firstNonEmpty(lead.first_name, lead.last_name)) {
      firstName = firstNonEmpty(lead.first_name);
      lastName = firstNonEmpty(lead.last_name);

      // Imported files often put the full name in one column and leave the
      // other blank.
      if (!firstName && lastName.includes(' ')) {
        const parts = lastName.split(/\s+/).filter(Boolean);
        firstName = parts[0];
        lastName = parts.slice(1).join(' ');
      } else if (!firstName) {
        firstName = lastName;      // single-word name
        lastName = '';
      }
    } else {
      const parts = (lead.student_name || '').trim().split(/\s+/).filter(Boolean);
      firstName = parts[0] || lead.student_name;
      lastName = parts.slice(1).join(' ');
    }

    const contactInfo = db.prepare(`
      INSERT INTO contacts (first_name, last_name, account_id, email, mobile, city, lead_source, contact_status)
      VALUES (?,?,?,?,?,?,?,'Active')
    `).run(firstName, lastName || null, accountId,
      lead.email || null, lead.mobile || null, lead.city || null, lead.source || null);
    const contactId = contactInfo.lastInsertRowid;

    const pipeline = db.prepare(`
      SELECT p.* FROM module_pipelines p JOIN modules m ON m.id=p.module_id WHERE m.api_name='opportunities' AND p.is_default=1
    `).get();
    const firstStage = pipeline && db.prepare('SELECT * FROM module_pipeline_stages WHERE pipeline_id=? ORDER BY sort_order LIMIT 1').get(pipeline.id);
    const oppName = lead.product_interest ? `${accountName} — ${lead.product_interest}` : `${accountName} — New Opportunity`;
    const oppInfo = db.prepare(`
      INSERT INTO opportunities (opportunity_name, account_id, primary_contact_id, pipeline_id, stage_id, lead_source, probability)
      VALUES (?,?,?,?,?,?,?)
    `).run(oppName, accountId, contactId, pipeline?.id || null, firstStage?.id || null, lead.source || null, firstStage?.probability ?? null);
    const opportunityId = oppInfo.lastInsertRowid;
    if (firstStage) db.prepare('INSERT INTO opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id) VALUES (?,?,?)').run(opportunityId, null, firstStage.id);

    db.prepare(`UPDATE leads SET status=?, converted_contact_id=?, converted_account_id=?, converted_opportunity_id=?, converted_at=datetime('now') WHERE id=?`)
      .run('Converted', contactId, accountId, opportunityId, lead.id);
    db.prepare('INSERT INTO lead_activities (lead_id, type, note) VALUES (?,?,?)')
      .run(lead.id, 'status_change', `Converted to Contact #${contactId} / Account #${accountId} / Opportunity #${opportunityId}`);

    return { contactId, accountId, opportunityId, accountReused };
  });

  const { contactId, accountId, opportunityId, accountReused } = tx();
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  const opportunity = db.prepare('SELECT * FROM opportunities WHERE id=?').get(opportunityId);

  fireEvent('welcome_message', { entityType: 'contact', entityId: contactId, mobile: contact.mobile, fields: { student_name: contact.first_name + ' ' + (contact.last_name || ''), mobile: contact.mobile, email: contact.email } });
  fireWorkflows('contacts', 'record_created', contact, null, req.user.id);
  if (!accountReused) fireWorkflows('accounts', 'record_created', account, null, req.user.id);
  fireWorkflows('opportunities', 'record_created', opportunity, null, req.user.id);

  res.status(201).json({
    contact_id: contactId, account_id: accountId, opportunity_id: opportunityId,
    account_reused: accountReused,   // true when an account of this name already existed
    contact, account, opportunity,
  });
});

module.exports = router;
