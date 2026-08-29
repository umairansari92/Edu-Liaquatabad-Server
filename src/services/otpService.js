import OtpVerification from '../models/OtpVerification.js';
import { generateSecureOtp, hashOtp, verifyOtpHash, sendOtpEmail } from '../utils/otpUtils.js';
import { isDisposableEmail } from '../utils/disposableEmailValidator.js';

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

export const requestOtp = async (email, purpose = 'REGISTRATION') => {
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Verify not disposable email
  if (isDisposableEmail(normalizedEmail)) {
    throw new Error('Disposable and temporary email addresses are strictly prohibited.');
  }

  // 2. Check if active OTP exists and enforce rate-limiting / cooldown
  let existingOtp = await OtpVerification.findOne({ email: normalizedEmail, purpose });

  if (existingOtp) {
    const now = Date.now();
    const timeSinceLastResend = now - new Date(existingOtp.lastResentAt).getTime();

    // Enforce 60s cooldown
    if (timeSinceLastResend < RESEND_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - timeSinceLastResend) / 1000);
      throw new Error(`Please wait ${waitSeconds} second(s) before requesting another verification code.`);
    }

    // Enforce max 3 resends per cycle
    if (existingOtp.resendCount >= 3) {
      throw new Error('Maximum verification code requests exceeded for this cycle. Please try again after 15 minutes.');
    }
  }

  // 3. Generate new OTP and cryptographic hash
  const plainOtp = generateSecureOtp();
  const otpHash = hashOtp(plainOtp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

  if (existingOtp) {
    existingOtp.otpHash = otpHash;
    existingOtp.expiresAt = expiresAt;
    existingOtp.attempts = 0;
    existingOtp.resendCount += 1;
    existingOtp.lastResentAt = new Date();
    await existingOtp.save();
  } else {
    await OtpVerification.create({
      email: normalizedEmail,
      otpHash,
      purpose,
      expiresAt,
      resendCount: 0,
      attempts: 0,
      lastResentAt: new Date(),
    });
  }

  // 4. Send email notification
  await sendOtpEmail(normalizedEmail, plainOtp, purpose);

  return {
    success: true,
    expiresInSeconds: 300,
    cooldownSeconds: 60,
  };
};

export const verifyOtp = async (email, plainOtp, purpose = 'REGISTRATION') => {
  const normalizedEmail = email.toLowerCase().trim();
  const record = await OtpVerification.findOne({ email: normalizedEmail, purpose });

  if (!record) {
    throw new Error('No active verification code found for this email. Please request a new one.');
  }

  // Check application-level expiry
  if (new Date() > record.expiresAt) {
    await OtpVerification.deleteOne({ _id: record._id });
    throw new Error('Verification code has expired. Please request a new code.');
  }

  // Check maximum attempt threshold
  if (record.attempts >= 5) {
    await OtpVerification.deleteOne({ _id: record._id });
    throw new Error('Maximum invalid attempts exceeded. This verification code has been invalidated.');
  }

  // Verify hash
  const isValid = verifyOtpHash(plainOtp, record.otpHash);

  if (!isValid) {
    record.attempts += 1;
    await record.save();
    const remainingAttempts = 5 - record.attempts;
    throw new Error(`Invalid verification code. ${remainingAttempts} attempt(s) remaining.`);
  }

  // Single-use guarantee: Invalidate and delete immediately upon successful verification
  await OtpVerification.deleteOne({ _id: record._id });

  return true;
};
