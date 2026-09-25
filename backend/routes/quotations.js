const express = require('express');
const router = express.Router();
const db = require('../db');
const { relatedActivity } = require('../services/relatedActivity');
const { requirePermission } = require('../middleware/auth');
const { fireEvent } = require('../services/whatsapp/workflowEngine');
const { fireWorkflows } = require('../services/workflowAutomation');
const { buildDocumentPdf, renderDocumentPdfBuffer } = require('../services/documentPdf');
const { sendEmail, isConfigured: emailConfigured } = require('../services/email');
const { nextNumber } = require('../services/documentNumbering');
const engine = require('../services/documentEngine');
const docs = require('../services/documentService');

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

// The three-pass tax engine that used to live here has moved to
// services/documentEngine.js, unchanged in behaviour, so quotations, proforma
// invoices and invoices all calculate through one implementation instead of
// three copies that drift. Verified against the previous code on all 90
// existing quotations: every subtotal, discount, tax and line total identical.
function recalcTotals(quotationId) {
  const quotation = db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY sort_order, id').all(quotationId);

  const result = engine.calculate(quotation, items, { companyStateCode: docs.companyStateCode() });

  const updateItem = db.prepare('UPDATE quotation_items SET line_total=? WHERE id=?');
  result.lines.forEach((line, i) => {
    if (items[i]) updateItem.run(line.lineTotal, items[i].id);
  });

  db.prepare(`
    UPDATE quotations SET subtotal=?, total_discount=?, overall_discount_amount=?,
      taxable_value=?, tax_total=?, cgst_total=?, sgst_total=?, igst_total=?,
      grand_total=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    result.subtotal, result.totalDiscount, result.overallDiscount,
    result.taxableValue, result.taxTotal, result.cgstTotal, result.sgstTotal, result.igstTotal,
    result.grandTotal, quotationId,
  );

  return {
    subtotal: result.subtotal,
    totalDiscount: result.totalDiscount,
    overallDiscount: result.overallDiscount,
    taxTotal: result.taxTotal,
    grandTotal: result.grandTotal,
  };
}

// Was COUNT(*) + 1, which reissued a number as soon as any quotation was
// deleted and then died on the UNIQUE constraint. The counter now lives in
// document_sequences, only moves forward, and is configurable in Settings.
// Called inside the insert transaction so a failed insert doesn't burn a
// number and two simultaneous creates can't be handed the same one.
function nextQuoteNumber() {
  return nextNumber('quotation');
}

router.get('/', requirePermission('quotations', 'view'), (req, res) => {
  const { account_id, opportunity_id, status, q } = req.query;
  let sql = `SELECT q.*, a.account_name FROM quotations q LEFT JOIN accounts a ON a.id = q.account_id WHERE 1=1`;
  const params = [];
  if (account_id) { sql += ' AND q.account_id = ?'; params.push(account_id); }
  if (opportunity_id) { sql += ' AND q.opportunity_id = ?'; params.push(opportunity_id); }
  if (status) { sql += ' AND q.status = ?'; params.push(status); }
  if (q) { sql += ' AND q.quote_number LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY q.quote_date DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requirePermission('quotations', 'view'), (req, res) => {
  const quote = db.prepare(`
    SELECT q.*, a.account_name, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name
    FROM quotations q LEFT JOIN accounts a ON a.id = q.account_id LEFT JOIN contacts c ON c.id = q.contact_id
    WHERE q.id=?
  `).get(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare(`
    SELECT qi.*, p.product_name FROM quotation_items qi LEFT JOIN products p ON p.id = qi.product_id
    WHERE qi.quotation_id=? ORDER BY qi.sort_order, qi.id
  `).all(req.params.id);
  res.json({ ...quote, items, ...relatedActivity('quotations', req.params.id) });
});

// Body: { ...header fields, items: [{ product_id, description, quantity, unit_price, discount_percent, tax_percent }] }
router.post('/', requirePermission('quotations', 'create'), (req, res) => {
  const b = req.body;
  // A quotation with no customer can't be addressed, priced against a
  // currency, or printed — so this stays required. The create form now asks
  // for it (it previously didn't, which is why quotations could only be made
  // from inside an Account).
  if (!b.account_id) return res.status(400).json({ error: 'Choose a customer for this quotation.' });
  const account = db.prepare('SELECT id FROM accounts WHERE id=?').get(b.account_id);
  if (!account) return res.status(400).json({ error: 'That customer no longer exists.' });
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO quotations (
        quote_number, quote_date, valid_until, account_id, contact_id, opportunity_id, billing_address,
        shipping_address, currency, payment_terms, salesperson_id, notes, terms, status,
        overall_discount_type, overall_discount_value
      ) VALUES (@quote_number, @quote_date, @valid_until, @account_id, @contact_id, @opportunity_id, @billing_address,
        @shipping_address, @currency, @payment_terms, @salesperson_id, @notes, @terms, @status,
        @overall_discount_type, @overall_discount_value)
    `).run({
      quote_date: b.quote_date || new Date().toISOString(),
      valid_until: null, contact_id: null, opportunity_id: null, billing_address: null, shipping_address: null,
      currency: 'INR', payment_terms: null, salesperson_id: req.user.id, notes: null, terms: null, status: 'Draft',
      overall_discount_type: 'percent', overall_discount_value: 0,
      ...b,
      // After the spread, not before: the create form posts every field it
      // shows, and an untouched Quote # box arrives as an empty string. Left
      // in the spread that empty string won the merge, and the second
      // quotation of the day collided on the UNIQUE constraint.
      quote_number: b.quote_number || nextQuoteNumber(),
    });
    const quotationId = info.lastInsertRowid;
    const insertItem = db.prepare(`
      INSERT INTO quotation_items (quotation_id, product_id, description, hsn_sac, unit, quantity, unit_price, discount_percent, tax_percent, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    (b.items || []).forEach((item, i) => {
      insertItem.run(quotationId, item.product_id || null, item.description || null,
        item.hsn_sac || null, item.unit || null, item.quantity || 1,
        item.unit_price || 0, item.discount_percent || 0, item.tax_percent || 0, i);
    });
    recalcTotals(quotationId);
    return quotationId;
  });
  const quotationId = tx();
  const createdQuote = db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
  fireWorkflows('quotations', 'record_created', createdQuote, null, req.user.id);
  res.status(201).json({ ...db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId),
    items: db.prepare('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY sort_order').all(quotationId) });
});

router.put('/:id', requirePermission('quotations', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM quotations WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  const m = { ...existing, ...b };

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE quotations SET quote_date=?, valid_until=?, account_id=?, contact_id=?, opportunity_id=?, billing_address=?,
        shipping_address=?, currency=?, payment_terms=?, notes=?, terms=?, status=?,
        overall_discount_type=?, overall_discount_value=?, salesperson_id=?,
        sent_at=CASE WHEN ?='Sent' AND status!='Sent' THEN datetime('now') ELSE sent_at END,
        accepted_at=CASE WHEN ?='Accepted' AND status!='Accepted' THEN datetime('now') ELSE accepted_at END,
        rejected_at=CASE WHEN ?='Rejected' AND status!='Rejected' THEN datetime('now') ELSE rejected_at END,
        updated_at=datetime('now')
      WHERE id=?
    `).run(m.quote_date, m.valid_until, m.account_id, m.contact_id, m.opportunity_id, m.billing_address,
      m.shipping_address, m.currency, m.payment_terms, m.notes, m.terms, m.status,
      m.overall_discount_type || 'percent', Number(m.overall_discount_value) || 0, m.salesperson_id ?? null,
      m.status, m.status, m.status, req.params.id);

    if (Array.isArray(b.items)) {
      db.prepare('DELETE FROM quotation_items WHERE quotation_id=?').run(req.params.id);
      const insertItem = db.prepare(`
        INSERT INTO quotation_items (quotation_id, product_id, description, hsn_sac, unit, quantity, unit_price, discount_percent, tax_percent, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `);
      b.items.forEach((item, i) => {
        insertItem.run(req.params.id, item.product_id || null, item.description || null,
          item.hsn_sac || null, item.unit || null, item.quantity || 1,
          item.unit_price || 0, item.discount_percent || 0, item.tax_percent || 0, i);
      });
    }
    recalcTotals(req.params.id);
  });
  tx();
  const updated = db.prepare('SELECT * FROM quotations WHERE id=?').get(req.params.id);
  if (m.status === 'Sent' && existing.status !== 'Sent') {
    const account = updated.account_id && db.prepare('SELECT account_name FROM accounts WHERE id=?').get(updated.account_id);
    const contact = updated.contact_id && db.prepare("SELECT first_name || ' ' || COALESCE(last_name,'') AS name FROM contacts WHERE id=?").get(updated.contact_id);
    fireEvent('quotation_sent', {
      entityType: 'quotation', entityId: updated.id, mobile: resolveMobile(updated.account_id, updated.contact_id),
      fields: { quote_number: updated.quote_number, account_name: account?.account_name || '', contact_name: contact?.name || '', grand_total: updated.grand_total, valid_until: updated.valid_until },
    });
  }
  fireWorkflows('quotations', 'record_updated', updated, existing, req.user.id);
  fireWorkflows('quotations', 'field_changed', updated, existing, req.user.id);
  res.json({ ...db.prepare('SELECT * FROM quotations WHERE id=?').get(req.params.id),
    items: db.prepare('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY sort_order').all(req.params.id) });
});

router.post('/:id/duplicate', requirePermission('quotations', 'create'), (req, res) => {
  const existing = db.prepare('SELECT * FROM quotations WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id=?').all(req.params.id);
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO quotations (quote_number, quote_date, valid_until, account_id, contact_id, opportunity_id,
        billing_address, shipping_address, currency, payment_terms, salesperson_id, notes, terms, status)
      VALUES (?,datetime('now'),?,?,?,?,?,?,?,?,?,?,?,'Draft')
    `).run(nextQuoteNumber(), existing.valid_until, existing.account_id, existing.contact_id, existing.opportunity_id,
      existing.billing_address, existing.shipping_address, existing.currency, existing.payment_terms, req.user.id,
      existing.notes, existing.terms);
    const newId = info.lastInsertRowid;
    const insertItem = db.prepare(`
      INSERT INTO quotation_items (quotation_id, product_id, description, hsn_sac, unit, quantity, unit_price, discount_percent, tax_percent, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    items.forEach((item) => insertItem.run(newId, item.product_id, item.description, item.hsn_sac, item.unit,
      item.quantity, item.unit_price, item.discount_percent, item.tax_percent, item.sort_order));
    recalcTotals(newId);
    return newId;
  });
  const newId = tx();
  res.status(201).json(db.prepare('SELECT * FROM quotations WHERE id=?').get(newId));
});

router.delete('/:id', requirePermission('quotations', 'delete'), (req, res) => {
  db.prepare('DELETE FROM quotations WHERE id=?').run(req.params.id);
  res.status(204).end();
});

// ===== Conversion =====
// A quotation the customer accepted becomes a proforma invoice (to collect
// payment in advance) or an invoice directly. The figures are copied, not
// recalculated from today's product prices — the customer agreed to what was
// on the quotation, and a price change since then is not something to spring
// on them at the invoice.

router.post('/:id/convert/:target', requirePermission('quotations', 'view'), (req, res) => {
  try {
    res.status(201).json(docs.convertQuotation(req.params.id, req.params.target, req.body || {}, req.user.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// What this quotation became — shown on its own page so nobody raises a
// second invoice for a deal that is already invoiced.
router.get('/:id/lineage', requirePermission('quotations', 'view'), (req, res) => {
  const quote = db.prepare('SELECT id, quote_number, status, grand_total, quote_date FROM quotations WHERE id=?').get(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Not found' });
  const chain = [{
    type: 'quotation', id: quote.id, number: quote.quote_number, status: quote.status,
    total: quote.grand_total, date: quote.quote_date, current: true,
  }];
  db.prepare(`
    SELECT id, doc_type, doc_number, status, grand_total, doc_date, payment_status, balance_due
      FROM sales_documents WHERE quotation_id=? ORDER BY id
  `).all(req.params.id).forEach((d) => chain.push({
    type: d.doc_type, id: d.id, number: d.doc_number, status: d.status,
    total: d.grand_total, date: d.doc_date,
    payment_status: d.payment_status, balance_due: d.balance_due,
  }));
  return res.json(chain);
});

// ===== PDF + send =====
// The quotation PDF now goes through the same template engine as proforma
// invoices and invoices. The old renderer drew a fixed layout and read its
// letterhead from the receipt_templates row for "institute A", hardcoded —
// one company, one design, no way to differ per customer.
//
// Nothing configured is lost: the engine still falls back to that same
// receipt_templates row when the company profile is empty, so an install that
// has only ever set that up keeps printing with the details it already has.
function loadForPdf(id) {
  const quotation = db.prepare(`
    SELECT q.*, a.account_name,
           TRIM(c.first_name || ' ' || COALESCE(c.last_name,'')) AS contact_name,
           c.email AS contact_email
      FROM quotations q
      LEFT JOIN accounts a ON a.id = q.account_id
      LEFT JOIN contacts c ON c.id = q.contact_id
     WHERE q.id=?
  `).get(id);
  if (!quotation) return null;
  const items = db.prepare(`
    SELECT qi.*, p.product_name FROM quotation_items qi
      LEFT JOIN products p ON p.id = qi.product_id
     WHERE qi.quotation_id=? ORDER BY qi.sort_order, qi.id
  `).all(id);
  const calc = engine.calculate(quotation, items, { companyStateCode: docs.companyStateCode() });
  return { ...quotation, items, tax_summary: calc.taxSummary };
}

// GET /api/quotations/:id/pdf
router.get('/:id/pdf', requirePermission('quotations', 'view'), (req, res) => {
  const record = loadForPdf(req.params.id);
  if (!record) return res.status(404).json({ error: 'Quotation not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${String(record.quote_number || 'quotation').replace(/[^\w.-]/g, '_')}.pdf`);
  return buildDocumentPdf({ docType: 'quotation', record, templateId: req.query.template_id, userId: req.user.id }, res);
});

// Same document, shown in the browser instead of downloaded — so a quotation
// can be checked before it is sent rather than after.
router.get('/:id/preview', requirePermission('quotations', 'view'), (req, res) => {
  const record = loadForPdf(req.params.id);
  if (!record) return res.status(404).json({ error: 'Quotation not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  return buildDocumentPdf({ docType: 'quotation', record, templateId: req.query.template_id, userId: req.user.id, preview: true }, res);
});

// POST /api/quotations/:id/send  { to?, subject?, message?, institute? }
// Emails the quotation as a PDF attachment and flips its status to Sent
// (which is the same transition the PUT handler uses, so the existing
// quotation_sent WhatsApp workflow event fires from here too).
router.post('/:id/send', requirePermission('quotations', 'edit'), async (req, res) => {
  const payload = loadForPdf(req.params.id);
  if (!payload) return res.status(404).json({ error: 'Quotation not found' });
  if (!emailConfigured(req.user.id)) {
    return res.status(503).json({ error: "Email isn't configured yet — set it up in Settings → Email." });
  }

  const quotation = payload;
  const to = req.body.to || quotation.contact_email;
  if (!to) return res.status(400).json({ error: 'No recipient — pass "to", or set an email on the linked contact.' });

  try {
    const pdf = await renderDocumentPdfBuffer({ docType: 'quotation', record: payload, templateId: req.body.template_id, userId: req.user.id });
    const subject = req.body.subject || `Quotation ${quotation.quote_number || ''}`.trim();
    const text = req.body.message || `Please find attached quotation ${quotation.quote_number || ''}.`;
    await sendEmail({
      to, subject, text,
      attachments: [{ filename: `${quotation.quote_number || 'quotation'}.pdf`, content: pdf }],
      // Sends from this user's own address where they've configured one.
      userId: req.user.id,
    });

    const existing = db.prepare('SELECT * FROM quotations WHERE id=?').get(req.params.id);
    if (existing.status !== 'Sent') {
      db.prepare(`UPDATE quotations SET status='Sent', sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(req.params.id);
      const updated = db.prepare('SELECT * FROM quotations WHERE id=?').get(req.params.id);
      fireEvent('quotation_sent', {
        entityType: 'quotation', entityId: updated.id, mobile: resolveMobile(updated.account_id, updated.contact_id),
        fields: { quote_number: updated.quote_number, account_name: payload.account_name || '', contact_name: payload.contact_name || '', grand_total: updated.grand_total, valid_until: updated.valid_until },
      });
      fireWorkflows('quotations', 'record_updated', updated, existing, req.user.id);
      fireWorkflows('quotations', 'field_changed', updated, existing, req.user.id);
    }
    res.json({ sent_to: to, quotation: db.prepare('SELECT * FROM quotations WHERE id=?').get(req.params.id) });
  } catch (e) {
    res.status(502).json({ error: 'Could not send: ' + e.message });
  }
});

module.exports = router;
