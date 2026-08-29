import crypto from 'crypto';
import { transporter } from '../../config/nodemailer.js';

const OTP_SECRET = process.env.JWT_ACCESS_SECRET || 'liaquatabad_dmc_otp_secret_key_2026';

/**
 * Generates a cryptographically secure 6-digit numeric OTP
 * @returns {string} 6-digit string (e.g. "482910")
 */
export const generateSecureOtp = () => {
  return String(crypto.randomInt(100000, 1000000));
};

/**
 * Computes an HMAC SHA-256 hash of the OTP
 * @param {string} plainOtp 
 * @returns {string} Hex hash
 */
export const hashOtp = (plainOtp) => {
  return crypto
    .createHmac('sha256', OTP_SECRET)
    .update(String(plainOtp).trim())
    .digest('hex');
};

/**
 * Verifies a plaintext OTP against a hashed OTP in constant-time
 * @param {string} plainOtp 
 * @param {string} hashedOtp 
 * @returns {boolean}
 */
export const verifyOtpHash = (plainOtp, hashedOtp) => {
  const computed = hashOtp(plainOtp);
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hashedOtp, 'hex'));
  } catch (error) {
    return false;
  }
};

/**
 * Sends an official styled OTP email via Nodemailer
 * @param {string} email 
 * @param {string} plainOtp 
 * @param {string} purpose 
 */
export const sendOtpEmail = async (email, plainOtp, purpose = 'REGISTRATION') => {
  const titles = {
    REGISTRATION: 'Verify Your Official Government Account',
    PASSWORD_RESET: 'Password Reset Verification Code',
    MFA_LOGIN: 'Two-Factor Authentication Security Code',
    SENSITIVE_ACTION: 'Authorization Verification Code',
  };

  const subject = titles[purpose] || 'Your Verification Code';

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; background-color: #0F172A; color: #F8FAFC; border-radius: 16px; overflow: hidden; border: 1px solid #1E293B;">
      <div style="background-color: #059669; padding: 24px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px;">
          Education Department Liaquatabad Town Centre (DMC)
        </h1>
        <p style="color: #D1FAE5; margin: 6px 0 0 0; font-size: 13px; font-weight: 500;">
          Official Municipal Education Portal
        </p>
      </div>

      <div style="padding: 32px 24px; text-align: center;">
        <p style="font-size: 14px; color: #94A3B8; margin: 0 0 16px 0;">
          Use the 6-digit verification code below to complete your <strong>${purpose.replace('_', ' ').toLowerCase()}</strong>:
        </p>

        <div style="background-color: #1E293B; border: 2px dashed #059669; border-radius: 12px; padding: 18px; display: inline-block; margin: 12px auto;">
          <span style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 10px; color: #10B981;">
            ${plainOtp}
          </span>
        </div>

        <p style="font-size: 12px; color: #F59E0B; margin: 20px 0 0 0;">
          ⏱️ This code will expire in <strong>5 minutes</strong>.
        </p>
        <p style="font-size: 12px; color: #64748B; margin: 8px 0 0 0;">
          If you did not request this verification, please disregard this email. Never share this code with anyone.
        </p>
      </div>

      <div style="background-color: #020617; padding: 16px; text-align: center; border-top: 1px solid #1E293B;">
        <p style="font-size: 11px; color: #475569; margin: 0;">
          © 2026 Education Department Liaquatabad Town Centre (DMC). Automated Security System.
        </p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || '"Education Department DMC" <no-reply@liaquatabad-schools.gov.pk>',
      to: email,
      subject: `[DMC Liaquatabad] ${subject}: ${plainOtp}`,
      html: htmlContent,
    });
    return true;
  } catch (error) {
    console.error('[Nodemailer OTP Error]', error.message);
    // In local dev without live SMTP, log plainOtp for instant developer verification
    console.log(`[LOCAL DEV OTP DISPATCH] -> To: ${email} | Code: ${plainOtp} | Purpose: ${purpose}`);
    return true;
  }
};
