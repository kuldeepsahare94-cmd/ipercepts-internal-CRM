// Central place that records what actually happened on an email attempt —
// to both stdout (for whoever has hosting-dashboard access) AND a queryable
// table (for everyone else, via GET /api/email-settings/diagnostics).
//
// The distinction that matters: `error.message` (raw, from nodemailer/IMAP)
// is what actually explains a failure. A "friendly" message is a
// necessary translation for the UI, but translations lose information —
// this keeps the original next to it so nothing has to be guessed at twice.

const crypto = require('crypto');
const db = require('../db');

function newRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

function logEmailAttempt({
  requestId, kind, accountScope, userId, smtpHost, smtpPort, toAddress,
  outcome, durationMs, error, friendlyMessage,
}) {
  const errorCode = error?.code || null;
  const errorMessage = error ? (error.message || String(error)) : null;

  // Console line first — visible immediately in `vercel logs` / Render logs
  // for anyone who does have dashboard access, without waiting on a DB read.
  const line = `[email:${kind}] req=${requestId} outcome=${outcome} host=${smtpHost || '-'}:${smtpPort || '-'}`
    + (errorCode ? ` code=${errorCode}` : '') + (errorMessage ? ` error="${errorMessage}"` : '');
  outcome === 'success' ? console.log(line) : console.error(line);

  try {
    db.prepare(`INSERT INTO email_diagnostic_log
      (request_id, kind, account_scope, user_id, smtp_host, smtp_port, to_address,
       outcome, duration_ms, error_code, error_message, friendly_message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(requestId, kind, accountScope || null, userId || null, smtpHost || null, smtpPort || null,
        toAddress || null, outcome, durationMs || null, errorCode, errorMessage, friendlyMessage || null);
  } catch (e) {
    // Logging must never be the reason a request fails.
    console.error('[email:log] could not persist diagnostic row:', e.message);
  }
}

module.exports = { newRequestId, logEmailAttempt };
