// Universal Global Search (master prompt section 18). Searches across every
// enabled module the requesting user has 'view' permission for, grouped by
// module. Three storage shapes exist in this app, so three search paths:
//
//   1. Modules with module_fields metadata (Accounts, Contacts, Calls, ...):
//      search across their real text-like columns, driven by field_type —
//      genuinely metadata-driven, works for a future custom module too.
//   2. Legacy modules with a real table but no module_fields rows yet
//      (Leads, Students, companies_legacy, Courses, Admissions, Placements):
//      a small hardcoded per-table column list, same idea as the original
//      GlobalSearch component this replaces, just centralized server-side.
//   3. Custom (JSON-backed) modules: search their record_name column.
//
// Mount in server.js as: app.use('/api/search', requireAuth, require('./routes/search'));

const express = require('express');
const router = express.Router();
const db = require('../db');

// Field types worth a LIKE match — deliberately narrower than the stored
// `searchable` flag on module_fields (which defaults to 1 for every field
// regardless of type, including numbers/dates/checkboxes — LIKE against
// those produces confusing partial-number matches, not useful search).
const SEARCHABLE_TYPES = new Set(['text', 'email', 'phone', 'url', 'textarea', 'dropdown', 'radio']);

// Legacy tables that predate the module/field metadata layer.
const LEGACY_SEARCH = {
  leads: { columns: ['student_name', 'mobile', 'source'], label: (r) => r.student_name, sub: (r) => r.mobile },
  students: { columns: ['student_name', 'mobile', 'email'], label: (r) => r.student_name, sub: (r) => r.mobile },
  companies_legacy: { table: 'companies', columns: ['company_name', 'industry'], label: (r) => r.company_name, sub: (r) => r.industry },
  courses: { columns: ['course_name'], label: (r) => r.course_name, sub: () => '' },
  admissions: { columns: ['admission_number'], label: (r) => r.admission_number, sub: () => '' },
  placements: { columns: [], label: (r) => `Placement #${r.id}`, sub: () => '' }, // no obvious text column — skipped below
};

function hasView(user, moduleApiName) {
  const perm = user.permissions && user.permissions[moduleApiName];
  return !!(perm && perm.view);
}

// Best-effort "what's the title of this record" for metadata-driven modules
// — mirrors the frontend's recordTitle() heuristic in fieldUtils.jsx, kept
// in sync deliberately so search results read the same as the record's own
// list/detail page.
function pickDisplayField(fields) {
  // A lookup field holds a row id, so it can never be a title. Without this
  // filter a module whose only required field is a lookup would be listed by
  // a bare number.
  const titleWorthy = fields.filter((f) => f.field_type !== 'lookup');
  return titleWorthy.find((f) => ['name', 'title', 'subject'].some((k) => f.api_name.includes(k)))
    || titleWorthy.find((f) => /_(number|code|no)$/.test(f.api_name))
    || titleWorthy.find((f) => f.required)
    || titleWorthy[0];
}

// ===========================================================================
// Lookup pickers — GET /api/search/lookup/:module?q=&ids=
// ===========================================================================
// A `lookup` field stores a row id. Showing that id to a salesperson is
// useless ("Customer: 47"), and typing one is worse, so the form needs a
// picker that searches by name and the detail page needs the name back.
//
// Both directions are served here rather than by each module's own route,
// because the whole point of the metadata layer is that a lookup to a module
// added next year works without new code.
//
// Safety: the table is read from the `modules` registry, never from the URL,
// and column names come from module_fields rows — no request value is ever
// concatenated into SQL. The caller must hold 'view' on the target module,
// so a lookup can't be used to read a module the user isn't allowed to see.

// What to show for a record, and the columns needed to build it. Contacts are
// the case the generic heuristic gets wrong — it matches `first_name` and
// drops the surname, so "Priya Sharma" would display as "Priya".
const LOOKUP_DISPLAY = {
  contacts: {
    columns: ['first_name', 'last_name', 'email', 'job_title'],
    label: (r) => [r.first_name, r.last_name].filter(Boolean).join(' ').trim(),
    sub: (r) => r.job_title || r.email || '',
  },
  accounts: { columns: ['account_name', 'city', 'email'], label: (r) => r.account_name, sub: (r) => r.city || r.email || '' },
  opportunities: { columns: ['opportunity_name', 'amount'], label: (r) => r.opportunity_name, sub: (r) => (r.amount ? `₹${Number(r.amount).toLocaleString('en-IN')}` : '') },
  products: { columns: ['product_name', 'sku', 'selling_price'], label: (r) => r.product_name, sub: (r) => r.sku || '' },
  leads: { columns: ['student_name', 'mobile'], label: (r) => r.student_name, sub: (r) => r.mobile || '' },
};

function lookupConfig(mod) {
  if (LOOKUP_DISPLAY[mod.api_name]) return LOOKUP_DISPLAY[mod.api_name];
  // Anything else — including a module created after this code was written —
  // falls back to the same heuristic the list pages use.
  const fields = db.prepare('SELECT * FROM module_fields WHERE module_id=?').all(mod.id);
  const display = pickDisplayField(fields);
  if (!display) return null;
  return { columns: [display.api_name], label: (r) => r[display.api_name], sub: () => '' };
}

// Only ever query columns the table actually has — a module_fields row can
// name a column that was later dropped, and that must degrade, not 500.
function realColumns(table, wanted) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  return wanted.filter((c) => present.has(c));
}

router.get('/lookup/:module', (req, res) => {
  const mod = db.prepare('SELECT * FROM modules WHERE api_name=?').get(req.params.module);
  if (!mod || !mod.table_name) return res.status(404).json({ error: 'No such module' });
  if (!hasView(req.user, mod.api_name)) return res.status(403).json({ error: `You don't have access to ${mod.plural_label}.` });

  const cfg = lookupConfig(mod);
  if (!cfg) return res.json({ results: [] });
  const columns = realColumns(mod.table_name, cfg.columns);
  if (!columns.length) return res.json({ results: [] });
  const select = ['id', ...columns].join(', ');

  // `ids` resolves known values back to names — the detail page and the edit
  // form both need this, and one round trip for the whole page beats one per
  // field.
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map((v) => Number(v)).filter(Number.isInteger).slice(0, 200);
    if (!ids.length) return res.json({ results: [] });
    const rows = db.prepare(`SELECT ${select} FROM ${mod.table_name} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    return res.json({ results: rows.map((r) => ({ id: r.id, label: cfg.label(r) || `#${r.id}`, sub: cfg.sub(r) })) });
  }

  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const searchable = columns.filter((c) => !['amount', 'selling_price'].includes(c));
  let rows;
  if (q) {
    const where = searchable.map((c) => `${c} LIKE ?`).join(' OR ');
    rows = db.prepare(`SELECT ${select} FROM ${mod.table_name} WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...searchable.map(() => `%${q}%`), limit);
  } else {
    // An empty box still shows the most recent records, so picking the
    // customer you just created doesn't require typing its name.
    rows = db.prepare(`SELECT ${select} FROM ${mod.table_name} ORDER BY id DESC LIMIT ?`).all(limit);
  }
  return res.json({ results: rows.map((r) => ({ id: r.id, label: cfg.label(r) || `#${r.id}`, sub: cfg.sub(r) })) });
});

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 5, 20);
  if (!q || q.length < 2) return res.json({ groups: [] });
  const like = `%${q}%`;

  const modules = db.prepare('SELECT * FROM modules WHERE enabled=1 ORDER BY sidebar_group, sidebar_order, plural_label').all();
  const groups = [];

  for (const mod of modules) {
    if (!hasView(req.user, mod.api_name)) continue;

    // Path 2: legacy hardcoded tables
    if (LEGACY_SEARCH[mod.api_name]) {
      const cfg = LEGACY_SEARCH[mod.api_name];
      if (cfg.columns.length === 0) continue;
      const table = cfg.table || mod.api_name;
      const where = cfg.columns.map((c) => `${c} LIKE ?`).join(' OR ');
      const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT ?`).all(...cfg.columns.map(() => like), limit);
      if (rows.length) groups.push({ module: { api_name: mod.api_name, plural_label: mod.plural_label, icon: mod.icon, color: mod.color },
        results: rows.map((r) => ({ id: r.id, label: cfg.label(r), sub: cfg.sub(r) })) });
      continue;
    }

    // Path 3: custom (JSON-backed) modules
    if (!mod.table_name) {
      const rows = db.prepare('SELECT id, record_name FROM custom_module_records WHERE module_id=? AND record_name LIKE ? LIMIT ?').all(mod.id, like, limit);
      if (rows.length) groups.push({ module: { api_name: mod.api_name, plural_label: mod.plural_label, icon: mod.icon, color: mod.color },
        results: rows.map((r) => ({ id: r.id, label: r.record_name || `#${r.id}` })) });
      continue;
    }

    // Path 1: metadata-driven modules
    const fields = db.prepare('SELECT * FROM module_fields WHERE module_id=? AND is_system=1').all(mod.id);
    const searchFields = fields.filter((f) => SEARCHABLE_TYPES.has(f.field_type));
    if (searchFields.length === 0) continue;
    const displayField = pickDisplayField(fields) || searchFields[0];
    const where = searchFields.map((f) => `${f.api_name} LIKE ?`).join(' OR ');
    const rows = db.prepare(`SELECT * FROM ${mod.table_name} WHERE ${where} LIMIT ?`).all(...searchFields.map(() => like), limit);
    if (rows.length) groups.push({ module: { api_name: mod.api_name, plural_label: mod.plural_label, icon: mod.icon, color: mod.color },
      results: rows.map((r) => ({ id: r.id, label: r[displayField.api_name] || `#${r.id}`, sub: '' })) });
  }

  res.json({ groups });
});

module.exports = router;
