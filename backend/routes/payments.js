const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { generateReceiptPdf } = require('../services/receiptPdf');
const { fireEvent } = require('../services/whatsapp/workflowEngine');
const { fireWorkflows } = require('../services/workflowAutomation');

// Payments works for two shapes now: the legacy placement-flow payment
// (linked to a student/admission/course, created by the old Admissions
// installment plan) and a generic payment linked to an Account/Opportunity/
// Quotation (created directly via POST below). Every query LEFT JOINs both
// sets of links and computes one display name regardless of which shape a
// given row is, so the frontend never needs to know which kind it's looking
// at.
const SELECT_WITH_LINKS = `
  SELECT p.*,
    s.student_name, c.course_name, ad.admission_number,
    acc.account_name, ct.first_name || ' ' || COALESCE(ct.last_name,'') AS contact_name,
    o.opportunity_name, q.quote_number,
    COALESCE(s.student_name, acc.account_name, p.payer_name) AS payer_display_name
  FROM payments p
  LEFT JOIN students s ON s.id = p.student_id
  LEFT JOIN courses c ON c.id = p.course_id
  LEFT JOIN admissions ad ON ad.id = p.admission_id
  LEFT JOIN accounts acc ON acc.id = p.account_id
  LEFT JOIN contacts ct ON ct.id = p.contact_id
  LEFT JOIN opportunities o ON o.id = p.opportunity_id
  LEFT JOIN quotations q ON q.id = p.quotation_id
`;

function nextPaymentNumber() {
  const count = db.prepare('SELECT COUNT(*) c FROM payments').get().c;
  return `PAY-${String(count + 1).padStart(5, '0')}`;
}

router.get('/', requirePermission('payments', 'view'), (req, res) => {
  const { status, account_id, opportunity_id, student_id, admission_id, q } = req.query;
  let sql = SELECT_WITH_LINKS + ' WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND p.status = ?'; params.push(status); }
  if (account_id) { sql += ' AND p.account_id = ?'; params.push(account_id); }
  if (opportunity_id) { sql += ' AND p.opportunity_id = ?'; params.push(opportunity_id); }
  if (student_id) { sql += ' AND p.student_id = ?'; params.push(student_id); }
  if (admission_id) { sql += ' AND p.admission_id = ?'; params.push(admission_id); }
  if (q) { sql += ' AND (s.student_name LIKE ? OR acc.account_name LIKE ? OR p.payer_name LIKE ? OR p.payment_number LIKE ? OR p.transaction_number LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY p.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requirePermission('payments', 'view'), (req, res) => {
  const payment = db.prepare(SELECT_WITH_LINKS + ' WHERE p.id=?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  res.json(payment);
});

// Generic payment creation — links to an Account/Opportunity/Quotation (any
// or none of them), independent of the old student/admission/course flow.
router.post('/', requirePermission('payments', 'create'), (req, res) => {
  const b = req.body;
  if (!b.account_id && !b.opportunity_id && !b.quotation_id && !b.payer_name) {
    return res.status(400).json({ error: 'Provide account_id, opportunity_id, quotation_id, or a payer_name' });
  }
  const info = db.prepare(`
    INSERT INTO payments (
      payment_number, payment_date, account_id, contact_id, opportunity_id, quotation_id, payer_name,
      description, installment_number, amount, payment_mode, transaction_number, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    b.payment_number || nextPaymentNumber(), b.payment_date || new Date().toISOString(),
    b.account_id || null, b.contact_id || null, b.opportunity_id || null, b.quotation_id || null,
    b.payer_name || null, b.description || null, b.installment_number || 1, b.amount || 0,
    b.payment_mode || null, b.transaction_number || null, b.status || 'Pending'
  );
  const created = db.prepare(SELECT_WITH_LINKS + ' WHERE p.id=?').get(info.lastInsertRowid);
  fireWorkflows('payments', 'record_created', created, null, req.user.id);
  res.status(201).json(db.prepare(SELECT_WITH_LINKS + ' WHERE p.id=?').get(created.id));
});

// Mark Pending/Partial -> Paid (or Failed), capturing mode/transaction details
router.put('/:id', requirePermission('payments', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  db.prepare(`
    UPDATE payments SET payment_date=?, amount=?, payment_mode=?, transaction_number=?, status=?, remarks=?,
      payer_name=?, description=?
    WHERE id=?
  `).run(
    m.payment_date || (m.status === 'Paid' ? new Date().toISOString() : existing.payment_date),
    m.amount, m.payment_mode, m.transaction_number, m.status, m.remarks, m.payer_name, m.description, req.params.id
  );
  const updated = db.prepare(SELECT_WITH_LINKS + ' WHERE p.id=?').get(req.params.id);
  if (m.status === 'Paid' && existing.status !== 'Paid') {
    const contact = updated.contact_id ? db.prepare('SELECT mobile, whatsapp FROM contacts WHERE id=?').get(updated.contact_id) : null;
    const account = updated.account_id ? db.prepare('SELECT phone, whatsapp FROM accounts WHERE id=?').get(updated.account_id) : null;
    const student = updated.student_id ? db.prepare('SELECT mobile FROM students WHERE id=?').get(updated.student_id) : null;
    const mobile = contact?.whatsapp || contact?.mobile || account?.whatsapp || account?.phone || student?.mobile || null;
    fireEvent('payment_received', {
      entityType: 'payment', entityId: updated.id, mobile,
      fields: {
        student_name: updated.payer_display_name, amount: updated.amount, payment_number: updated.payment_number,
        installment_number: updated.installment_number, course_name: updated.course_name || '',
      },
    });
  }
  const finalPayment = db.prepare(SELECT_WITH_LINKS + ' WHERE p.id=?').get(req.params.id);
  fireWorkflows('payments', 'record_updated', finalPayment, existing, req.user.id);
  fireWorkflows('payments', 'field_changed', finalPayment, existing, req.user.id);
  res.json(finalPayment);
});

router.delete('/:id', requirePermission('payments', 'delete'), (req, res) => {
  db.prepare('DELETE FROM payments WHERE id=?').run(req.params.id);
  res.status(204).end();
});

// ===== Receipt download: two selectable institute templates =====
// GET /api/payments/:id/receipt?institute=A  (or B)
router.get('/:id/receipt', requirePermission('payments', 'view'), (req, res) => {
  const institute = (req.query.institute || 'A').toUpperCase();
  if (!['A', 'B'].includes(institute)) return res.status(400).json({ error: "institute must be 'A' or 'B'" });

  const payment = db.prepare(SELECT_WITH_LINKS + ' WHERE p.id=?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.status !== 'Paid') return res.status(400).json({ error: 'Receipt is only available once the payment is marked Paid' });

  const template = db.prepare('SELECT * FROM receipt_templates WHERE id=?').get(institute);

  // Build a generic payer block — works whether this is a legacy student
  // payment or a generic Account/Opportunity/Quotation-linked one.
  let payer;
  if (payment.student_id) {
    payer = { name: payment.student_name, subLabel: null, referenceLabel: 'Admission No', referenceValue: payment.admission_number };
  } else {
    payer = {
      name: payment.account_name || payment.payer_name || 'Customer',
      subLabel: payment.contact_name ? `Contact: ${payment.contact_name}` : null,
      referenceLabel: payment.quote_number ? 'Quotation' : payment.opportunity_name ? 'Opportunity' : null,
      referenceValue: payment.quote_number || payment.opportunity_name || null,
    };
  }
  const lineDescription = payment.description || payment.course_name || 'Payment';

  db.prepare('UPDATE payments SET receipt_institute=? WHERE id=?').run(institute, payment.id);
  generateReceiptPdf({ payment, payer, lineDescription, template }, res);
});

module.exports = router;
