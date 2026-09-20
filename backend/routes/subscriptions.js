const express = require('express');
const router = express.Router();
const db = require('../db');
const { relatedActivity } = require('../services/relatedActivity');
const { requirePermission } = require('../middleware/auth');
const { fireWorkflows } = require('../services/workflowAutomation');

function nextSubscriptionNumber() {
  const count = db.prepare('SELECT COUNT(*) c FROM subscriptions').get().c;
  return `SUB-${String(count + 1).padStart(5, '0')}`;
}

// Normalize any billing cycle to a monthly figure so MRR/ARR are comparable
// across subscriptions on different cycles.
function monthlyAmount(sub) {
  const amt = sub.recurring_amount || 0;
  if (sub.billing_cycle === 'Yearly') return amt / 12;
  if (sub.billing_cycle === 'Quarterly') return amt / 3;
  return amt; // Monthly, or unspecified
}

router.get('/', requirePermission('subscriptions', 'view'), (req, res) => {
  const { account_id, status, q } = req.query;
  let sql = `SELECT s.*, a.account_name, p.product_name FROM subscriptions s
    LEFT JOIN accounts a ON a.id = s.account_id LEFT JOIN products p ON p.id = s.product_id WHERE 1=1`;
  const params = [];
  if (account_id) { sql += ' AND s.account_id = ?'; params.push(account_id); }
  if (status) { sql += ' AND s.status = ?'; params.push(status); }
  if (q) { sql += ' AND (s.subscription_number LIKE ? OR a.account_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY s.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// MRR / ARR summary across all active subscriptions.
router.get('/summary', requirePermission('subscriptions', 'view'), (req, res) => {
  const active = db.prepare(`SELECT * FROM subscriptions WHERE status='Active'`).all();
  const mrr = active.reduce((sum, s) => sum + monthlyAmount(s), 0);
  res.json({ mrr, arr: mrr * 12, active_count: active.length });
});

router.get('/:id', requirePermission('subscriptions', 'view'), (req, res) => {
  const sub = db.prepare(`
    SELECT s.*, a.account_name, p.product_name FROM subscriptions s
    LEFT JOIN accounts a ON a.id = s.account_id LEFT JOIN products p ON p.id = s.product_id WHERE s.id=?
  `).get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const payments = db.prepare('SELECT * FROM subscription_payments WHERE subscription_id=? ORDER BY payment_date DESC').all(req.params.id);
  res.json({ ...sub, payments, ...relatedActivity('subscriptions', req.params.id) });
});

router.post('/', requirePermission('subscriptions', 'create'), (req, res) => {
  const b = req.body;
  if (!b.account_id) return res.status(400).json({ error: 'account_id is required' });
  const info = db.prepare(`
    INSERT INTO subscriptions (
      subscription_number, account_id, contact_id, opportunity_id, product_id, plan, start_date, end_date,
      billing_cycle, quantity, unit_price, discount_percent, tax_percent, recurring_amount, currency, payment_terms,
      auto_renewal, renewal_date, status, owner_id, notes
    ) VALUES (@subscription_number, @account_id, @contact_id, @opportunity_id, @product_id, @plan, @start_date, @end_date,
      @billing_cycle, @quantity, @unit_price, @discount_percent, @tax_percent, @recurring_amount, @currency, @payment_terms,
      @auto_renewal, @renewal_date, @status, @owner_id, @notes)
  `).run({
    subscription_number: b.subscription_number || nextSubscriptionNumber(),
    contact_id: null, opportunity_id: null, product_id: null, plan: null, start_date: null, end_date: null,
    billing_cycle: 'Monthly', quantity: 1, unit_price: 0, discount_percent: 0, tax_percent: 0, recurring_amount: 0,
    currency: 'INR', payment_terms: null, auto_renewal: 1, renewal_date: null, status: 'Trial', owner_id: null, notes: null,
    ...b,
  });
  const created = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(info.lastInsertRowid);
  fireWorkflows('subscriptions', 'record_created', created, null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM subscriptions WHERE id=?').get(created.id));
});

router.put('/:id', requirePermission('subscriptions', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  db.prepare(`
    UPDATE subscriptions SET account_id=?, contact_id=?, opportunity_id=?, product_id=?, plan=?, start_date=?, end_date=?,
      billing_cycle=?, quantity=?, unit_price=?, discount_percent=?, tax_percent=?, recurring_amount=?, currency=?,
      payment_terms=?, auto_renewal=?, renewal_date=?, status=?, owner_id=?, notes=?, updated_at=datetime('now')
    WHERE id=?
  `).run(m.account_id, m.contact_id, m.opportunity_id, m.product_id, m.plan, m.start_date, m.end_date, m.billing_cycle,
    m.quantity, m.unit_price, m.discount_percent, m.tax_percent, m.recurring_amount, m.currency, m.payment_terms,
    m.auto_renewal ? 1 : 0, m.renewal_date, m.status, m.owner_id, m.notes, req.params.id);
  const updated = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id);
  fireWorkflows('subscriptions', 'record_updated', updated, existing, req.user.id);
  fireWorkflows('subscriptions', 'field_changed', updated, existing, req.user.id);
  res.json(db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id));
});

router.post('/:id/payments', requirePermission('subscriptions', 'edit'), (req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  const info = db.prepare(`
    INSERT INTO subscription_payments (subscription_id, payment_date, amount, currency, payment_method, transaction_id, status, notes)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(req.params.id, b.payment_date || new Date().toISOString(), b.amount || 0, b.currency || sub.currency,
    b.payment_method || null, b.transaction_id || null, b.status || 'Paid', b.notes || null);
  res.status(201).json(db.prepare('SELECT * FROM subscription_payments WHERE id=?').get(info.lastInsertRowid));
});

router.delete('/:id', requirePermission('subscriptions', 'delete'), (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
