import crypto from 'crypto';

const CAPTCHA_SECRET = process.env.JWT_ACCESS_SECRET || 'liaquatabad_dmc_math_captcha_secret_2026';

/**
 * Generates a privacy-friendly mathematical CAPTCHA challenge
 * @returns {Object} { question: "7 + 4 = ?", challengeToken: "signed_token" }
 */
export const generateMathCaptcha = () => {
  const num1 = Math.floor(Math.random() * 9) + 1; // 1 to 9
  const num2 = Math.floor(Math.random() * 9) + 1; // 1 to 9
  const answer = num1 + num2;
  const expiry = Date.now() + 5 * 60 * 1000; // 5 minutes validity

  // Cryptographically sign the answer and expiry
  const payload = `${answer}:${expiry}`;
  const signature = crypto
    .createHmac('sha256', CAPTCHA_SECRET)
    .update(payload)
    .digest('hex');

  const challengeToken = Buffer.from(`${payload}:${signature}`).toString('base64');

  return {
    question: `What is ${num1} + ${num2}?`,
    challengeToken,
  };
};

/**
 * Validates the user's submitted CAPTCHA answer against the signed token
 * @param {number|string} userAnswer 
 * @param {string} challengeToken 
 * @returns {boolean}
 */
export const verifyMathCaptcha = (userAnswer, challengeToken) => {
  if (!userAnswer || !challengeToken) return false;

  try {
    const decoded = Buffer.from(challengeToken, 'base64').toString('utf8');
    const [answerStr, expiryStr, receivedSignature] = decoded.split(':');

    if (!answerStr || !expiryStr || !receivedSignature) return false;

    // Check expiry
    const expiry = parseInt(expiryStr, 10);
    if (Date.now() > expiry) return false;

    // Verify cryptographic signature
    const expectedPayload = `${answerStr}:${expiryStr}`;
    const expectedSignature = crypto
      .createHmac('sha256', CAPTCHA_SECRET)
      .update(expectedPayload)
      .digest('hex');

    if (expectedSignature !== receivedSignature) return false;

    // Verify mathematical answer
    return parseInt(String(userAnswer).trim(), 10) === parseInt(answerStr, 10);
  } catch (error) {
    return false;
  }
};
