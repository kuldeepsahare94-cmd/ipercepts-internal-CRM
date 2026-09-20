const PDFDocument = require('pdfkit');

// Renders a quotation as a PDF. Reuses the same receipt_templates rows the
// payment receipts use (institute_name / address / gst_details /
// footer_text) so a company's letterhead details live in one place rather
// than being configured twice.
//
// `stream` is either an Express response (for download) or any writable
// stream (used by the email path to buffer the PDF into an attachment).
function buildQuotationPdf({ quotation, items, template }, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(stream);

  const money = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Letterhead
  doc.fontSize(18).fillColor('#111827').text(template?.institute_name || 'Quotation', { align: 'left' });
  if (template?.address) doc.fontSize(9).fillColor('#4b5563').text(template.address);
  if (template?.gst_details) doc.fontSize(9).fillColor('#4b5563').text(template.gst_details);
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#d1d5db').stroke();
  doc.moveDown();

  doc.fontSize(14).fillColor('#111827').text('Quotation', { align: 'center' });
  doc.moveDown();

  // Meta block
  const metaY = doc.y;
  doc.fontSize(10).fillColor('#374151');
  doc.text(`Quote No: ${quotation.quote_number || '-'}`, 50, metaY);
  doc.text(`Date: ${(quotation.quote_date || '').slice(0, 10)}`, 320, metaY);
  if (quotation.valid_until) doc.text(`Valid Until: ${String(quotation.valid_until).slice(0, 10)}`, 320, metaY + 14);
  doc.moveDown(2);

  // Bill-to
  doc.fontSize(11).fillColor('#111827').text('Bill To', { underline: true });
  doc.fontSize(10).fillColor('#374151');
  doc.text(quotation.account_name || '-');
  if (quotation.contact_name && quotation.contact_name.trim()) doc.text(`Attn: ${quotation.contact_name.trim()}`);
  if (quotation.billing_address) doc.text(quotation.billing_address);
  doc.moveDown();

  // Items table header
  const tableTop = doc.y;
  doc.fontSize(9).fillColor('#111827');
  doc.text('#', 50, tableTop, { width: 20 });
  doc.text('Description', 72, tableTop, { width: 210 });
  doc.text('Qty', 288, tableTop, { width: 34, align: 'right' });
  doc.text('Rate', 326, tableTop, { width: 64, align: 'right' });
  doc.text('Disc%', 394, tableTop, { width: 38, align: 'right' });
  doc.text('Tax%', 436, tableTop, { width: 34, align: 'right' });
  doc.text('Amount', 474, tableTop, { width: 71, align: 'right' });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).strokeColor('#d1d5db').stroke();

  let y = tableTop + 22;
  doc.fontSize(9).fillColor('#374151');
  items.forEach((item, i) => {
    // Simple page-break guard so a long quote doesn't overflow off the page.
    if (y > 700) { doc.addPage(); y = 60; }
    const label = item.product_name || item.description || 'Item';
    doc.text(String(i + 1), 50, y, { width: 20 });
    doc.text(label, 72, y, { width: 210 });
    doc.text(String(item.quantity ?? 1), 288, y, { width: 34, align: 'right' });
    doc.text(money(item.unit_price), 326, y, { width: 64, align: 'right' });
    doc.text(String(item.discount_percent || 0), 394, y, { width: 38, align: 'right' });
    doc.text(String(item.tax_percent || 0), 436, y, { width: 34, align: 'right' });
    doc.text(money(item.line_total), 474, y, { width: 71, align: 'right' });
    y += 18;
  });
  if (items.length === 0) {
    doc.fillColor('#9ca3af').text('No line items on this quotation.', 72, y);
    y += 18;
  }

  doc.moveTo(50, y + 2).lineTo(545, y + 2).strokeColor('#d1d5db').stroke();
  y += 12;

  // Totals
  const totalRow = (label, value, bold) => {
    doc.fontSize(bold ? 11 : 9).fillColor(bold ? '#111827' : '#374151');
    doc.text(label, 326, y, { width: 108, align: 'right' });
    doc.text(value, 440, y, { width: 105, align: 'right' });
    y += bold ? 18 : 14;
  };
  totalRow('Subtotal', money(quotation.subtotal));
  if (Number(quotation.total_discount)) totalRow('Discount', `- ${money(quotation.total_discount)}`);
  if (Number(quotation.tax_total)) totalRow('Tax', money(quotation.tax_total));
  totalRow('Grand Total', `${quotation.currency || 'INR'} ${money(quotation.grand_total)}`, true);

  // Notes / terms
  if (quotation.notes) {
    doc.moveDown(1.5).fontSize(9).fillColor('#111827').text('Notes', 50, doc.y, { underline: true });
    doc.fillColor('#374151').text(quotation.notes, { width: 495 });
  }
  if (quotation.terms) {
    doc.moveDown(1).fontSize(9).fillColor('#111827').text('Terms & Conditions', { underline: true });
    doc.fillColor('#374151').text(quotation.terms, { width: 495 });
  }
  if (quotation.payment_terms) {
    doc.moveDown(0.5).fontSize(9).fillColor('#374151').text(`Payment Terms: ${quotation.payment_terms}`);
  }

  if (template?.footer_text) {
    doc.moveDown(2).fontSize(8).fillColor('#6b7280').text(template.footer_text, { align: 'center' });
  }

  doc.end();
}

// Buffers the PDF in memory instead of streaming it — used by the email
// path, which needs the whole file as an attachment before sending.
function renderQuotationPdfBuffer(payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = {
      write: (c) => chunks.push(c),
      end: () => resolve(Buffer.concat(chunks)),
      on: () => {},
      once: () => {},
      emit: () => {},
    };
    try { buildQuotationPdf(payload, sink); } catch (e) { reject(e); }
  });
}

module.exports = { buildQuotationPdf, renderQuotationPdfBuffer };
