const express = require('express');
const router = express.Router();
const db = require('../db');
const { relatedActivity } = require('../services/relatedActivity');
const { requirePermission } = require('../middleware/auth');
const { fireWorkflows } = require('../services/workflowAutomation');
const billing = require('../services/subscriptionBilling');
const { crmToday } = require('../services/dashboardMetrics');

function nextSubscriptionNumber() {
  // Highest existing number + 1 rather than COUNT(*)+1, which collides as
  // soon as any subscription has been deleted.
  const row = db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(subscription_number, 5) AS INTEGER)), 0) n
      FROM subscriptions WHERE subscription_number LIKE 'SUB-%'`).get();
  let n = row.n + 1;
  while (db.prepare('SELECT 1 FROM subscriptions WHERE subscription_number=?').get(`SUB-${String(n).padStart(5, '0')}`)) n += 1;
  return `SUB-${String(n).padStart(5, '0')}`;
}

// Normalise any billing frequency to a monthly figure so MRR/ARR are
// comparable across subscriptions paid on different schedules.
function monthlyAmount(sub) {
  if (sub.subscription_value && sub.term_months) return sub.subscription_value / sub.term_months;
  const amt = sub.recurring_amount || 0;
  if (sub.billing_cycle === 'Yearly') return amt / 12;
  if (sub.billing_cycle === 'Quarterly') return amt / 3;
  return amt;
}

function sendError(res, e) {
  res.status(e.status || 500).json({ error: e.message });
}

router.get('/', requirePermission('subscriptions', 'view'), (req, res) => {
  const { account_id, product_id, status, q, renewal } = req.query;
  let sql = `${billing.SELECT} WHERE 1=1`;
  const params = [];
  if (account_id) { sql += ' AND s.account_id = ?'; params.push(account_id); }
  if (product_id) { sql += ' AND s.product_id = ?'; params.push(product_id); }
  if (status) { sql += ' AND s.status = ?'; params.push(status); }
  // The latest cycle of each subscription only — what the Customer page
  // shows, so a subscription renewed three times is one row, not four.
  if (req.query.current === '1') sql += ' AND s.renewed_by_id IS NULL';
  if (renewal === 'due') {
    sql += ` AND s.status='Active' AND s.renewed_by_id IS NULL AND s.renewal_date IS NOT NULL
      AND date(s.renewal_date) BETWEEN date(?) AND date(?, '+${billing.RENEWAL_WINDOW_DAYS} day')`;
    const today = crmToday();
    params.push(today, today);
  }
  if (q) { sql += ' AND (s.subscription_number LIKE ? OR a.account_name LIKE ? OR p.product_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY s.created_at DESC, s.id DESC';
  res.json(db.prepare(sql).all(...params));
});

// MRR / ARR summary across all active subscriptions.
router.get('/summary', requirePermission('subscriptions', 'view'), (req, res) => {
  const active = db.prepare(`SELECT * FROM subscriptions WHERE status='Active'`).all();
  const mrr = active.reduce((sum, s) => sum + monthlyAmount(s), 0);
  res.json({ mrr, arr: mrr * 12, active_count: active.length });
});

router.get('/:id', requirePermission('subscriptions', 'view'), (req, res) => {
  const sub = billing.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  // Payment schedule from the existing Payments module.
  const payments = billing.schedule(sub.id);
  res.json({ ...sub, payments, ...relatedActivity('subscriptions', req.params.id) });
});

router.get('/:id/schedule', requirePermission('subscriptions', 'view'), (req, res) => {
  const sub = billing.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json({ subscription: sub, payments: billing.schedule(sub.id), history: billing.history(sub.id) });
});

router.get('/:id/history', requirePermission('subscriptions', 'view'), (req, res) => {
  if (!billing.get(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(billing.history(req.params.id));
});

// Previews the schedule a set of values would produce, without saving —
// used by the renewal form so the user sees "12 payments of ₹10,000" before
// committing.
router.post('/preview', requirePermission('subscriptions', 'view'), (req, res) => {
  try {
    const v = billing.normalise(req.body || {});
    res.json({ ...v, installments: billing.installmentsFor(v) });
  } catch (e) { sendError(res, e); }
});

const COLUMNS = [
  'subscription_number', 'account_id', 'contact_id', 'opportunity_id', 'product_id', 'plan', 'start_date', 'end_date',
  'billing_cycle', 'quantity', 'unit_price', 'discount_percent', 'tax_percent', 'recurring_amount', 'currency',
  'payment_terms', 'auto_renewal', 'renewal_date', 'status', 'owner_id', 'notes',
  'term_months', 'billing_frequency_months', 'subscription_value',
];
const blankToNull = (v) => (v === '' || v === undefined ? null : v);

router.post('/', requirePermission('subscriptions', 'create'), (req, res) => {
  let v;
  try {
    const b = req.body || {};
    if (!b.account_id) throw billing.badRequest('Customer is required.');
    if (!b.product_id) throw billing.badRequest('Product / Service is required.');
    if (!b.start_date) throw billing.badRequest('Start Date is required.');
    if (!b.term_months) throw billing.badRequest('Subscription Term is required.');
    if (!b.billing_frequency_months) throw billing.badRequest('Billing Frequency is required.');
    if (b.subscription_value === undefined || b.subscription_value === '') throw billing.badRequest('Subscription Value is required.');
    v = billing.normalise({ status: 'Active', ...b });
  } catch (e) { return sendError(res, e); }

  const values = {
    contact_id: null, opportunity_id: null, plan: null, quantity: 1, unit_price: 0, discount_percent: 0, tax_percent: 0,
    recurring_amount: 0, currency: 'INR', payment_terms: null, auto_renewal: 1, owner_id: req.user.id, notes: null,
    ...Object.fromEntries(COLUMNS.map((c) => [c, blankToNull(v[c])]).filter(([, x]) => x !== null)),
  };
  values.subscription_number = values.subscription_number || nextSubscriptionNumber();
  const cols = COLUMNS.filter((c) => values[c] !== undefined);

  let id;
  try {
    db.transaction(() => {
      const info = db.prepare(`INSERT INTO subscriptions (${cols.join(', ')}, renewal_number)
        VALUES (${cols.map((c) => `@${c}`).join(', ')}, 0)`).run(values);
      id = info.lastInsertRowid;
      // An Active subscription gets its pending payments immediately, in the
      // same transaction — there is no moment where it exists unbilled.
      billing.generateSchedule(id);
    })();
  } catch (e) { return sendError(res, e); }

  const created = billing.get(id);
  fireWorkflows('subscriptions', 'record_created', created, null, req.user.id);
  res.status(201).json(billing.get(id));
});

router.put('/:id', requirePermission('subscriptions', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  let m;
  try {
    const body = { ...req.body };
    // Derived or chain-owned fields are never taken from the form.
    ['renewal_number', 'renewal_count', 'parent_subscription_id', 'renewed_by_id', 'next_payment_date', 'subscription_number']
      .forEach((k) => delete body[k]);
    m = billing.normalise(body, existing);
    billing.assertScheduleEditable(existing, m);
  } catch (e) { return sendError(res, e); }

  try {
    db.transaction(() => {
      const editable = COLUMNS.filter((c) => c !== 'subscription_number');
      db.prepare(`UPDATE subscriptions SET ${editable.map((c) => `${c}=@${c}`).join(', ')}, updated_at=datetime('now') WHERE id=@id`)
        .run({ ...Object.fromEntries(editable.map((c) => [c, blankToNull(m[c])])), auto_renewal: m.auto_renewal ? 1 : 0, id: existing.id });
      const after = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(existing.id);
      // Becoming Active for the first time generates the schedule; changing
      // term/frequency/value/start before anything is paid regenerates the
      // pending part of it. Neither ever duplicates an instalment.
      billing.rebuildScheduleIfNeeded(existing, after);
    })();
  } catch (e) { return sendError(res, e); }

  const updated = billing.get(existing.id);
  fireWorkflows('subscriptions', 'record_updated', updated, existing, req.user.id);
  fireWorkflows('subscriptions', 'field_changed', updated, existing, req.user.id);
  res.json(billing.get(existing.id));
});

// Starts the next renewal cycle. The previous cycle and its payments are not
// modified; the new cycle can use a different term, frequency and value.
router.post('/:id/renew', requirePermission('subscriptions', 'create'), (req, res) => {
  try {
    const renewed = billing.renew(req.params.id, req.body || {}, req.user.id, nextSubscriptionNumber);
    fireWorkflows('subscriptions', 'record_created', renewed, null, req.user.id);
    res.status(201).json(renewed);
  } catch (e) { sendError(res, e); }
});

// Re-runs schedule generation. Idempotent: returns how many instalments were
// missing and have now been created (0 on every run after the first).
router.post('/:id/generate-payments', requirePermission('subscriptions', 'edit'), (req, res) => {
  if (!billing.get(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const created = billing.generateSchedule(req.params.id);
  res.json({ created, payments: billing.schedule(req.params.id) });
});

// A one-off payment against a subscription, recorded in the Payments module.
router.post('/:id/payments', requirePermission('payments', 'create'), (req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const max = db.prepare('SELECT COALESCE(MAX(installment_number),0) n FROM payments WHERE subscription_id=?').get(sub.id).n;
  const number = db.prepare(`SELECT COALESCE(MAX(CAST(SUBSTR(payment_number, 5) AS INTEGER)), 0) + 1 n FROM payments WHERE payment_number LIKE 'PAY-%'`).get().n;
  const info = db.prepare(`
    INSERT INTO payments (payment_number, payment_date, due_date, account_id, contact_id, subscription_id, product_id,
      description, installment_number, amount, payment_mode, transaction_number, status, remarks)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(`PAY-${String(number).padStart(5, '0')}`, b.payment_date || crmToday(), b.due_date || null, sub.account_id,
    sub.contact_id, sub.id, sub.product_id, b.description || `${sub.subscription_number} · Additional payment`, max + 1,
    b.amount || 0, b.payment_method || b.payment_mode || null, b.transaction_id || b.transaction_number || null,
    b.status || 'Paid', b.notes || null);
  res.status(201).json(db.prepare('SELECT * FROM payments WHERE id=?').get(info.lastInsertRowid));
});

router.delete('/:id', requirePermission('subscriptions', 'delete'), (req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id);
  if (!sub) return res.status(204).end();
  // Deleting a cycle with received money would orphan real receipts from
  // their subscription. Set it Inactive instead.
  const received = db.prepare(`SELECT 1 FROM payments WHERE subscription_id=? AND status IN ('Paid','Partial')`).get(sub.id);
  if (received) return res.status(400).json({ error: 'Payments have been received against this subscription. Set it to Inactive instead of deleting it.' });
  db.transaction(() => {
    db.prepare(`DELETE FROM payments WHERE subscription_id=? AND status IN ('Pending','Failed')`).run(sub.id);
    // Re-open the previous cycle for renewal if this was its renewal.
    db.prepare('UPDATE subscriptions SET renewed_by_id=NULL WHERE renewed_by_id=?').run(sub.id);
    db.prepare('DELETE FROM subscriptions WHERE id=?').run(sub.id);
  })();
  res.status(204).end();
});

module.exports = router;
