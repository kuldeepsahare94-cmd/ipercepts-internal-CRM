// ============================================================================
// Subscription / AMC billing: payment schedules and renewal cycles.
// ============================================================================
// A subscription cycle has a TERM (how long it lasts) and a BILLING FREQUENCY
// (how often it is paid). They are independent: a 12-month AMC billed every
// 3 months has four instalments. Each instalment is a row in the existing
// `payments` table — the Payments module — linked back by subscription_id, so
// marking one paid, printing its receipt and reporting on it all work
// exactly as for any other payment.
//
// Three rules this file exists to keep:
//   1. The schedule is generated once. A unique index on
//      (subscription_id, installment_number) makes re-running it a no-op.
//   2. A renewal is a new cycle. The previous cycle, and every payment it
//      generated, is never modified by renewing.
//   3. Renewal Count is derived (renewal_number of the cycle), never typed.
// ============================================================================

const db = require('../db');

const FREQUENCIES = [1, 3, 6, 9, 12];
const CYCLE_LABEL = { 1: 'Monthly', 3: 'Quarterly', 6: 'Half-Yearly', 9: 'Every 9 Months', 12: 'Yearly' };
// Renewal window used by the dashboard and the list filter. One constant so
// the count and the list it opens can never disagree.
const RENEWAL_WINDOW_DAYS = 30;

function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Date arithmetic on plain YYYY-MM-DD strings, in UTC so no timezone can shift
// a due date by a day. Month overflow clamps to the month's last day
// (31 Jan + 1 month = 28/29 Feb), which is how billing dates are expected to
// behave.
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}
function fmt({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function addMonths(dateStr, months) {
  const p = parseDate(dateStr);
  if (!p) return null;
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return fmt({ y, m, d: Math.min(p.d, last) });
}
function addDays(dateStr, days) {
  const p = parseDate(dateStr);
  if (!p) return null;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return dt.toISOString().slice(0, 10);
}

// Fills in what can be derived and rejects what cannot be billed. Returns a
// normalised copy; never mutates the input.
function normalise(input, existing = {}) {
  const v = { ...existing, ...input };
  const term = v.term_months === '' || v.term_months == null ? null : Number(v.term_months);
  const freq = v.billing_frequency_months === '' || v.billing_frequency_months == null ? null : Number(v.billing_frequency_months);

  if (term !== null && (!Number.isInteger(term) || term < 1 || term > 120)) {
    throw badRequest('Subscription Term must be a whole number of months between 1 and 120.');
  }
  if (freq !== null && !FREQUENCIES.includes(freq)) {
    throw badRequest(`Billing Frequency must be one of ${FREQUENCIES.join(', ')} months.`);
  }
  if (term !== null && freq !== null) {
    if (freq > term) throw badRequest('Billing Frequency cannot be longer than the Subscription Term.');
    if (term % freq !== 0) {
      throw badRequest(`A ${term}-month term cannot be split evenly into ${freq}-month payments. Choose a frequency that divides the term (e.g. ${FREQUENCIES.filter((f) => term % f === 0).join(', ')} months).`);
    }
  }
  if (v.status && !['Active', 'Inactive', 'Hold'].includes(v.status)) {
    throw badRequest('Status must be Active, Inactive or Hold.');
  }

  v.term_months = term;
  v.billing_frequency_months = freq;
  if (v.subscription_value !== undefined && v.subscription_value !== null && v.subscription_value !== '') {
    v.subscription_value = round2(v.subscription_value);
    if (v.subscription_value < 0) throw badRequest('Subscription Value cannot be negative.');
  }
  if (v.start_date) v.start_date = String(v.start_date).slice(0, 10);
  // End date: the day before the term completes (1 Jan + 12 months → 31 Dec).
  if (v.start_date && term && (!input.end_date || input.end_date === '') && (!existing.end_date || input.term_months !== undefined || input.start_date !== undefined)) {
    v.end_date = addDays(addMonths(v.start_date, term), -1);
  }
  if (v.end_date) v.end_date = String(v.end_date).slice(0, 10);
  if (v.start_date && v.end_date && v.end_date < v.start_date) throw badRequest('End Date cannot be before Start Date.');
  // Renewal date defaults to the end date and follows it when the end date
  // moves, unless someone has set it explicitly.
  if (v.end_date && (!v.renewal_date || (existing.renewal_date && existing.renewal_date === existing.end_date && input.renewal_date === undefined))) {
    v.renewal_date = v.end_date;
  }
  if (freq) {
    v.billing_cycle = CYCLE_LABEL[freq];
    if (term && v.subscription_value != null) v.recurring_amount = round2(v.subscription_value / (term / freq));
  }
  return v;
}

function installmentsFor(sub) {
  if (!sub.term_months || !sub.billing_frequency_months || !sub.start_date) return [];
  const n = sub.term_months / sub.billing_frequency_months;
  const total = round2(sub.subscription_value || 0);
  const each = round2(total / n);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    // The last instalment absorbs rounding so the schedule sums to the value
    // exactly: ₹1,00,000 / 3 is 33,333.33 + 33,333.33 + 33,333.34.
    const amount = i === n - 1 ? round2(total - each * (n - 1)) : each;
    out.push({ installment_number: i + 1, due_date: addMonths(sub.start_date, i * sub.billing_frequency_months), amount, of: n });
  }
  return out;
}

function nextPaymentNumber() {
  // COUNT(*)+1 collides once any payment has been deleted; the highest
  // existing PAY- number does not.
  const row = db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(payment_number, 5) AS INTEGER)), 0) n
      FROM payments WHERE payment_number LIKE 'PAY-%'`).get();
  let n = row.n + 1;
  while (db.prepare('SELECT 1 FROM payments WHERE payment_number=?').get(`PAY-${String(n).padStart(5, '0')}`)) n += 1;
  return `PAY-${String(n).padStart(5, '0')}`;
}

// Creates any missing instalments for an Active cycle. Safe to call any
// number of times: existing instalments are left exactly as they are and
// INSERT OR IGNORE against the unique index means a race cannot duplicate
// one either. Returns how many were created.
function generateSchedule(subscriptionId) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subscriptionId);
  if (!sub || sub.status !== 'Active') return 0;
  const plan = installmentsFor(sub);
  if (!plan.length) return 0;
  const product = sub.product_id ? db.prepare('SELECT product_name FROM products WHERE id=?').get(sub.product_id) : null;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO payments (payment_number, payment_date, due_date, account_id, contact_id, opportunity_id,
      subscription_id, product_id, description, installment_number, amount, status)
    VALUES (@payment_number, NULL, @due_date, @account_id, @contact_id, @opportunity_id,
      @subscription_id, @product_id, @description, @installment_number, @amount, 'Pending')`);
  let created = 0;
  db.transaction(() => {
    for (const p of plan) {
      const exists = db.prepare('SELECT 1 FROM payments WHERE subscription_id=? AND installment_number=?').get(sub.id, p.installment_number);
      if (exists) continue;
      const info = insert.run({
        payment_number: nextPaymentNumber(),
        due_date: p.due_date,
        account_id: sub.account_id,
        contact_id: sub.contact_id || null,
        opportunity_id: sub.opportunity_id || null,
        subscription_id: sub.id,
        product_id: sub.product_id || null,
        description: `${sub.subscription_number}${product ? ` · ${product.product_name}` : ''} · Payment ${p.installment_number} of ${p.of}`,
        installment_number: p.installment_number,
        amount: p.amount,
      });
      created += info.changes;
    }
  })();
  return created;
}

const RECEIVED = "('Paid','Partial')";

// A cycle's schedule may be rebuilt only while nothing has been received
// against it. Once money has come in, the schedule is history.
function hasReceivedPayments(subscriptionId) {
  return !!db.prepare(`SELECT 1 FROM payments WHERE subscription_id=? AND status IN ${RECEIVED}`).get(subscriptionId);
}

// Called after a subscription is edited. If the fields that shape the
// schedule changed, pending instalments are replaced; if money has already
// been received, the edit is refused rather than silently rewriting it.
const SCHEDULE_FIELDS = ['start_date', 'term_months', 'billing_frequency_months', 'subscription_value'];
function scheduleChanged(before, after) {
  return SCHEDULE_FIELDS.some((f) => String(before[f] ?? '') !== String(after[f] ?? ''));
}
function assertScheduleEditable(before, after) {
  if (scheduleChanged(before, after) && hasReceivedPayments(before.id)) {
    throw badRequest('Payments have already been received for this cycle, so its start date, term, frequency and value are locked. Create a renewal cycle to change them.');
  }
}
function rebuildScheduleIfNeeded(before, after) {
  if (!scheduleChanged(before, after)) return generateSchedule(after.id);
  db.prepare(`DELETE FROM payments WHERE subscription_id=? AND status='Pending'`).run(after.id);
  return generateSchedule(after.id);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
// next_payment_date and renewal_count are computed in SQL on every read, so
// they are always true and nothing has to keep them in step.
const SELECT = `
  SELECT s.*, a.account_name, p.product_name, p.product_type,
    (SELECT MIN(py.due_date) FROM payments py
       WHERE py.subscription_id = s.id AND py.status IN ('Pending','Partial','Failed')) AS next_payment_date,
    COALESCE(s.renewal_number, 0) AS renewal_count,
    ps.subscription_number AS parent_subscription_number,
    rs.subscription_number AS renewed_by_number,
    (SELECT COUNT(*) FROM payments py WHERE py.subscription_id = s.id) AS payment_count,
    (SELECT COALESCE(SUM(py.amount),0) FROM payments py WHERE py.subscription_id = s.id AND py.status IN ${RECEIVED}) AS amount_received
  FROM subscriptions s
  LEFT JOIN accounts a ON a.id = s.account_id
  LEFT JOIN products p ON p.id = s.product_id
  LEFT JOIN subscriptions ps ON ps.id = s.parent_subscription_id
  LEFT JOIN subscriptions rs ON rs.id = s.renewed_by_id`;

function get(id) {
  return db.prepare(`${SELECT} WHERE s.id=?`).get(id);
}

function schedule(subscriptionId) {
  return db.prepare(`
    SELECT id, payment_number, installment_number, due_date, payment_date, amount, status, payment_mode, transaction_number
      FROM payments WHERE subscription_id=? ORDER BY installment_number, id`).all(subscriptionId);
}

// The whole chain this cycle belongs to, oldest first: walk up to the
// original, then down through each renewal.
function history(subscriptionId) {
  let root = db.prepare('SELECT id, parent_subscription_id FROM subscriptions WHERE id=?').get(subscriptionId);
  if (!root) return [];
  const seen = new Set([root.id]);
  while (root.parent_subscription_id && !seen.has(root.parent_subscription_id)) {
    const parent = db.prepare('SELECT id, parent_subscription_id FROM subscriptions WHERE id=?').get(root.parent_subscription_id);
    if (!parent) break;
    seen.add(parent.id);
    root = parent;
  }
  const chain = [];
  let cur = get(root.id);
  const visited = new Set();
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    chain.push(cur);
    const child = db.prepare('SELECT id FROM subscriptions WHERE parent_subscription_id=? ORDER BY id LIMIT 1').get(cur.id);
    cur = child ? get(child.id) : null;
  }
  return chain.map((c, i) => ({
    id: c.id,
    subscription_number: c.subscription_number,
    renewal_number: c.renewal_count,
    status: c.status,
    start_date: c.start_date,
    end_date: c.end_date,
    term_months: c.term_months,
    billing_frequency_months: c.billing_frequency_months,
    subscription_value: c.subscription_value,
    payment_count: c.payment_count,
    amount_received: c.amount_received,
    previous: i > 0 ? {
      start_date: chain[i - 1].start_date,
      end_date: chain[i - 1].end_date,
      billing_frequency_months: chain[i - 1].billing_frequency_months,
      subscription_value: chain[i - 1].subscription_value,
    } : null,
    is_current: c.id === Number(subscriptionId),
  }));
}

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------
// Creates the next cycle and links it both ways. The old cycle is only given
// a pointer to its successor; its dates, value, status and payments are left
// as they were. Returns the new cycle.
function renew(subscriptionId, body, userId, nextNumber) {
  const old = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subscriptionId);
  if (!old) throw Object.assign(new Error('Subscription not found'), { status: 404 });
  if (old.renewed_by_id) {
    const next = db.prepare('SELECT subscription_number FROM subscriptions WHERE id=?').get(old.renewed_by_id);
    throw badRequest(`This cycle has already been renewed${next ? ` as ${next.subscription_number}` : ''}. Renew the latest cycle instead.`);
  }
  const start = body.start_date || (old.end_date ? addDays(old.end_date, 1) : null);
  if (!start) throw badRequest('A start date is required for the renewal.');
  const values = normalise({
    start_date: start,
    end_date: body.end_date || '',
    term_months: body.term_months ?? old.term_months,
    billing_frequency_months: body.billing_frequency_months ?? old.billing_frequency_months,
    subscription_value: body.subscription_value ?? old.subscription_value,
    renewal_date: body.renewal_date || null,
    status: 'Active',
  });
  if (!values.term_months || !values.billing_frequency_months) {
    throw badRequest('Term and Billing Frequency are required for the renewal.');
  }

  let newId;
  db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO subscriptions (subscription_number, account_id, contact_id, opportunity_id, product_id, plan,
        start_date, end_date, billing_cycle, quantity, unit_price, discount_percent, tax_percent, recurring_amount,
        currency, payment_terms, auto_renewal, renewal_date, status, owner_id, notes,
        term_months, billing_frequency_months, subscription_value, parent_subscription_id, renewal_number)
      VALUES (@subscription_number, @account_id, @contact_id, @opportunity_id, @product_id, @plan,
        @start_date, @end_date, @billing_cycle, @quantity, @unit_price, @discount_percent, @tax_percent, @recurring_amount,
        @currency, @payment_terms, @auto_renewal, @renewal_date, 'Active', @owner_id, @notes,
        @term_months, @billing_frequency_months, @subscription_value, @parent_subscription_id, @renewal_number)`).run({
      subscription_number: nextNumber(),
      account_id: old.account_id, contact_id: old.contact_id, opportunity_id: old.opportunity_id,
      product_id: old.product_id, plan: old.plan,
      start_date: values.start_date, end_date: values.end_date, billing_cycle: values.billing_cycle,
      quantity: old.quantity ?? 1, unit_price: old.unit_price ?? 0, discount_percent: old.discount_percent ?? 0,
      tax_percent: old.tax_percent ?? 0, recurring_amount: values.recurring_amount ?? 0,
      currency: old.currency || 'INR', payment_terms: old.payment_terms, auto_renewal: old.auto_renewal ?? 1,
      renewal_date: values.renewal_date, owner_id: old.owner_id ?? userId ?? null,
      notes: body.notes ?? null,
      term_months: values.term_months, billing_frequency_months: values.billing_frequency_months,
      subscription_value: values.subscription_value ?? 0,
      parent_subscription_id: old.id,
      renewal_number: (old.renewal_number || 0) + 1,
    });
    newId = info.lastInsertRowid;
    db.prepare("UPDATE subscriptions SET renewed_by_id=?, updated_at=datetime('now') WHERE id=?").run(newId, old.id);
    generateSchedule(newId);
  })();
  return get(newId);
}

module.exports = {
  FREQUENCIES, CYCLE_LABEL, RENEWAL_WINDOW_DAYS, SELECT,
  normalise, installmentsFor, generateSchedule, assertScheduleEditable, rebuildScheduleIfNeeded,
  get, schedule, history, renew, addMonths, addDays, badRequest,
};
