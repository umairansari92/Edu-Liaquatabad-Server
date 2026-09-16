import crypto from 'crypto';
import { hashPassword, verifyPassword } from './passwordUtils.js';

// Base32 alphabet for RFC 4648
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Retrieve dedicated MFA encryption key (AES-256-GCM).
 * Strictly isolated from PASSWORD_PEPPER.
 * Fails closed in production if missing.
 */
export const getMfaEncryptionKey = () => {
  const envKey = process.env.MFA_ENCRYPTION_KEY;
  if (!envKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL SECURITY ERROR: MFA_ENCRYPTION_KEY is required in production.');
    }
    // Deterministic 32-byte key for development and test environments only
    return Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
  }

  // Support 64-character hex or raw 32-byte string/base64
  if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }
  const keyBuf = Buffer.from(envKey, 'utf8');
  if (keyBuf.length === 32) {
    return keyBuf;
  }
  // Hash to exactly 32 bytes if length is non-standard
  return crypto.createHash('sha256').update(envKey).digest();
};

/**
 * Encrypt MFA secret seed at rest using AES-256-GCM with authentication tag.
 * @param {string} plaintextSecret 
 * @returns {{ ciphertext: string, iv: string, tag: string }}
 */
export const encryptMfaSecret = (plaintextSecret) => {
  if (!plaintextSecret) {
    throw new Error('Plaintext secret is required for encryption');
  }
  const key = getMfaEncryptionKey();
  const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintextSecret, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    tag,
  };
};

/**
 * Decrypt MFA secret seed using AES-256-GCM with authenticated tag verification.
 * Fails safely if ciphertext or authentication tag is corrupted.
 * @param {{ ciphertext: string, iv: string, tag: string }} payload 
 * @returns {string} Plaintext secret
 */
export const decryptMfaSecret = ({ ciphertext, iv, tag }) => {
  if (!ciphertext || !iv || !tag) {
    throw new Error('Ciphertext, IV, and auth tag are all required for decryption');
  }
  const key = getMfaEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

/**
 * Encode Buffer to Base32 string without padding.
 * @param {Buffer} buffer 
 * @returns {string}
 */
export const toBase32 = (buffer) => {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
};

/**
 * Decode Base32 string to Buffer.
 * @param {string} base32String 
 * @returns {Buffer}
 */
export const fromBase32 = (base32String) => {
  const cleanStr = base32String.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < cleanStr.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleanStr[i]);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${cleanStr[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};

/**
 * Generate 20-byte cryptographically secure random Base32 TOTP secret.
 * @returns {string} 32-character Base32 string
 */
export const generateTotpSecret = () => {
  const randomBytes = crypto.randomBytes(20);
  return toBase32(randomBytes);
};

/**
 * Generate standard otpauth:// URI for authenticator apps.
 * @param {{ secret: string, accountName: string, issuer?: string }} options 
 * @returns {string}
 */
export const generateTotpUri = ({ secret, accountName, issuer = 'Liaquatabad Education DMC' }) => {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedAccount = encodeURIComponent(accountName);
  return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
};

/**
 * Generate 6-digit TOTP token for an explicit time-step window counter.
 * RFC 6238 / RFC 4226 implementation using Node.js crypto.
 * @param {string} base32Secret 
 * @param {number} windowCounter 
 * @returns {string} 6-digit zero-padded string
 */
export const generateTotpForWindow = (base32Secret, windowCounter) => {
  const key = fromBase32(base32Secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(windowCounter), 0);

  const hmac = crypto.createHmac('sha1', key);
  hmac.update(counterBuffer);
  const digest = hmac.digest();

  // Dynamic truncation (RFC 4226 section 5.4)
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
};

/**
 * Generate TOTP token for the current time or with offset.
 * @param {string} base32Secret 
 * @param {number} stepOffset (e.g. -1 for 30s past, +1 for 30s future)
 * @param {number} timestampMs 
 * @returns {string}
 */
export const generateTotpToken = (base32Secret, stepOffset = 0, timestampMs = Date.now()) => {
  const currentWindow = Math.floor(timestampMs / 30000) + stepOffset;
  return generateTotpForWindow(base32Secret, currentWindow);
};

/**
 * Validate incoming 6-digit TOTP token against RFC 6238 window range [W-1, W, W+1].
 * Monotonic constraint: matchedWindow MUST be strictly greater than lastConsumedWindow
 * to prevent replay of the same window or any older window.
 * 
 * @param {string} base32Secret 
 * @param {string} candidateToken 
 * @param {number} lastConsumedWindow 
 * @param {number} timestampMs 
 * @returns {{ valid: boolean, matchedWindow: number|null, reason?: string }}
 */
export const verifyTotpToken = (
  base32Secret,
  candidateToken,
  lastConsumedWindow = 0,
  timestampMs = Date.now()
) => {
  if (!candidateToken || typeof candidateToken !== 'string') {
    return { valid: false, matchedWindow: null, reason: 'INVALID_FORMAT' };
  }

  const cleanToken = candidateToken.trim();
  if (!/^\d{6}$/.test(cleanToken)) {
    return { valid: false, matchedWindow: null, reason: 'INVALID_FORMAT' };
  }

  const currentWindow = Math.floor(timestampMs / 30000);
  // Allowed drift: [-1, 0, +1] (covers 30s past, current, and 30s future)
  const candidateWindows = [currentWindow, currentWindow - 1, currentWindow + 1];

  for (const win of candidateWindows) {
    const expected = generateTotpForWindow(base32Secret, win);
    if (crypto.timingSafeEqual(Buffer.from(cleanToken), Buffer.from(expected))) {
      // Replay prevention: window must be strictly greater than lastConsumedWindow
      if (win <= lastConsumedWindow) {
        return { valid: false, matchedWindow: null, reason: 'WINDOW_ALREADY_CONSUMED' };
      }
      return { valid: true, matchedWindow: win };
    }
  }

  return { valid: false, matchedWindow: null, reason: 'MISMATCH' };
};

/**
 * Generate 8 cryptographically secure single-use recovery codes.
 * Returns plain codes (shown to user ONCE upon enrollment) and Argon2id hashed entries for DB persistence.
 * @param {number} count 
 * @returns {Promise<{ plainCodes: string[], hashedCodes: { codeHash: string, usedAt: null }[] }>}
 */
export const generateRecoveryCodes = async (count = 8) => {
  const plainCodes = [];
  const hashedCodes = [];

  for (let i = 0; i < count; i++) {
    // 16 alphanumeric characters split into 4x4 blocks for readability (e.g. ABCD-EFGH-1234-5678)
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
    plainCodes.push(formatted);

    // Normalize code (strip dashes and lowercase) before hashing with Argon2id + salt
    const normalized = formatted.replace(/-/g, '').toLowerCase();
    const codeHash = await hashPassword(normalized);
    hashedCodes.push({
      codeHash,
      usedAt: null,
    });
  }

  return { plainCodes, hashedCodes };
};

/**
 * Verify plaintext candidate recovery code against list of unconsumed hashed recovery codes.
 * @param {string} candidatePlainCode 
 * @param {Array<{ _id: any, codeHash: string, usedAt: Date|null }>} storedCodes 
 * @returns {Promise<{ valid: boolean, matchedSubdocId: any|null }>}
 */
export const verifyRecoveryCode = async (candidatePlainCode, storedCodes = []) => {
  if (!candidatePlainCode || typeof candidatePlainCode !== 'string') {
    return { valid: false, matchedSubdocId: null };
  }

  const normalizedCandidate = candidatePlainCode.replace(/-/g, '').trim().toLowerCase();
  if (normalizedCandidate.length !== 16) {
    return { valid: false, matchedSubdocId: null };
  }

  for (const item of storedCodes) {
    if (!item.usedAt && item.codeHash) {
      const isMatch = await verifyPassword(normalizedCandidate, item.codeHash);
      if (isMatch) {
        return { valid: true, matchedSubdocId: item._id };
      }
    }
  }

  return { valid: false, matchedSubdocId: null };
};
