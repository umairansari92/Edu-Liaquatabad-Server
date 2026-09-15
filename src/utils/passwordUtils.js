import bcrypt from 'bcryptjs';
import { hash as argon2Hash, verify as argon2Verify, parseOptions, Algorithm } from '@node-rs/argon2';

/**
 * OWASP 2026 Recommended Baseline Parameters for Argon2id
 * - Memory cost: 19456 KiB (~19 MiB)
 * - Time cost / Iterations: 2 passes
 * - Parallelism: 1 thread
 * - Algorithm: Argon2id (hybrid data-dependent and data-independent memory access)
 */
export const ARGON2_CONFIG = Object.freeze({
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  algorithm: Algorithm.Argon2id,
});

/**
 * Retrieve peppered password string.
 * High-entropy server secret is appended to password prior to cryptographic key derivation.
 * Fails closed in production if PASSWORD_PEPPER is missing.
 */
export const getPepperedPassword = (plainPassword) => {
  const serverPepper = process.env.PASSWORD_PEPPER;
  if (!serverPepper) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL SECURITY ERROR: PASSWORD_PEPPER environment variable is mandatory in production.');
    }
    return `${plainPassword}liaquatabad_dmc_default_pepper_key_2026`;
  }
  return `${plainPassword}${serverPepper}`;
};

/**
 * Check if a stored hash was generated using legacy bcrypt
 */
export const isBcryptHash = (storedHash) => {
  if (typeof storedHash !== 'string') return false;
  return storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$');
};

/**
 * Check if a stored hash was generated using Argon2id
 */
export const isArgon2idHash = (storedHash) => {
  if (typeof storedHash !== 'string') return false;
  return storedHash.startsWith('$argon2id$');
};

/**
 * Determine whether a stored hash needs opportunistic re-hashing to modern Argon2id policy.
 * Returns true if:
 * 1. The hash is a legacy bcrypt hash ($2a$, $2b$, $2y$).
 * 2. The hash is an Argon2id hash but uses weaker memoryCost or timeCost than current policy.
 */
export const needsPasswordRehash = (storedHash) => {
  if (!storedHash || typeof storedHash !== 'string') return false;

  if (isBcryptHash(storedHash)) {
    return true;
  }

  if (isArgon2idHash(storedHash)) {
    try {
      const parsedOptions = parseOptions(storedHash);
      return (
        parsedOptions.memoryCost < ARGON2_CONFIG.memoryCost ||
        parsedOptions.timeCost < ARGON2_CONFIG.timeCost
      );
    } catch {
      return false;
    }
  }

  return false;
};

/**
 * Hash a plaintext password with Argon2id and server-side pepper.
 * Salt is cryptographically generated and uniquely embedded in the standard PHC encoded output string.
 *
 * @param {string} plainPassword - Plaintext candidate password
 * @returns {Promise<string>} - Encoded Argon2id hash string ($argon2id$...)
 */
export const hashPassword = async (plainPassword) => {
  if (!plainPassword || typeof plainPassword !== 'string') {
    throw new Error('Invalid plain password provided for hashing.');
  }
  const pepperedPassword = getPepperedPassword(plainPassword);
  return await argon2Hash(pepperedPassword, ARGON2_CONFIG);
};

/**
 * Dual-path password verification:
 * - If storedHash is Argon2id: verifies via @node-rs/argon2.verify
 * - If storedHash is legacy bcrypt: verifies via bcryptjs.compare
 *
 * @param {string} plainPassword - Plaintext candidate password provided by user
 * @param {string} storedHash - Existing stored password hash from database
 * @returns {Promise<boolean>} - True if password matches, false otherwise
 */
export const verifyPassword = async (plainPassword, storedHash) => {
  if (!plainPassword || !storedHash || typeof plainPassword !== 'string' || typeof storedHash !== 'string') {
    return false;
  }

  const pepperedPassword = getPepperedPassword(plainPassword);

  try {
    if (isArgon2idHash(storedHash)) {
      return await argon2Verify(storedHash, pepperedPassword);
    }

    if (isBcryptHash(storedHash)) {
      return await bcrypt.compare(pepperedPassword, storedHash);
    }

    return false;
  } catch {
    // Fail closed on malformed/tampered hash; never leak cryptographic internals
    return false;
  }
};

