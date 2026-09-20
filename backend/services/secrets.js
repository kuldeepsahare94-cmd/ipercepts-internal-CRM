// ============================================================================
// Encryption for credentials stored at rest.
// ============================================================================
// OAuth refresh tokens are the most dangerous thing this CRM will ever hold.
// A refresh token for someone's Google account is a long-lived key to their
// calendar and, depending on scopes, more besides — it does not expire when
// they close the browser and it is not tied to a session. Storing one in
// plaintext means a copy of the database is a copy of everyone's calendar
// access, forever, and revoking it means every user re-authorising by hand.
//
// So tokens are encrypted with AES-256-GCM before they touch the database.
// GCM rather than CBC because it authenticates as well as encrypts: a
// tampered ciphertext fails to decrypt instead of quietly producing garbage
// that the code then sends to Google as a token.
//
// WHICH KEY
// This reuses WHATSAPP_ENCRYPTION_KEY when CRM_ENCRYPTION_KEY is not set.
// That is deliberate: the WhatsApp integration already required a 32-byte key
// in production, and asking an administrator to generate, set and never lose a
// SECOND key is how one of them ends up unset — at which point either the
// feature is dead or, worse, someone "fixes" it by storing tokens in the
// clear. One key, two features, documented.
//
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

const crypto = require('crypto');

const KEY_VARS = ['CRM_ENCRYPTION_KEY', 'WHATSAPP_ENCRYPTION_KEY'];

function keyStatus() {
  for (const name of KEY_VARS) {
    const raw = process.env[name];
    if (!raw) continue;
    let buf;
    try { buf = Buffer.from(raw, 'base64'); } catch { return { ok: false, name, reason: 'not valid base64' }; }
    if (buf.length !== 32) return { ok: false, name, reason: `decodes to ${buf.length} bytes, needs 32` };
    return { ok: true, name, key: buf };
  }
  return { ok: false, name: null, reason: 'not set' };
}

// Whether credentials can be stored right now. The calendar settings screen
// calls this so it can say "set CRM_ENCRYPTION_KEY first" up front, rather
// than letting someone walk through an entire OAuth consent flow and then
// failing at the last step with the tokens already issued.
function isAvailable() {
  return keyStatus().ok;
}

function unavailableReason() {
  const s = keyStatus();
  if (s.ok) return null;
  if (!s.name) {
    return 'No encryption key is set on the server. Set CRM_ENCRYPTION_KEY (32 random bytes, base64) '
      + 'before connecting an account — credentials are never stored unencrypted.';
  }
  return `${s.name} is invalid: it ${s.reason}. It must be exactly 32 bytes, base64-encoded.`;
}

function getKey() {
  const s = keyStatus();
  if (!s.ok) throw new Error(unavailableReason());
  return s.key;
}

// encrypt(value) -> "iv:authTag:ciphertext", all base64, safe to store as TEXT.
// Matches the format services/whatsapp/crypto.js already writes, so the two
// remain interchangeable if they are ever merged.
function encrypt(value) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(packed) {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = String(packed).split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Stored credential is not in the expected format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

function encryptJSON(obj) { return encrypt(JSON.stringify(obj)); }
function decryptJSON(packed) { return JSON.parse(decrypt(packed)); }

module.exports = { encrypt, decrypt, encryptJSON, decryptJSON, isAvailable, unavailableReason };
