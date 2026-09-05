import crypto from 'crypto';

const CAPTCHA_SECRET = process.env.JWT_ACCESS_SECRET || 'liaquatabad_dmc_math_captcha_secret_2026';

// Single-use nonce tracking to eliminate token replay attacks
const consumedNonces = new Map();

// Periodic cleanup of expired consumed nonces
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiresAt] of consumedNonces.entries()) {
    if (now > expiresAt) {
      consumedNonces.delete(nonce);
    }
  }
}, 60 * 1000).unref();

/**
 * Generates a privacy-friendly mathematical CAPTCHA challenge
 * Plaintext answer is NEVER exposed in the token.
 *
 * @returns {Object} { question: "7 + 4 = ?", challengeToken: "signed_token" }
 */
export const generateMathCaptcha = () => {
  const firstOperand = Math.floor(Math.random() * 9) + 1; // 1 to 9
  const secondOperand = Math.floor(Math.random() * 9) + 1; // 1 to 9
  const correctAnswer = firstOperand + secondOperand;
  const expiresAtTimestamp = Date.now() + 5 * 60 * 1000; // 5 minutes validity
  const nonce = crypto.randomBytes(16).toString('hex');

  // Cryptographically hash the answer with the salt/nonce and expiry (No plaintext leak)
  const answerHash = crypto
    .createHmac('sha256', CAPTCHA_SECRET)
    .update(`${correctAnswer}:${nonce}:${expiresAtTimestamp}`)
    .digest('hex');

  const payload = `${nonce}:${expiresAtTimestamp}:${answerHash}`;
  const signature = crypto
    .createHmac('sha256', CAPTCHA_SECRET)
    .update(payload)
    .digest('hex');

  const challengeToken = Buffer.from(`${payload}:${signature}`).toString('base64');

  return {
    question: `What is ${firstOperand} + ${secondOperand}?`,
    challengeToken,
  };
};

/**
 * Validates the user's submitted CAPTCHA answer against the signed token.
 * Enforces single-use nonce tracking and constant-time hash comparison.
 *
 * @param {number|string} userAnswer 
 * @param {string} challengeToken 
 * @returns {boolean}
 */
export const verifyMathCaptcha = (userAnswer, challengeToken) => {
  if (userAnswer === undefined || userAnswer === null || userAnswer === '' || !challengeToken) {
    return false;
  }

  try {
    const decoded = Buffer.from(challengeToken, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 4) return false;

    const [nonce, expiryStr, expectedAnswerHash, receivedSignature] = parts;
    const expiry = parseInt(expiryStr, 10);

    // 1. Validate expiration
    if (isNaN(expiry) || Date.now() > expiry) {
      return false;
    }

    // 2. Prevent replay attack: Check if nonce was already used
    if (consumedNonces.has(nonce)) {
      return false;
    }

    // 3. Verify cryptographic envelope signature
    const expectedPayload = `${nonce}:${expiryStr}:${expectedAnswerHash}`;
    const calculatedSignature = crypto
      .createHmac('sha256', CAPTCHA_SECRET)
      .update(expectedPayload)
      .digest('hex');

    if (calculatedSignature !== receivedSignature) {
      return false;
    }

    // 4. Verify mathematical answer via HMAC comparison (Timing-Safe)
    const numericAnswer = parseInt(String(userAnswer).trim(), 10);
    if (isNaN(numericAnswer)) return false;

    const calculatedAnswerHash = crypto
      .createHmac('sha256', CAPTCHA_SECRET)
      .update(`${numericAnswer}:${nonce}:${expiryStr}`)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedAnswerHash, 'hex');
    const calculatedBuf = Buffer.from(calculatedAnswerHash, 'hex');

    if (expectedBuf.length !== calculatedBuf.length || !crypto.timingSafeEqual(expectedBuf, calculatedBuf)) {
      return false;
    }

    // 5. Mark nonce as consumed for the remainder of its lifetime
    consumedNonces.set(nonce, expiry);
    return true;
  } catch (error) {
    return false;
  }
};
