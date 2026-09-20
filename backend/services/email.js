// SMTP email sending — works with Gmail, Outlook, or any standard mail server.
// Requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in the environment.
// For Gmail specifically: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587, and
// SMTP_PASS must be an "App Password" (Google Account → Security → App
// Passwords) — a normal Gmail password will NOT work due to Google's
// security policy, this is not something this code can work around.
const nodemailer = require('nodemailer');
const db = require('../db');
const { decrypt } = require('./whatsapp/crypto');

// Resolves which mailbox a message should go out from, in priority order:
//   1. the sending user's own configured identity (so the customer sees
//      the actual person's address, not a generic one)
//   2. the organisation account configured in Settings
//   3. the SMTP_* environment variables (the original behaviour, kept so
//      existing deployments keep working untouched)
function resolveAccount(userId) {
  try {
    if (userId) {
      const own = db.prepare("SELECT * FROM email_accounts WHERE scope='user' AND user_id=? AND active=1").get(userId);
      if (own && own.smtp_pass_encrypted) return { source: 'user', acct: own };
    }
    const org = db.prepare("SELECT * FROM email_accounts WHERE scope='org' AND active=1").get();
    if (org && org.smtp_pass_encrypted) return { source: 'org', acct: org };
  } catch {
    // Table may not exist on an older database — fall through to env vars.
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return { source: 'env', acct: null };
  }
  return null;
}

function isConfigured(userId) {
  return !!resolveAccount(userId);
}

function getTransporter() {
  if (!isConfigured()) {
    throw new Error('Email is not configured yet — set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS on the backend.');
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465, // true for port 465, false for 587/others (STARTTLS)
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // See resolveAccount's transporter below — forces IPv4 so hosts without
    // outbound IPv6 don't fail with ENETUNREACH resolving smtp.gmail.com.
    family: 4,
  });
}

/**
 * @param {{to: string, subject: string, text?: string, html?: string, attachments?: Array}} opts
 */
// `userId` is optional. Pass it and the mail goes out from that user's own
// configured address where they have one; omit it for system mail.
async function sendEmail({ to, subject, text, html, attachments, userId }) {
  const resolved = resolveAccount(userId);
  if (!resolved) {
    throw new Error('Email is not configured yet — set it up in Settings → Email, or set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS on the backend.');
  }

  if (resolved.source === 'env') {
    const info = await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, text, html, attachments,
    });
    return { messageId: info.messageId, sent_from: process.env.SMTP_FROM || process.env.SMTP_USER, source: 'env' };
  }

  const { acct } = resolved;
  const transporter = nodemailer.createTransport({
    host: acct.smtp_host,
    port: Number(acct.smtp_port || 587),
    secure: Number(acct.smtp_port) === 465,
    auth: { user: acct.smtp_user, pass: decrypt(acct.smtp_pass_encrypted) },
    // Many hosts have no outbound IPv6 route, so an IPv6 DNS answer for
    // smtp.gmail.com fails immediately with ENETUNREACH. Forcing IPv4
    // sidesteps that — see buildTransport in routes/emailSettings.js.
    family: 4,
  });
  const from = acct.from_name ? `"${acct.from_name}" <${acct.from_email}>` : acct.from_email;
  const info = await transporter.sendMail({ from, to, subject, text, html, attachments });
  return { messageId: info.messageId, sent_from: acct.from_email, source: resolved.source };
}

module.exports = { sendEmail, isConfigured };
