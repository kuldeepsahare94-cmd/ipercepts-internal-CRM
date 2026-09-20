// ============================================================================
// Inbound email — fetch from IMAP, match to a CRM record, store.
// ============================================================================
// Design notes worth knowing:
//
// * Matching is by sender address against Contacts, then Leads, then
//   Accounts. If nothing matches, the message is still imported but left
//   UNLINKED rather than guessed at — a mis-filed email on the wrong
//   customer's timeline is worse than one sitting in an inbox tray.
//
// * `matched_by` records HOW each message was linked, so the UI can be
//   honest about it and a human can correct a bad match.
//
// * Deduplication is on RFC Message-ID with a unique index, so re-running a
//   sync can never duplicate a conversation.
//
// * Attachments are written to the same uploads directory Documents uses.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { decrypt } = require('./whatsapp/crypto');

const { UPLOAD_DIR } = require('../dataDir');

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

function normaliseAddress(a) {
  return String(a || '').trim().toLowerCase();
}

// Threading key: prefer the root of the reply chain so a whole back-and-forth
// groups together; fall back to a normalised subject.
function threadKeyFor({ inReplyTo, references, subject }) {
  const root = (references && references.length) ? references[0] : inReplyTo;
  if (root) return `ref:${root}`;
  const clean = String(subject || '(no subject)')
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '')
    .trim().toLowerCase();
  return `subj:${clean}`;
}

/**
 * Finds the CRM record an inbound message belongs to.
 * Returns { module, id, matched_by } or null when nothing matches.
 */
function matchRecord(fromAddress) {
  const addr = normaliseAddress(fromAddress);
  if (!addr) return null;

  const contact = db.prepare('SELECT id, account_id FROM contacts WHERE lower(email)=?').get(addr);
  if (contact) return { module: 'contacts', id: contact.id, matched_by: 'contact email' };

  const lead = db.prepare('SELECT id FROM leads WHERE lower(email)=?').get(addr);
  if (lead) return { module: 'leads', id: lead.id, matched_by: 'lead email' };

  const account = db.prepare('SELECT id FROM accounts WHERE lower(email)=?').get(addr);
  if (account) return { module: 'accounts', id: account.id, matched_by: 'account email' };

  // Domain fallback — useful when someone writes in from a colleague's
  // address. Only applied to accounts, and only when the domain is
  // unambiguous, so a shared provider domain can't sweep everyone in.
  const domain = addr.split('@')[1];
  const genericDomains = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'rediffmail.com']);
  if (domain && !genericDomains.has(domain)) {
    const byDomain = db.prepare(`SELECT id FROM accounts WHERE lower(email) LIKE ? OR lower(website) LIKE ?`)
      .all(`%@${domain}`, `%${domain}%`);
    if (byDomain.length === 1) return { module: 'accounts', id: byDomain[0].id, matched_by: `domain ${domain}` };
  }
  return null;
}

function saveAttachments(emailId, attachments) {
  if (!attachments || !attachments.length) return 0;
  const insert = db.prepare(`INSERT INTO email_attachments (email_id, file_name, stored_name, mime_type, size_bytes)
                             VALUES (?,?,?,?,?)`);
  let saved = 0;
  for (const att of attachments) {
    if (!att.content || att.size > MAX_ATTACHMENT_BYTES) continue;
    const ext = path.extname(att.filename || '').slice(0, 12);
    const storedName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, storedName), att.content);
      insert.run(emailId, att.filename || 'attachment', storedName, att.contentType || null, att.size || null);
      saved++;
    } catch { /* skip this attachment, keep the message */ }
  }
  return saved;
}

/**
 * Stores one parsed message. Idempotent: a duplicate Message-ID is skipped.
 * Exported separately from the IMAP transport so it can be tested and so a
 * webhook-based provider could reuse it later without touching IMAP.
 */
function storeInboundMessage(accountId, parsed, uid) {
  const messageId = parsed.messageId || null;
  if (messageId) {
    const existing = db.prepare('SELECT id FROM emails WHERE message_id=?').get(messageId);
    if (existing) return { skipped: true, reason: 'already imported', id: existing.id };
  }

  const from = parsed.from?.value?.[0]?.address || parsed.from?.text || '';
  const to = (parsed.to?.value || []).map((v) => v.address).join(', ') || parsed.to?.text || '';
  const cc = (parsed.cc?.value || []).map((v) => v.address).join(', ') || null;
  const match = matchRecord(from);
  // Threading: a reply should join the thread its parent is ALREADY in, so
  // look the parent up by Message-ID and inherit its key. Deriving a key
  // from the reference alone produced orphaned threads, because the parent's
  // own key was subject-derived (it had nothing to reference).
  const refs = Array.isArray(parsed.references)
    ? parsed.references
    : (parsed.references ? [parsed.references] : []);
  const candidateIds = [parsed.inReplyTo, ...refs].filter(Boolean);
  let threadKey = null;
  for (const ref of candidateIds) {
    const parent = db.prepare('SELECT thread_key FROM emails WHERE message_id=?').get(ref);
    if (parent?.thread_key) { threadKey = parent.thread_key; break; }
  }
  if (!threadKey) {
    threadKey = threadKeyFor({ inReplyTo: parsed.inReplyTo, references: refs, subject: parsed.subject });
  }

  const info = db.prepare(`
    INSERT INTO emails (subject, from_address, to_address, cc_address, related_module, related_record_id,
      direction, status, body, body_html, message_id, in_reply_to, thread_key, account_id, uid,
      is_read, has_attachments, matched_by, received_at, sent_at)
    VALUES (?,?,?,?,?,?, 'Inbound', 'Received', ?,?,?,?,?,?,?, 0, ?, ?, ?, ?)
  `).run(
    parsed.subject || '(no subject)', from, to, cc,
    match?.module || null, match?.id || null,
    parsed.text || '', parsed.html || null,
    messageId, parsed.inReplyTo || null, threadKey, accountId, uid || null,
    (parsed.attachments && parsed.attachments.length) ? 1 : 0,
    match?.matched_by || null,
    (parsed.date || new Date()).toISOString(),
    (parsed.date || new Date()).toISOString()
  );

  const emailId = info.lastInsertRowid;
  saveAttachments(emailId, parsed.attachments);
  return { skipped: false, id: emailId, matched: !!match, matched_by: match?.matched_by || null };
}

/**
 * Polls one configured mailbox over IMAP. Only fetches messages newer than
 * the last UID we saw, so repeated runs are cheap.
 * `imapflow` and `mailparser` are required lazily so the rest of the app —
 * and its tests — don't pay for them unless inbound is actually used.
 */
async function syncAccount(accountId) {
  const acct = db.prepare('SELECT * FROM email_accounts WHERE id=? AND inbound_enabled=1').get(accountId);
  if (!acct) return { ok: false, error: 'Inbound is not enabled for this account.' };
  if (!acct.imap_host || !acct.imap_user || !acct.imap_pass_encrypted) {
    return { ok: false, error: 'IMAP host, username and password must all be set.' };
  }

  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');

  const state = db.prepare('SELECT * FROM email_sync_state WHERE account_id=?').get(accountId)
    || { last_uid: 0, messages_imported: 0 };

  const client = new ImapFlow({
    host: acct.imap_host,
    port: Number(acct.imap_port || 993),
    secure: true,
    auth: { user: acct.imap_user, pass: decrypt(acct.imap_pass_encrypted) },
    logger: false,
  });

  let imported = 0, skipped = 0, matched = 0, maxUid = state.last_uid || 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const range = `${(state.last_uid || 0) + 1}:*`;
      for await (const msg of client.fetch({ uid: range }, { uid: true, source: true })) {
        if (msg.uid <= (state.last_uid || 0)) continue;   // server may return the boundary message
        maxUid = Math.max(maxUid, msg.uid);
        try {
          const parsed = await simpleParser(msg.source);
          const result = storeInboundMessage(accountId, parsed, msg.uid);
          if (result.skipped) skipped++;
          else { imported++; if (result.matched) matched++; }
        } catch {
          skipped++;   // one unparseable message must not stop the sync
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();

    db.prepare(`INSERT INTO email_sync_state (account_id, last_uid, last_synced_at, last_error, messages_imported)
                VALUES (?,?,datetime('now'),NULL,?)
                ON CONFLICT(account_id) DO UPDATE SET
                  last_uid=excluded.last_uid, last_synced_at=excluded.last_synced_at,
                  last_error=NULL, messages_imported=email_sync_state.messages_imported + excluded.messages_imported`)
      .run(accountId, maxUid, imported);

    return { ok: true, imported, skipped, matched, unmatched: imported - matched, last_uid: maxUid };
  } catch (e) {
    const friendly = /auth|login|535/i.test(e.message)
      ? 'IMAP authentication failed. For Gmail this must be an App Password.'
      : /ENOTFOUND|EAI_AGAIN/i.test(e.message) ? 'Could not reach that IMAP host — check the hostname.'
      : /ECONNREFUSED|ETIMEDOUT/i.test(e.message) ? 'Connection refused or timed out — check the port and firewall.'
      : e.message;
    db.prepare(`INSERT INTO email_sync_state (account_id, last_uid, last_synced_at, last_error)
                VALUES (?,?,datetime('now'),?)
                ON CONFLICT(account_id) DO UPDATE SET last_synced_at=excluded.last_synced_at, last_error=excluded.last_error`)
      .run(accountId, state.last_uid || 0, friendly);
    try { await client.logout(); } catch { /* already closed */ }
    return { ok: false, error: friendly };
  }
}

// Polls every mailbox with inbound switched on.
async function syncAll() {
  const accounts = db.prepare('SELECT id FROM email_accounts WHERE inbound_enabled=1 AND active=1').all();
  const results = [];
  for (const a of accounts) {
    results.push({ account_id: a.id, ...(await syncAccount(a.id)) });
  }
  return results;
}

// Background poller. Interval is configurable; defaults to 5 minutes, which
// is frequent enough to feel live without hammering the mail server.
let timer = null;
function startPolling() {
  const minutes = Number(process.env.EMAIL_POLL_MINUTES || 5);
  if (timer || minutes <= 0) return;
  const hasInbound = db.prepare('SELECT COUNT(*) c FROM email_accounts WHERE inbound_enabled=1').get().c;
  if (!hasInbound) return;   // nothing to poll; started on demand when enabled
  timer = setInterval(() => { syncAll().catch(() => {}); }, minutes * 60 * 1000);
  if (timer.unref) timer.unref();   // never hold the process open
}

module.exports = { syncAccount, syncAll, startPolling, storeInboundMessage, matchRecord, threadKeyFor };
