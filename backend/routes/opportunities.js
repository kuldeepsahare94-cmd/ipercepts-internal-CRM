const express = require('express');
const router = express.Router();
const db = require('../db');
const { relatedActivity } = require('../services/relatedActivity');
const { requirePermission } = require('../middleware/auth');
const { fireEvent } = require('../services/whatsapp/workflowEngine');
const { fireWorkflows } = require('../services/workflowAutomation');

// Best-effort contact number for WhatsApp workflow events — prefer the
// linked Contact's number, fall back to the Account's.
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

function opportunityFields(opp) {
  const account = opp.account_id && db.prepare('SELECT account_name FROM accounts WHERE id=?').get(opp.account_id);
  const contact = opp.primary_contact_id && db.prepare("SELECT first_name || ' ' || COALESCE(last_name,'') AS name FROM contacts WHERE id=?").get(opp.primary_contact_id);
  return {
    opportunity_name: opp.opportunity_name, account_name: account?.account_name || '', contact_name: contact?.name || '',
    amount: opp.amount, expected_close_date: opp.expected_close_date,
  };
}

// Fires opportunity_stage_changed, plus opportunity_won/opportunity_lost if the
// new stage is flagged as a won/lost stage — called from every place an
// opportunity's stage_id changes, so all three stay in sync automatically.
function fireStageChangeEvents(opp, fromStageId, toStageId, userId) {
  const fromStage = fromStageId && db.prepare('SELECT * FROM module_pipeline_stages WHERE id=?').get(fromStageId);
  const toStage = db.prepare('SELECT * FROM module_pipeline_stages WHERE id=?').get(toStageId);
  const mobile = resolveMobile(opp.account_id, opp.primary_contact_id);
  const base = opportunityFields(opp);
  fireEvent('opportunity_stage_changed', { entityType: 'opportunity', entityId: opp.id, mobile, fields: { ...base, from_stage: fromStage?.name || '', to_stage: toStage?.name || '' } });
  if (toStage?.is_won) fireEvent('opportunity_won', { entityType: 'opportunity', entityId: opp.id, mobile, fields: base });
  if (toStage?.is_lost) fireEvent('opportunity_lost', { entityType: 'opportunity', entityId: opp.id, mobile, fields: { ...base, lost_reason: opp.lost_reason || '' } });
}

function defaultPipeline() {
  return db.prepare(`
    SELECT p.* FROM module_pipelines p
    JOIN modules m ON m.id = p.module_id
    WHERE m.api_name='opportunities' AND p.is_default=1
  `).get();
}

router.get('/', requirePermission('opportunities', 'view'), (req, res) => {
  const { account_id, stage_id, owner_id, q } = req.query;
  let sql = `
    SELECT o.*, a.account_name, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name,
      s.name AS stage_name, s.color AS stage_color, s.is_won, s.is_lost
    FROM opportunities o
    LEFT JOIN accounts a ON a.id = o.account_id
    LEFT JOIN contacts c ON c.id = o.primary_contact_id
    LEFT JOIN module_pipeline_stages s ON s.id = o.stage_id
    WHERE 1=1`;
  const params = [];
  if (account_id) { sql += ' AND o.account_id = ?'; params.push(account_id); }
  if (stage_id) { sql += ' AND o.stage_id = ?'; params.push(stage_id); }
  if (owner_id) { sql += ' AND o.owner_id = ?'; params.push(owner_id); }
  if (q) { sql += ' AND o.opportunity_name LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY o.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Kanban board: every active stage of the default pipeline, with its cards
// and a running total — matches the master prompt's "show stage totals and
// pipeline value" requirement.
router.get('/kanban', requirePermission('opportunities', 'view'), (req, res) => {
  const pipeline = defaultPipeline();
  if (!pipeline) return res.json({ stages: [] });
  const stages = db.prepare('SELECT * FROM module_pipeline_stages WHERE pipeline_id=? AND active=1 ORDER BY sort_order').all(pipeline.id);
  const cardsByStage = db.prepare(`
    SELECT o.*, a.account_name, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name
    FROM opportunities o
    LEFT JOIN accounts a ON a.id = o.account_id
    LEFT JOIN contacts c ON c.id = o.primary_contact_id
    WHERE o.stage_id = ? ORDER BY o.updated_at DESC
  `);
  const result = stages.map((stage) => {
    const cards = cardsByStage.all(stage.id);
    const total = cards.reduce((sum, c) => sum + (c.amount || 0), 0);
    const weighted = cards.reduce((sum, c) => sum + (c.amount || 0) * ((c.probability ?? stage.probability ?? 0) / 100), 0);
    return { stage, cards, total, weighted };
  });
  res.json({ pipeline, stages: result });
});

router.get('/:id', requirePermission('opportunities', 'view'), (req, res) => {
  // An opportunity has no phone or email of its own — the people you
  // actually call live on the linked account and contact. The detail
  // endpoint returned only `account_name`, so the record gave you a deal
  // to work and no way to reach anyone about it without navigating away.
  // Pulled in here so the header can offer call/email/WhatsApp directly.
  const opp = db.prepare(`
    SELECT o.*,
      a.account_name, a.phone AS account_phone, a.email AS account_email,
      a.city AS account_city, a.industry AS account_industry,
      c.first_name AS contact_first_name, c.last_name AS contact_last_name,
      c.job_title AS contact_job_title,
      COALESCE(c.mobile, c.phone) AS contact_phone, c.email AS contact_email,
      s.name AS stage_name, s.color AS stage_color,
      COALESCE(s.is_won, 0) AS stage_is_won, COALESCE(s.is_lost, 0) AS stage_is_lost,
      COALESCE(u.full_name, u.username) AS owner_name
    FROM opportunities o
    LEFT JOIN accounts a ON a.id = o.account_id
    LEFT JOIN contacts c ON c.id = o.primary_contact_id
    LEFT JOIN module_pipeline_stages s ON s.id = o.stage_id
    LEFT JOIN users u ON u.id = o.owner_id
    WHERE o.id=?
  `).get(req.params.id);
  if (!opp) return res.status(404).json({ error: 'Not found' });
  const quotations = db.prepare('SELECT * FROM quotations WHERE opportunity_id=? ORDER BY quote_date DESC').all(req.params.id);
  const stageHistory = db.prepare(`
    SELECT h.*, fs.name AS from_stage_name, ts.name AS to_stage_name FROM opportunity_stage_history h
    LEFT JOIN module_pipeline_stages fs ON fs.id = h.from_stage_id
    LEFT JOIN module_pipeline_stages ts ON ts.id = h.to_stage_id
    WHERE h.opportunity_id=? ORDER BY h.changed_at DESC
  `).all(req.params.id);
  res.json({ ...opp, quotations, stageHistory, ...relatedActivity('opportunities', req.params.id) });
});

router.post('/', requirePermission('opportunities', 'create'), (req, res) => {
  const b = req.body;
  if (!b.opportunity_name) return res.status(400).json({ error: 'opportunity_name is required' });

  let stageId = b.stage_id || null;
  let pipelineId = b.pipeline_id || null;
  if (!stageId) {
    const pipeline = defaultPipeline();
    if (pipeline) {
      pipelineId = pipeline.id;
      const firstStage = db.prepare('SELECT id, probability FROM module_pipeline_stages WHERE pipeline_id=? ORDER BY sort_order LIMIT 1').get(pipeline.id);
      if (firstStage) { stageId = firstStage.id; if (b.probability == null) b.probability = firstStage.probability; }
    }
  }

  const info = db.prepare(`
    INSERT INTO opportunities (
      opportunity_name, account_id, primary_contact_id, pipeline_id, stage_id, opportunity_type, lead_source,
      owner_id, team, amount, currency, probability, expected_close_date, next_step, product_service, competitor,
      description, lost_reason, tags
    ) VALUES (@opportunity_name, @account_id, @primary_contact_id, @pipeline_id, @stage_id, @opportunity_type, @lead_source,
      @owner_id, @team, @amount, @currency, @probability, @expected_close_date, @next_step, @product_service, @competitor,
      @description, @lost_reason, @tags)
  `).run({
    account_id: null, primary_contact_id: null, opportunity_type: null, lead_source: null, owner_id: null, team: null,
    amount: 0, currency: 'INR', probability: null, expected_close_date: null, next_step: null, product_service: null,
    competitor: null, description: null, lost_reason: null, tags: null,
    ...b,
    pipeline_id: pipelineId, stage_id: stageId,
  });
  if (stageId) {
    db.prepare('INSERT INTO opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, changed_by) VALUES (?,?,?,?)')
      .run(info.lastInsertRowid, null, stageId, req.user.id);
  }
  const created = db.prepare('SELECT * FROM opportunities WHERE id=?').get(info.lastInsertRowid);
  const mobile = resolveMobile(created.account_id, created.primary_contact_id);
  fireEvent('opportunity_created', { entityType: 'opportunity', entityId: created.id, mobile, fields: { ...opportunityFields(created), stage: db.prepare('SELECT name FROM module_pipeline_stages WHERE id=?').get(created.stage_id)?.name || '' } });
  fireWorkflows('opportunities', 'record_created', created, null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM opportunities WHERE id=?').get(created.id));
});

router.put('/:id', requirePermission('opportunities', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM opportunities WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  const stageChanged = req.body.stage_id != null && req.body.stage_id !== existing.stage_id;

  db.prepare(`
    UPDATE opportunities SET opportunity_name=?, account_id=?, primary_contact_id=?, pipeline_id=?, stage_id=?,
      opportunity_type=?, lead_source=?, owner_id=?, team=?, amount=?, currency=?, probability=?, expected_close_date=?,
      next_step=?, product_service=?, competitor=?, description=?, lost_reason=?, tags=?, updated_at=datetime('now')
    WHERE id=?
  `).run(m.opportunity_name, m.account_id, m.primary_contact_id, m.pipeline_id, m.stage_id, m.opportunity_type,
    m.lead_source, m.owner_id, m.team, m.amount, m.currency, m.probability, m.expected_close_date, m.next_step,
    m.product_service, m.competitor, m.description, m.lost_reason, m.tags, req.params.id);

  if (stageChanged) {
    db.prepare('INSERT INTO opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, changed_by) VALUES (?,?,?,?)')
      .run(req.params.id, existing.stage_id, req.body.stage_id, req.user.id);
    fireStageChangeEvents(db.prepare('SELECT * FROM opportunities WHERE id=?').get(req.params.id), existing.stage_id, req.body.stage_id, req.user.id);
  }
  const updatedOpp = db.prepare('SELECT * FROM opportunities WHERE id=?').get(req.params.id);
  fireWorkflows('opportunities', 'record_updated', updatedOpp, existing, req.user.id);
  fireWorkflows('opportunities', 'field_changed', updatedOpp, existing, req.user.id);
  // Re-fetch: a workflow's update_field action may have just changed this
  // same record (e.g. auto-setting next_step) — the response must reflect
  // that, not the pre-workflow snapshot.
  res.json(db.prepare('SELECT * FROM opportunities WHERE id=?').get(req.params.id));
});

// Dedicated endpoint for the drag-and-drop Kanban move, so the frontend
// doesn't need to PUT the whole record just to change stage.
router.put('/:id/stage', requirePermission('opportunities', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM opportunities WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { stage_id } = req.body;
  if (!stage_id) return res.status(400).json({ error: 'stage_id is required' });
  const stage = db.prepare('SELECT * FROM module_pipeline_stages WHERE id=?').get(stage_id);
  if (!stage) return res.status(404).json({ error: 'Stage not found' });

  const requiredFields = JSON.parse(stage.required_fields_json || '[]');
  const missing = requiredFields.filter((f) => !existing[f] && !req.body[f]);
  if (missing.length) return res.status(400).json({ error: `Missing required fields for this stage: ${missing.join(', ')}` });

  db.prepare(`UPDATE opportunities SET stage_id=?, probability=?, updated_at=datetime('now') WHERE id=?`)
    .run(stage_id, stage.probability ?? existing.probability, req.params.id);
  db.prepare('INSERT INTO opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, changed_by) VALUES (?,?,?,?)')
    .run(req.params.id, existing.stage_id, stage_id, req.user.id);
  fireStageChangeEvents(db.prepare('SELECT * FROM opportunities WHERE id=?').get(req.params.id), existing.stage_id, stage_id, req.user.id);
  const afterStageMove = db.prepare('SELECT * FROM opportunities WHERE id=?').get(req.params.id);
  fireWorkflows('opportunities', 'record_updated', afterStageMove, existing, req.user.id);
  fireWorkflows('opportunities', 'field_changed', afterStageMove, existing, req.user.id);
  res.json(db.prepare('SELECT * FROM opportunities WHERE id=?').get(req.params.id));
});

router.delete('/:id', requirePermission('opportunities', 'delete'), (req, res) => {
  db.prepare('DELETE FROM opportunities WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
