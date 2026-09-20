const PDFDocument = require('pdfkit');

// Renders a payment receipt as a PDF stream, using whichever institute
// template ('A' or 'B') is passed in. Templates are configurable from the
// admin panel (receipt_templates table) — see routes/receiptTemplates.js.
//
// `payer` is a generic { name, subLabel, referenceLabel, referenceValue }
// shape built by the caller (routes/payments.js) — it works the same way
// whether the payment is a legacy student-fee payment (name: student name,
// subLabel: mobile, referenceLabel: "Admission No", referenceValue: the
// admission number) or a generic one linked to an Account/Opportunity
// (name: account name, subLabel: contact name, referenceLabel:
// "Opportunity"/"Quotation", referenceValue: its name/number). This is what
// makes the receipt industry-generic instead of assuming a student/course.
function generateReceiptPdf({ payment, payer, lineDescription, template }, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=Receipt-${payment.payment_number}-Institute${template.id}.pdf`);
  doc.pipe(res);

  // Header
  doc.fontSize(18).fillColor('#111827').text(template.institute_name || `Institute ${template.id}`, { align: 'left' });
  doc.fontSize(9).fillColor('#4b5563').text(template.address || '', { align: 'left' });
  if (template.gst_details) doc.text(template.gst_details, { align: 'left' });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#d1d5db').stroke();
  doc.moveDown();

  doc.fontSize(14).fillColor('#111827').text('Payment Receipt', { align: 'center' });
  doc.moveDown();

  // Receipt meta
  const metaY = doc.y;
  doc.fontSize(10).fillColor('#374151');
  doc.text(`Receipt No: ${payment.payment_number}`, 50, metaY);
  doc.text(`Date: ${(payment.payment_date || payment.created_at || '').slice(0, 10)}`, 320, metaY);
  doc.moveDown(1.5);

  // Payer details — generic, works for any linked record type
  doc.fontSize(11).fillColor('#111827').text('Received From', { underline: true });
  doc.fontSize(10).fillColor('#374151');
  doc.text(`Name: ${payer.name || '-'}`);
  if (payer.subLabel) doc.text(payer.subLabel);
  if (payer.referenceLabel && payer.referenceValue) doc.text(`${payer.referenceLabel}: ${payer.referenceValue}`);
  doc.moveDown();

  // Payment table
  const tableTop = doc.y;
  doc.fontSize(10).fillColor('#111827');
  doc.text('Description', 50, tableTop, { width: 250 });
  doc.text('Installment', 300, tableTop, { width: 90 });
  doc.text('Amount (INR)', 400, tableTop, { width: 140, align: 'right' });
  doc.moveTo(50, tableTop + 16).lineTo(545, tableTop + 16).strokeColor('#d1d5db').stroke();

  const rowY = tableTop + 24;
  doc.fontSize(10).fillColor('#374151');
  doc.text(lineDescription || payment.description || 'Payment', 50, rowY, { width: 250 });
  doc.text(`#${payment.installment_number}`, 300, rowY, { width: 90 });
  doc.text(Number(payment.amount || 0).toLocaleString('en-IN'), 400, rowY, { width: 140, align: 'right' });
  doc.moveTo(50, rowY + 20).lineTo(545, rowY + 20).strokeColor('#d1d5db').stroke();

  doc.fontSize(11).fillColor('#111827').text('Total Paid:', 300, rowY + 30, { width: 90 });
  doc.text(`INR ${Number(payment.amount || 0).toLocaleString('en-IN')}`, 400, rowY + 30, { width: 140, align: 'right' });

  doc.moveDown(3);
  doc.fontSize(9).fillColor('#374151');
  doc.text(`Payment Mode: ${payment.payment_mode || '-'}`);
  if (payment.transaction_number) doc.text(`Transaction No: ${payment.transaction_number}`);
  doc.text(`Status: ${payment.status}`);

  doc.moveDown(3);
  doc.fontSize(8).fillColor('#6b7280').text(template.footer_text || '', { align: 'center' });

  doc.end();
}

module.exports = { generateReceiptPdf };
