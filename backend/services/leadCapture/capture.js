const db = require('../../db');

// Incoming forms name fields all kinds of things — normalize common variants
// to our actual lead columns. A source's own field_mapping_json (configured
// per-source) always wins over these defaults.
const DEFAULT_ALIASES = {
  name: 'student_name', full_name: 'student_name', fullname: 'student_name', student_name: 'student_name',
  phone: 'mobile', phone_number: 'mobile', mobile: 'mobile', whatsapp: 'mobile', contact: 'mobile',
  email: 'email', email_address: 'email',
  city: 'city', location: 'city',
  message: 'remarks', comments: 'remarks', notes: 'remarks', query: 'remarks',
  course: 'interested_course_name', interested_in: 'interested_course_name', program: 'interested_course_name',
  qualification: 'qualification',
};

function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').slice(-10);
}

// Rejects obvious bot submissions: a filled honeypot field, or way too many
// submissions from the same IP in a short window.
function isSpam(payload, ipAddress) {
  if (payload.website || payload.url_hp || payload._honeypot) return true; // honeypot field filled = bot
  if (!ipAddress) return false;
  const recentCount = db.prepare(`
    SELECT COUNT(*) c FROM lead_capture_log WHERE ip_address=? AND created_at >= datetime('now', '-1 minutes')
  `).get(ipAddress).c;
  return recentCount >= 10; // more than 10 submissions/minute from one IP is not a real person
}

function findDuplicate(mobile) {
  if (!mobile) return null;
  const target = normalizePhone(mobile);
  if (!target) return null;
  const recent = db.prepare(`SELECT id, mobile, created_at FROM leads WHERE mobile IS NOT NULL AND date(created_at) >= date('now','-1 day')`).all();
  return recent.find((l) => normalizePhone(l.mobile) === target) || null;
}

// Maps the raw incoming payload to lead columns using the source's custom
// mapping (if configured) falling back to sensible defaults, then creates
// the lead. Returns { status, lead, duplicateOf }.
function captureLead(source, payload) {
  const customMapping = JSON.parse(source.field_mapping_json || '{}');
  const fields = {};
  for (const [incomingKey, rawValue] of Object.entries(payload)) {
    const key = incomingKey.toLowerCase().trim();
    const targetColumn = customMapping[key] || DEFAULT_ALIASES[key];
    if (targetColumn && rawValue) fields[targetColumn] = String(rawValue).trim();
  }

  if (!fields.student_name && !fields.mobile) {
    return { status: 'rejected_no_data', error: 'Submission had no recognizable name or phone number.' };
  }

  const dup = findDuplicate(fields.mobile);
  if (dup) return { status: 'duplicate', duplicateOf: dup };

  // interested_course_name arrives as free text from a form — try to match it
  // to a real course by name; fall back to the source's configured default.
  let courseId = source.default_course_id || null;
  if (fields.interested_course_name) {
    const match = db.prepare('SELECT id FROM courses WHERE course_name LIKE ?').get(`%${fields.interested_course_name}%`);
    if (match) courseId = match.id;
  }

  const info = db.prepare(`
    INSERT INTO leads (student_name, mobile, email, city, qualification, source, interested_course_id, assigned_counselor, status, remarks)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    fields.student_name || '(No name given)', fields.mobile || null, fields.email || null, fields.city || null,
    fields.qualification || null, source.name, courseId, source.default_counselor || null,
    source.default_status || 'New', fields.remarks || null
  );

  return { status: 'success', lead: db.prepare('SELECT * FROM leads WHERE id=?').get(info.lastInsertRowid) };
}

module.exports = { captureLead, isSpam, findDuplicate, normalizePhone, DEFAULT_ALIASES };
