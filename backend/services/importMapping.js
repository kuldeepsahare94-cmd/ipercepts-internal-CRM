// ============================================================================
// CSV import: header mapping and automatic field creation.
// ============================================================================
// Real exports from other CRMs never use your internal column names. A file
// says "Email Address", "Mobile", "Lead Source"; the table has `email`,
// `mobile`, `source`. The import used to reject the whole file for that.
//
// This module does two things:
//
//   1. MATCH a header to a column that already exists — by exact name, by
//      slug, by the field's label, or by a synonym list. Matching first is
//      what stops "Email Address" from creating a second, duplicate email
//      field beside the real one.
//
//   2. Only when no match exists, describe a NEW field to create — with its
//      type inferred from the actual values in the file, not guessed from
//      the header text.
//
// Nothing here writes anything. `planImport` returns a plan; the caller
// decides whether to apply it. That separation is what makes a preview
// possible.

const RESERVED = new Set(['id', 'created_at', 'updated_at', 'select', 'from', 'where',
  'table', 'index', 'order', 'group', 'default', 'primary', 'key', 'references', 'check']);

// Columns the importer must never let a file target.
const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);

// Headers that mean the same thing as a column we already have. Keys are
// slugified headers; values are the column to use instead of creating a
// duplicate. Anything not listed here still gets matched by slug or by the
// field's label first — this list is only for the cases where the words
// genuinely differ.
const SYNONYMS = {
  email_address: 'email',
  email_id: 'email',
  e_mail: 'email',
  primary_email: 'email',
  work_email: 'email',

  mobile_number: 'mobile',
  mobile_no: 'mobile',
  phone: 'mobile',
  phone_number: 'mobile',
  contact_number: 'mobile',
  contact_no: 'mobile',

  alternate_phone: 'alternate_mobile',
  alternate_number: 'alternate_mobile',
  secondary_mobile: 'alternate_mobile',

  lead_source: 'source',
  source_of_lead: 'source',

  lead_status: 'status',

  next_follow_up: 'follow_up_date',
  followup_date: 'follow_up_date',
  next_followup_date: 'follow_up_date',

  notes: 'remarks',
  comments: 'remarks',
  description: 'remarks',

  owner: 'assigned_counselor',
  assigned_to: 'assigned_counselor',
  lead_owner: 'assigned_counselor',

  rating: 'lead_rating',
  score: 'lead_score',

  interested_product: 'product_interest',
  product: 'product_interest',
  interested_service: 'service_interest',

  dob: 'date_of_birth',
  birth_date: 'date_of_birth',
};

// A handful of headers slugify into something unusable as a field name.
// These are renamed (and, where obvious, typed) rather than carried over
// verbatim from whichever CRM exported the file.
const NEW_FIELD_RENAMES = {
  non_primary_e_mails: { column: 'secondary_email', label: 'Secondary Email', field_type: 'email' },
  non_primary_emails:  { column: 'secondary_email', label: 'Secondary Email', field_type: 'email' },
  secondary_e_mail:    { column: 'secondary_email', label: 'Secondary Email', field_type: 'email' },
  e_mail_address:      { column: 'email', label: 'Email' },
  company:             { column: 'account_name', label: 'Account Name' },
  company_name:        { column: 'account_name', label: 'Account Name' },
  organisation:        { column: 'account_name', label: 'Account Name' },
  organization:        { column: 'account_name', label: 'Account Name' },
};

// Header text -> a safe snake_case identifier.
function slugify(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 50);
}

// Identifiers are interpolated into DDL, so they are whitelisted rather than
// escaped — anything not matching is refused outright.
function isSafeIdentifier(name) {
  return /^[a-z][a-z0-9_]{0,49}$/.test(name) && !RESERVED.has(name);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

// Infer a field type from the values actually present in the column.
// Deliberately conservative: it only commits to a specific type when EVERY
// non-empty value fits it, because a field typed wrongly is more annoying to
// fix than a field left as text.
const PLACEHOLDER_VALUES = new Set(['http://', 'https://', 'n/a', 'na', '-', '--']);

function inferType(values) {
  const vals = values
    .map((v) => String(v ?? '').trim())
    .filter((v) => v && !PLACEHOLDER_VALUES.has(v.toLowerCase()));
  if (vals.length === 0) return { field_type: 'text' };

  const all = (re) => vals.every((v) => re.test(v));

  if (all(EMAIL_RE)) return { field_type: 'email' };
  if (all(URL_RE)) return { field_type: 'url' };

  // Phone: mostly digits, 7–15 of them, allowing +, spaces, dashes, brackets.
  if (vals.every((v) => /^[+\d][\d\s\-()]{6,20}$/.test(v) && (v.match(/\d/g) || []).length >= 7
      && (v.match(/\d/g) || []).length <= 15)) {
    return { field_type: 'phone' };
  }

  if (all(/^-?\d+(\.\d+)?$/)) {
    const ints = vals.every((v) => /^-?\d+$/.test(v));
    return { field_type: 'number', sqlType: ints ? 'INTEGER' : 'REAL' };
  }

  if (all(DATE_RE)) return { field_type: 'date' };

  // A small, repeating set of values is a dropdown, not free text — but only
  // when there are enough rows for "small and repeating" to mean something.
  const distinct = [...new Set(vals)];
  if (vals.length >= 30 && distinct.length <= 12 && distinct.length <= vals.length / 5) {
    return {
      field_type: 'dropdown',
      options_json: JSON.stringify(distinct.sort().map((v) => ({ value: v, label: v }))),
    };
  }

  const longest = Math.max(...vals.map((v) => v.length));
  return { field_type: longest > 120 ? 'textarea' : 'text' };
}

// Turn a header into a human label: "first_name" -> "First Name".
function labelFor(header) {
  const t = String(header || '').trim();
  if (/[a-z]/.test(t) && /[A-Z]/.test(t)) return t;       // already mixed case
  if (t.includes(' ')) return t.replace(/\b\w/g, (c) => c.toUpperCase());
  return slugify(t).split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Work out, for every header in the file, whether it maps to an existing
 * column or needs a new field — without writing anything.
 *
 * @param {object[]} existingColumns  PRAGMA table_info rows
 * @param {object[]} existingFields   module_fields rows (api_name, label)
 * @param {string[]} header           the CSV header row
 * @param {string[][]} dataRows       the CSV data rows
 */
function planImport({ existingColumns, existingFields, header, dataRows }) {
  const colNames = existingColumns.map((c) => c.name);
  const colSet = new Set(colNames);

  // label -> api_name, so a header matching a field's LABEL maps to that
  // field ("Product Interest" -> product_interest) rather than creating one.
  const byLabel = new Map();
  for (const f of existingFields || []) {
    if (f.label) byLabel.set(slugify(f.label), f.api_name);
  }

  const mapped = [];   // { header, column, via }
  const create = [];   // { header, column, field_type, ... }
  const skipped = [];  // { header, reason }
  const takenNew = new Set();

  header.forEach((h, idx) => {
    const raw = String(h ?? '').trim();
    if (!raw) { skipped.push({ header: h, reason: 'blank header' }); return; }

    const slug = slugify(raw);
    if (!slug) { skipped.push({ header: raw, reason: 'header has no usable characters' }); return; }

    // A file must never write to id/created_at/updated_at.
    if (SYSTEM_COLS.has(slug)) { skipped.push({ header: raw, reason: 'system column' }); return; }

    const values = dataRows.map((r) => r[idx]);
    const filled = values.filter((v) => String(v ?? '').trim()).length;

    // --- 1. does this already exist? ---
    if (colSet.has(raw)) { mapped.push({ header: raw, column: raw, via: 'exact name', filled }); return; }
    if (colSet.has(slug)) { mapped.push({ header: raw, column: slug, via: 'name match', filled }); return; }

    const byLabelHit = byLabel.get(slug);
    if (byLabelHit && colSet.has(byLabelHit)) {
      mapped.push({ header: raw, column: byLabelHit, via: 'field label', filled }); return;
    }

    const syn = SYNONYMS[slug];
    if (syn && colSet.has(syn)) {
      mapped.push({ header: raw, column: syn, via: 'synonym', filled }); return;
    }

    // --- 2. genuinely new ---
    // A column with no data anywhere would create an empty field nobody
    // asked for, so it is reported rather than created.
    if (filled === 0) { skipped.push({ header: raw, reason: 'column is empty in every row' }); return; }

    if (!isSafeIdentifier(slug)) { skipped.push({ header: raw, reason: `"${slug}" is not a usable column name` }); return; }
    if (takenNew.has(NEW_FIELD_RENAMES[slug]?.column || slug)) {
      skipped.push({ header: raw, reason: 'duplicate header' }); return;
    }
    takenNew.add(NEW_FIELD_RENAMES[slug]?.column || slug);

    const rename = NEW_FIELD_RENAMES[slug];
    const column = rename?.column || slug;

    // A rename can land on a column that already exists — use it rather
    // than failing to add a duplicate.
    if (colSet.has(column)) {
      mapped.push({ header: raw, column, via: 'normalised name', filled }); return;
    }

    const inferred = { ...inferType(values), ...(rename?.field_type ? { field_type: rename.field_type } : {}) };
    create.push({
      header: raw,
      column,
      label: rename?.label || labelFor(raw),
      filled,
      distinct: new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean)).size,
      ...inferred,
    });
  });

  return { mapped, create, skipped };
}

/**
 * Apply a plan's new fields: add the table column and register it in
 * module_fields so it shows up in the UI like any other field.
 * Caller runs this inside the import transaction.
 */
function createFields(db, { tableName, moduleId, create }) {
  const created = [];

  // Which new fields earn a spot as a list column: the ones that actually
  // have data. Ordering by creation order instead put a column filled in 1
  // row of 715 on the list view while leaving a column filled in 684 off it.
  const listColumns = new Set(
    [...create]
      .sort((a, b) => (b.filled || 0) - (a.filled || 0))
      .slice(0, 4)
      .filter((f) => (f.filled || 0) > 0)
      .map((f) => f.column),
  );

  for (const f of create) {
    if (!isSafeIdentifier(f.column)) continue;   // belt and braces before DDL

    const sqlType = f.sqlType || 'TEXT';
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${f.column} ${sqlType}`);

    const nextPos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM module_fields WHERE module_id=?')
      .get(moduleId).p;

    db.prepare(`
      INSERT INTO module_fields
        (module_id, api_name, label, field_type, options_json, is_system,
         show_in_list, show_in_create, show_in_edit, show_in_detail, section, position)
      VALUES (?,?,?,?,?,0,?,1,1,1,?,?)
    `).run(
      moduleId, f.column, f.label, f.field_type, f.options_json || null,
      // Keep the list view readable: only the best-populated imported fields
      // become columns. The rest are one click away in Settings.
      listColumns.has(f.column) ? 1 : 0,
      'Imported', nextPos,
    );

    created.push({ api_name: f.column, label: f.label, field_type: f.field_type });
  }
  return created;
}

// Some tables carry a single "display name" column that the list view,
// global search and dashboards all read. If the file supplies first/last
// name separately but not that column, every imported record would show a
// blank name. This composes it rather than leaving the records unusable.
const DISPLAY_NAME_COLUMNS = ['student_name', 'full_name', 'name', 'title'];

function displayNamePlan({ existingColumns, mapped, create }) {
  const colNames = new Set(existingColumns.map((c) => c.name));
  const target = DISPLAY_NAME_COLUMNS.find((c) => colNames.has(c));
  if (!target) return null;

  const targeted = [...mapped, ...create].some((m) => m.column === target);
  if (targeted) return null;                       // the file already fills it

  const all = [...mapped, ...create].map((m) => m.column);
  const first = all.find((c) => c === 'first_name');
  const last = all.find((c) => c === 'last_name');
  if (!first && !last) return null;

  return { target, from: [first, last].filter(Boolean) };
}

module.exports = {
  slugify, isSafeIdentifier, inferType, labelFor,
  planImport, createFields, displayNamePlan,
  SYSTEM_COLS, SYNONYMS,
};
