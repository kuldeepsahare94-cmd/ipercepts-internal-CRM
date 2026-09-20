// AES-256-GCM encryption for WhatsApp provider credentials at rest.
// Requires WHATSAPP_ENCRYPTION_KEY (32 bytes, base64) in the environment —
// generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
const crypto = require('crypto');

function getKey() {
  const raw = process.env.WHATSAPP_ENCRYPTION_KEY;
  if (!raw) throw new Error('WHATSAPP_ENCRYPTION_KEY is not set on the backend — WhatsApp credentials cannot be stored securely until it is.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('WHATSAPP_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded).');
  return key;
}

// encrypt(plainObjectOrString) -> "iv:authTag:ciphertext" (all base64), safe to store as TEXT
function encrypt(value) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

// decrypt("iv:authTag:ciphertext") -> original string
function decrypt(packed) {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = packed.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

function decryptJSON(packed) {
  return JSON.parse(decrypt(packed));
}

module.exports = { encrypt, decrypt, decryptJSON };
