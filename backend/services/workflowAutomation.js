// The general (non-WhatsApp) workflow engine — see db-phase16-workflows.js
// for why this is a separate system from the WhatsApp workflow engine.
//
// fireWorkflows() is the single entry point every route calls. It's
// synchronous and swallows its own errors per-workflow (one broken workflow
// must never break the record save that triggered it) — same defensive
// posture as the WhatsApp engine's fireEvent().

const db = require('../db');

function getModule(apiName) {
  return db.prepare('SELECT * FROM modules WHERE api_name=?').get(apiName);
}

function evaluateCondition(record, cond) {
  const actual = record[cond.field];
  const expected = cond.value;
  switch (cond.operator) {
    case 'equals': return String(actual ?? '') === String(expected ?? '');
    case 'not_equals': return String(actual ?? '') !== String(expected ?? '');
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'greater_than': return Number(actual) > Number(expected);
    case 'less_than': return Number(actual) < Number(expected);
    case 'is_empty': return actual === null || actual === undefined || actual === '';
    case 'is_not_empty': return !(actual === null || actual === undefined || actual === '');
    default: return false;
  }
}

// Updates one field on a record, working for both table-backed modules
// (validated against real columns first, so a workflow can never write to a
// column that doesn't exist) and JSON-backed custom modules.
function applyFieldUpdate(module, recordId, field, value) {
  if (module.table_name) {
    const cols = db.prepare(`PRAGMA table_info(${module.table_name})`).all().map((c) => c.name);
    if (!cols.includes(field)) throw new Error(`"${field}" is not a real column on ${module.table_name}`);
    db.prepare(`UPDATE ${module.table_name} SET ${field}=? WHERE id=?`).run(value, recordId);
  } else {
    const svc = require('./metadataService');
    svc.updateCustomRecord(module.id, recordId, { [field]: value }, null);
  }
}

// Creates a record in another module, auto-linking related_module/
// related_record_id when the target has those columns (Calls/Meetings/
// Tasks/Notes/Emails do) — this is what makes "create_record" cover the
// prompt's "create task" / "create activity" action examples without a
// separate action type per target module.
function createLinkedRecord(sourceModule, sourceRecordId, targetModuleApiName, fieldValues) {
  const target = getModule(targetModuleApiName);
  if (!target) throw new Error(`Target module "${targetModuleApiName}" not found`);
  if (target.table_name) {
    const cols = db.prepare(`PRAGMA table_info(${target.table_name})`).all().map((c) => c.name);
    const values = { ...fieldValues };
    if (cols.includes('related_module') && cols.includes('related_record_id')) {
      values.related_module = sourceModule.api_name;
      values.related_record_id = sourceRecordId;
    }
    const columns = Object.keys(values).filter((k) => cols.includes(k));
    const placeholders = columns.map((k) => `@${k}`).join(', ');
    db.prepare(`INSERT INTO ${target.table_name} (${columns.join(', ')}) VALUES (${placeholders})`).run(values);
  } else {
    const svc = require('./metadataService');
    svc.createCustomRecord(target.id, fieldValues, null);
  }
}

function interpolate(template, record) {
  if (!template) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (record[key] ?? ''));
}

function runAction(action, module, record, userId) {
  switch (action.type) {
    case 'update_field':
      applyFieldUpdate(module, record.id, action.config.field, action.config.value);
      return;
    case 'create_record':
      createLinkedRecord(module, record.id, action.config.module, action.config.fields || {});
      return;
    case 'create_notification':
      db.prepare(`INSERT INTO crm_workflow_notifications (workflow_id, user_id, title, message, link) VALUES (?,?,?,?,?)`)
        .run(action.workflow_id || null, action.config.user_id || null, interpolate(action.config.title, record),
          interpolate(action.config.message, record), action.config.link || null);
      return;
    case 'webhook':
      // Fire-and-forget — never let a slow/broken external endpoint block
      // the record save. Node 20's global fetch is available in this
      // runtime; failures are caught and swallowed here specifically
      // (fireWorkflows also wraps the whole action loop, this is belt-
      // and-suspenders since a webhook is the one action reaching outside
      // the process).
      try {
        fetch(action.config.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ module: module.api_name, record_id: record.id, record }),
        }).catch(() => {});
      } catch { /* ignore */ }
      return;
    default:
      throw new Error(`Unknown action type "${action.type}"`);
  }
}

// Records what changed, for the Audit Log (Settings -> Audit Log). Called
// from fireWorkflows because that's already invoked on every module's
// create/update path — hooking here gives complete coverage in one place
// instead of editing 14 route files, and keeps audit and automation in
// step with each other by construction.
//
// Errors are swallowed for the same reason workflow errors are: an audit
// write must never break the record save that triggered it.
function writeAudit(module, eventType, record, previousRecord, userId) {
  try {
    if (eventType === 'record_created') {
      db.prepare(`INSERT INTO module_audit_log (module_id, record_id, user_id, action) VALUES (?,?,?,'created')`)
        .run(module.id, record.id, userId || null);
      return;
    }
    if (eventType !== 'record_updated' || !previousRecord) return;

    // One row per changed field, so the log reads as "who changed what
    // from what to what" rather than an opaque "record updated".
    const skip = new Set(['updated_at', 'created_at']);
    const insert = db.prepare(`
      INSERT INTO module_audit_log (module_id, record_id, user_id, action, field_api_name, old_value, new_value)
      VALUES (?,?,?,'field_changed',?,?,?)
    `);
    let changed = 0;
    for (const key of Object.keys(record)) {
      if (skip.has(key) || typeof record[key] === 'object') continue;
      const before = previousRecord[key];
      const after = record[key];
      if (String(before ?? '') === String(after ?? '')) continue;
      insert.run(module.id, record.id, userId || null, key,
        before === null || before === undefined ? null : String(before),
        after === null || after === undefined ? null : String(after));
      changed++;
    }
    // A save that changed nothing meaningful still gets one row, so the
    // history doesn't silently omit that someone touched the record.
    if (changed === 0) {
      db.prepare(`INSERT INTO module_audit_log (module_id, record_id, user_id, action) VALUES (?,?,?,'updated')`)
        .run(module.id, record.id, userId || null);
    }
  } catch { /* auditing must never break the save */ }
}

function fireWorkflows(moduleApiName, eventType, record, previousRecord, userId) {
  const module = getModule(moduleApiName);
  if (!module) return;

  // Audit first, and only for the two "real change" events —
  // field_changed fires alongside record_updated for workflow-matching
  // purposes, so auditing it too would double-log every edit.
  if (record && record.id != null) writeAudit(module, eventType, record, previousRecord, userId);

  let workflows = db.prepare(`SELECT * FROM crm_workflows WHERE module_id=? AND active=1 AND trigger_type=?`).all(module.id, eventType);
  if (eventType === 'field_changed') {
    workflows = workflows.filter((w) => w.trigger_field && previousRecord
      && String(previousRecord[w.trigger_field] ?? '') !== String(record[w.trigger_field] ?? ''));
  }
  if (workflows.length === 0) return;

  for (const wf of workflows) {
    let conditions = [];
    try { conditions = JSON.parse(wf.conditions_json || '[]'); } catch { /* leave empty */ }
    if (!conditions.every((c) => evaluateCondition(record, c))) continue;

    let actions = [];
    try { actions = JSON.parse(wf.actions_json || '[]'); } catch { /* leave empty */ }
    let executed = 0;
    let error = null;
    try {
      for (const action of actions) {
        runAction({ ...action, workflow_id: wf.id }, module, record, userId);
        executed++;
      }
    } catch (e) {
      error = e.message;
    }
    db.prepare(`INSERT INTO crm_workflow_runs (workflow_id, record_id, status, actions_executed, error) VALUES (?,?,?,?,?)`)
      .run(wf.id, record.id, error ? 'failed' : 'success', executed, error);
  }
}

module.exports = { fireWorkflows, evaluateCondition, applyFieldUpdate, createLinkedRecord };
