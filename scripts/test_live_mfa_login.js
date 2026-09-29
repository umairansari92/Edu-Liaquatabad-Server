import mongoose from 'mongoose';
import '../src/models/User.js';
import { decryptMfaSecret, generateTotpToken } from '../src/utils/mfaUtils.js';

import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGODB_URI;

async function testLiveMfaLogin() {
  console.log('--- 1. CONNECTING TO DATABASE TO GET ROOT ADMIN & MFA SECRET ---');
  await mongoose.connect(uri);
  const User = mongoose.model('User');
  const user = await User.findOne({ email: 'liaquatabadeducation@gmail.com' }).select(
    '+mfa.secretCiphertext +mfa.secretIv +mfa.secretTag +mfa.lastConsumedWindow +tokenVersion'
  );

  console.log('User ID:', user._id);
  console.log('TokenVersion in DB:', user.tokenVersion);
  console.log('LastConsumedWindow in DB:', user.mfa.lastConsumedWindow);

  let totpSecret = null;
  if (user.mfa?.secretCiphertext) {
    totpSecret = decryptMfaSecret({
      ciphertext: user.mfa.secretCiphertext,
      iv: user.mfa.secretIv,
      tag: user.mfa.secretTag,
    });
    console.log('TOTP Secret Decrypted: YES (length:', totpSecret.length, ')');
  }

  // --- 2. GET MATH CAPTCHA ---
  console.log('\n--- 2. REQUESTING MATH CAPTCHA ---');
  const captchaHttp = await fetch('http://localhost:5000/api/v1/auth/captcha');
  const captchaJson = await captchaHttp.json();
  const captcha = captchaJson.data;
  console.log('CAPTCHA Question:', captcha.question);

  // Compute question answer
  const match = captcha.question.match(/(\d+)\s*([\+\-\*])\s*(\d+)/);
  let answer = 0;
  if (match) {
    const a = parseInt(match[1], 10);
    const op = match[2];
    const b = parseInt(match[3], 10);
    if (op === '+') answer = a + b;
    else if (op === '-') answer = a - b;
    else if (op === '*') answer = a * b;
  }
  console.log('Computed Answer:', answer);

  // --- 3. GENERATE FRESH MFA PENDING TOKEN (SIMULATING SUCCESSFUL STEP 1) ---
  console.log('\n--- 3. SIGNING FRESH MFA PENDING TOKEN ---');
  const { signMfaPendingToken } = await import('../src/utils/tokenUtils.js');
  const freshMfaToken = signMfaPendingToken({
    userId: user._id.toString(),
    tokenVersion: user.tokenVersion,
  });
  console.log('MFA Pending Token generated successfully.');

  // --- 4. SUBMIT STEP 2: POST /api/v1/auth/mfa/verify-login WITH VALID CODE ---
  console.log('\n--- 4. SUBMITTING STEP 2: POST /api/v1/auth/mfa/verify-login (VALID CODE) ---');
  const validTotpCode = generateTotpToken(totpSecret);
  console.log('Generated TOTP code from current server secret:', validTotpCode);

  const verifyHttp = await fetch('http://localhost:5000/api/v1/auth/mfa/verify-login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${freshMfaToken}`,
    },
    body: JSON.stringify({
      totpCode: validTotpCode,
    }),
  });

  const verifyJson = await verifyHttp.json();
  console.log('Step 2 Valid Verify Status:', verifyHttp.status);
  console.log('Step 2 Valid Verify Success:', verifyJson.success);
  console.log('Step 2 Response mfaVerified:', verifyJson.data?.user?.mfaVerified);
  console.log('Step 2 AccessToken Issued:', !!verifyJson.data?.accessToken);

  // --- 5. TEST REPLAY WITH SAME CODE ---
  console.log('\n--- 5. SUBMITTING STEP 2 AGAIN WITH SAME CODE (REPLAY PROTECTION) ---');
  const replayHttp = await fetch('http://localhost:5000/api/v1/auth/mfa/verify-login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${freshMfaToken}`,
    },
    body: JSON.stringify({
      totpCode: validTotpCode,
    }),
  });
  const replayJson = await replayHttp.json();
  console.log('Step 2 Replay Verify Status:', replayHttp.status);
  console.log('Step 2 Replay Message:', replayJson.message);

  // --- 6. TEST INVALID CODE ---
  console.log('\n--- 6. SUBMITTING STEP 2 WITH INVALID CODE ---');
  const invalidHttp = await fetch('http://localhost:5000/api/v1/auth/mfa/verify-login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${freshMfaToken}`,
    },
    body: JSON.stringify({
      totpCode: '000000',
    }),
  });
  const invalidJson = await invalidHttp.json();
  console.log('Step 2 Invalid Code Status:', invalidHttp.status);
  console.log('Step 2 Invalid Code Message:', invalidJson.message);

  await mongoose.disconnect();
}

testLiveMfaLogin().catch(console.error);
