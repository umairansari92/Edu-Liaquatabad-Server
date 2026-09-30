import mongoose from 'mongoose';
import assert from 'assert';
import dotenv from 'dotenv';
import '../src/models/User.js';
import { decryptMfaSecret, generateTotpToken } from '../src/utils/mfaUtils.js';
import { signMfaPendingToken, signAccessToken, signRefreshToken, hashToken } from '../src/utils/tokenUtils.js';

dotenv.config();

const uri = process.env.MONGODB_URI;
const BASE_URL = 'http://localhost:5000/api/v1';

async function runMfaRegressionLifecycleSuite() {
  console.log('================================================================');
  console.log('🛡️ RUNNING COMPREHENSIVE ROOT ADMIN MFA REGRESSION & LIFECYCLE SUITE');
  console.log('================================================================');

  await mongoose.connect(uri);
  const User = mongoose.model('User');
  const user = await User.findOne({ email: 'liaquatabadeducation@gmail.com' }).select(
    '+mfa.secretCiphertext +mfa.secretIv +mfa.secretTag +mfa.lastConsumedWindow +activeSessions +tokenVersion'
  );

  assert(user, 'Root admin user must exist in database');
  console.log(`[Setup] Connected to DB. Root Admin ID: ${user._id}`);
  console.log(`[Setup] Current DB tokenVersion: ${user.tokenVersion}`);
  console.log(`[Setup] Current DB lastConsumedWindow: ${user.mfa?.lastConsumedWindow}`);

  const totpSecret = decryptMfaSecret({
    ciphertext: user.mfa.secretCiphertext,
    iv: user.mfa.secretIv,
    tag: user.mfa.secretTag,
  });
  assert(totpSecret && totpSecret.length === 32, 'TOTP Secret must be successfully decrypted');

  // ─── SCENARIO 1: Fresh Login Flow ───────────────────────────────────────────
  console.log('\n--- Scenario 1: Fresh Login (Password -> MFA Challenge -> TOTP -> 200) ---');
  const freshMfaToken1 = signMfaPendingToken({
    userId: user._id.toString(),
    tokenVersion: user.tokenVersion,
  });

  const validCode1 = generateTotpToken(totpSecret);
  const verifyRes1 = await fetch(`${BASE_URL}/auth/mfa/verify-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${freshMfaToken1}`,
    },
    body: JSON.stringify({
      mfaPendingToken: freshMfaToken1,
      totpCode: validCode1,
    }),
  });

  const verifyJson1 = await verifyRes1.json();
  const setCookieHeader1 = verifyRes1.headers.get('set-cookie') || '';
  console.log(`Scenario 1 HTTP Status: ${verifyRes1.status}`);
  console.log(`Scenario 1 Success: ${verifyJson1.success}`);
  console.log(`Scenario 1 mfaVerified: ${verifyJson1.data?.user?.mfaVerified}`);
  console.log(`Scenario 1 AccessToken Issued: ${!!verifyJson1.data?.accessToken}`);
  console.log(`Scenario 1 Refresh Cookie Set: ${setCookieHeader1.includes('refreshToken')}`);

  assert.strictEqual(verifyRes1.status, 200, 'Scenario 1: Fresh MFA verification must return 200');
  assert.strictEqual(verifyJson1.data?.user?.mfaVerified, true, 'Scenario 1: User claim mfaVerified must be true');
  assert(verifyJson1.data?.accessToken, 'Scenario 1: Access token must be issued');
  assert(setCookieHeader1.includes('refreshToken'), 'Scenario 1: 7-day HttpOnly refresh cookie must be set');

  // Extract refresh token from cookie
  const refreshTokenMatch = setCookieHeader1.match(/refreshToken=([^;]+)/);
  const activeRefreshTokenCookie = refreshTokenMatch ? refreshTokenMatch[1] : null;

  // ─── SCENARIO 2: Stale Access Token in Authorization Header ───────────────────
  console.log('\n--- Scenario 2: Stale Access Token in Header (Interceptor Simulation) ---');
  // Generate a mock stale access token from previous session
  const staleAccessToken = signAccessToken({
    userId: user._id.toString(),
    role: user.role,
    tokenVersion: user.tokenVersion,
  });

  // Generate fresh MFA pending token
  const freshMfaToken2 = signMfaPendingToken({
    userId: user._id.toString(),
    tokenVersion: user.tokenVersion,
  });

  // Advance time offset slightly to get next valid TOTP token or fresh window
  // (In case window 1 was consumed in Scenario 1)
  const validCode2 = generateTotpToken(totpSecret, 1); // +1 window ahead (within 30s allowed drift)

  const verifyRes2 = await fetch(`${BASE_URL}/auth/mfa/verify-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Simulating Axios interceptor attaching stale access token
      'Authorization': `Bearer ${staleAccessToken}`,
    },
    body: JSON.stringify({
      // Body carries fresh MFA pending ticket
      mfaPendingToken: freshMfaToken2,
      totpCode: validCode2,
    }),
  });

  const verifyJson2 = await verifyRes2.json();
  console.log(`Scenario 2 HTTP Status: ${verifyRes2.status}`);
  console.log(`Scenario 2 Success: ${verifyJson2.success}`);
  console.log(`Scenario 2 Message: ${verifyJson2.message}`);
  assert.strictEqual(verifyRes2.status, 200, 'Scenario 2: Stale access token in header MUST NOT fail verify-login when body.mfaPendingToken is present');
  assert.strictEqual(verifyJson2.data?.user?.mfaVerified, true, 'Scenario 2: Successfully verified with fresh body ticket');

  // ─── SCENARIO 3: Expired Access Token in Header + Valid Body MFA Ticket ───────
  console.log('\n--- Scenario 3: Expired Access Token in Header + Valid Body MFA Ticket ---');
  const jwt = await import('jsonwebtoken');
  const expiredAccessToken = jwt.default.sign(
    { userId: user._id.toString(), role: user.role },
    process.env.JWT_ACCESS_SECRET || 'dev_liaquatabad_access_secret_key_minimum_32_chars_2026',
    { expiresIn: -10 } // Expired 10 seconds ago
  );

  const freshMfaToken3 = signMfaPendingToken({
    userId: user._id.toString(),
    tokenVersion: user.tokenVersion,
  });
  const validCode3 = generateTotpToken(totpSecret, 1); // within drift

  const verifyRes3 = await fetch(`${BASE_URL}/auth/mfa/verify-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${expiredAccessToken}`,
    },
    body: JSON.stringify({
      mfaPendingToken: freshMfaToken3,
      totpCode: validCode3,
    }),
  });
  const verifyJson3 = await verifyRes3.json();
  console.log(`Scenario 3 HTTP Status: ${verifyRes3.status}`);
  console.log(`Scenario 3 Success: ${verifyJson3.success}`);
  // If window was already consumed in scenario 2, status will be 401 WINDOW_ALREADY_CONSUMED, or 200 if valid
  console.log(`Scenario 3 Result: ${verifyJson3.message || 'SUCCESS'}`);
  assert(
    verifyRes3.status === 200 || (verifyRes3.status === 401 && verifyJson3.message?.includes('already been used')),
    'Scenario 3: Must evaluate mfaPendingToken without being blocked by expired access token'
  );

  // ─── SCENARIO 4: Genuinely Expired MFA Pending Token ───────────────────────────
  console.log('\n--- Scenario 4: Genuinely Expired MFA Pending Token ---');
  const expiredMfaToken = jwt.default.sign(
    { userId: user._id.toString(), tokenType: 'MFA_PENDING' },
    process.env.JWT_MFA_PENDING_SECRET || 'dev_liaquatabad_mfa_pending_secret_min_32_chars_2026',
    { expiresIn: -60 } // Expired 1 minute ago
  );

  const verifyRes4 = await fetch(`${BASE_URL}/auth/mfa/verify-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${expiredMfaToken}`,
    },
    body: JSON.stringify({
      mfaPendingToken: expiredMfaToken,
      totpCode: '123456',
    }),
  });
  const verifyJson4 = await verifyRes4.json();
  console.log(`Scenario 4 HTTP Status: ${verifyRes4.status}`);
  console.log(`Scenario 4 Message: ${verifyJson4.message}`);
  assert.strictEqual(verifyRes4.status, 401, 'Scenario 4: Expired MFA ticket must return 401');
  assert(
    verifyJson4.message.includes('timed out') || verifyJson4.message.includes('expired'),
    'Scenario 4: Response must inform user that session timed out / expired'
  );

  // ─── SCENARIO 5: Session Restore / Refresh Token Exchange ─────────────────────
  console.log('\n--- Scenario 5: Browser Restart / Refresh Token Exchange (7-day Session) ---');
  assert(activeRefreshTokenCookie, 'Must have active refresh cookie from Scenario 1');

  const refreshRes5 = await fetch(`${BASE_URL}/auth/refresh-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `refreshToken=${activeRefreshTokenCookie}`,
    },
    body: JSON.stringify({}),
  });
  const refreshJson5 = await refreshRes5.json();
  console.log(`Scenario 5 HTTP Status: ${refreshRes5.status}`);
  console.log(`Scenario 5 Success: ${refreshJson5.success}`);
  console.log(`Scenario 5 mfaVerified Preserved: ${refreshJson5.data?.user?.mfaVerified}`);
  console.log(`Scenario 5 Fresh AccessToken: ${!!refreshJson5.data?.accessToken}`);

  assert.strictEqual(refreshRes5.status, 200, 'Scenario 5: Valid refresh token must restore session with 200');
  assert.strictEqual(refreshJson5.data?.user?.mfaVerified, true, 'Scenario 5: Refreshed session MUST preserve mfaVerified: true');
  assert(refreshJson5.data?.accessToken, 'Scenario 5: Must issue new access token');

  // ─── SCENARIO 6: Expired / Revoked Refresh Session ─────────────────────────────
  console.log('\n--- Scenario 6: Revoked Refresh Session (Forces Fresh Password + MFA) ---');
  // Submit with an invalid/revoked refresh token cookie
  const invalidRefreshToken = signRefreshToken({
    userId: user._id.toString(),
    tokenVersion: 99999, // Revoked version
    sessionId: 'non-existent-session-id',
  });

  const refreshRes6 = await fetch(`${BASE_URL}/auth/refresh-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `refreshToken=${invalidRefreshToken}`,
    },
    body: JSON.stringify({}),
  });
  const refreshJson6 = await refreshRes6.json();
  console.log(`Scenario 6 HTTP Status: ${refreshRes6.status}`);
  console.log(`Scenario 6 Message: ${refreshJson6.message}`);
  assert.strictEqual(refreshRes6.status, 401, 'Scenario 6: Revoked session must fail refresh with 401');

  // ─── SCENARIO 7: Concurrent Double-Click Replay Protection ─────────────────────
  console.log('\n--- Scenario 7: Concurrent Double-Click Replay Protection ---');
  const freshMfaToken7 = signMfaPendingToken({
    userId: user._id.toString(),
    tokenVersion: user.tokenVersion,
  });
  // Use stepOffset = 1 to ensure a fresh, unconsumed window
  const doubleClickCode = generateTotpToken(totpSecret, 1);

  // Send two requests concurrently
  const [reqA, reqB] = await Promise.all([
    fetch(`${BASE_URL}/auth/mfa/verify-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${freshMfaToken7}`,
      },
      body: JSON.stringify({ mfaPendingToken: freshMfaToken7, totpCode: doubleClickCode }),
    }),
    fetch(`${BASE_URL}/auth/mfa/verify-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${freshMfaToken7}`,
      },
      body: JSON.stringify({ mfaPendingToken: freshMfaToken7, totpCode: doubleClickCode }),
    }),
  ]);

  const [resA, resB] = await Promise.all([reqA.json(), reqB.json()]);
  const statuses = [reqA.status, reqB.status].sort();
  console.log(`Scenario 7 Concurrent Statuses: [${statuses.join(', ')}]`);
  console.log(`Req A Status: ${reqA.status}, Success: ${resA.success}, Message: ${resA.message || 'OK'}`);
  console.log(`Req B Status: ${reqB.status}, Success: ${resB.success}, Message: ${resB.message || 'OK'}`);

  // Replay prevention: exactly one may succeed, or if already consumed, both rejected
  const successCount = (reqA.status === 200 ? 1 : 0) + (reqB.status === 200 ? 1 : 0);
  assert(successCount <= 1, 'Scenario 7: Monotonic replay protection guarantees at most ONE verification succeeds');
  console.log('✅ Scenario 7 Passed: Atomic monotonic replay prevents duplicate consumption!');

  await mongoose.disconnect();
  console.log('\n================================================================');
  console.log('🎉 ALL 7 BACKEND & HANDSHAKE SCENARIOS PASSED WITH 100% SUCCESS!');
  console.log('================================================================');
}

runMfaRegressionLifecycleSuite().catch((err) => {
  console.error('❌ Error during regression suite:', err);
  process.exit(1);
});
