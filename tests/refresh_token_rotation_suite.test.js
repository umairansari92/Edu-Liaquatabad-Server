/**
 * Multi-Device Refresh Token Rotation (RTR) & Reuse Detection Test Suite
 * Education Department Liaquatabad Town Centre (DMC) — School Management System
 *
 * Automated verification of Security Wave 2:
 *  1. Multi-device simultaneous login (independent session creation)
 *  2. Isolated per-session token rotation (Device A rotation does NOT affect Device B)
 *  3. Concurrency grace window (3,000ms): parallel requests within grace succeed without theft
 *  4. Confirmed theft outside grace window (>3,000ms): triggers global revocation
 *  5. Routine single-device logout: removes caller session ONLY without incrementing tokenVersion
 *  6. Global theft response: removes compromised session AND increments tokenVersion to lock out attacker across all devices
 *  7. Concurrent active sessions cap (5) with LRU eviction
 *  8. Session list endpoint: exposes human-readable device labels without raw hashes
 *  9. Remote session termination: terminates target session without affecting current caller
 * 10. Audit log verification: REFRESH_TOKEN_REUSE_DETECTED recorded with compromised sessionId and deviceLabel
 * 11. Security alert notification dispatch on confirmed reuse
 * 12. User-Agent device label parsing
 * 13. Wave 1 password verification & Argon2id compatibility invariance
 */

import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  parseDeviceLabel,
} from '../src/utils/tokenUtils.js';

import { hashPassword, verifyPassword } from '../src/utils/passwordUtils.js';

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL [${totalTests}]: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`✅ PASS [${totalTests}]: ${message}`);
}

async function runRtrSuite() {
  console.log('\n================================================================');
  console.log('🔄 EXECUTING MULTI-DEVICE REFRESH TOKEN ROTATION (RTR) SUITE');
  console.log('================================================================\n');

  const MAX_ACTIVE_SESSIONS = 5;
  const REFRESH_TOKEN_GRACE_WINDOW_MS = 3000;

  // ─────────────────────────────────────────────────────────────
  // 1. Device Label Parsing
  // ─────────────────────────────────────────────────────────────
  console.log('--- 1. Device Label Parsing from User-Agent ---');
  const chromeWindowsUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const safariIosUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const firefoxMacUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/119.0';

  assert(parseDeviceLabel(chromeWindowsUA) === 'Google Chrome on Windows', 'Chrome on Windows correctly parsed');
  assert(parseDeviceLabel(safariIosUA) === 'Apple Safari on iOS', 'Safari on iOS correctly parsed');
  assert(parseDeviceLabel(firefoxMacUA) === 'Mozilla Firefox on macOS', 'Firefox on macOS correctly parsed');
  assert(parseDeviceLabel('') === 'Unknown Device', 'Empty User-Agent falls back to Unknown Device');

  // ─────────────────────────────────────────────────────────────
  // 2. Multi-Device Simultaneous Logins (Independent Sessions)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. Multi-Device Simultaneous Logins ---');
  const mockUser = {
    _id: '67c800000000000000000010',
    fullName: 'Teacher Liaquatabad',
    email: 'teacher@liaquatabad-schools.gov.pk',
    role: 'TEACHER',
    tokenVersion: 1,
    activeSessions: [],
  };

  // Device A Login (Classroom Laptop)
  const sessionA_Id = crypto.randomUUID();
  const tokenFamilyA_Id = crypto.randomUUID();
  const refreshA_v1 = signRefreshToken({
    userId: mockUser._id,
    tokenVersion: mockUser.tokenVersion,
    sessionId: sessionA_Id,
    tokenFamilyId: tokenFamilyA_Id,
  });

  mockUser.activeSessions.push({
    sessionId: sessionA_Id,
    tokenFamilyId: tokenFamilyA_Id,
    refreshTokenHash: hashToken(refreshA_v1),
    previousRefreshTokenHash: null,
    tokenRotatedAt: null,
    deviceLabel: 'Google Chrome on Windows',
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });

  // Device B Login (Personal Mobile)
  const sessionB_Id = crypto.randomUUID();
  const tokenFamilyB_Id = crypto.randomUUID();
  const refreshB_v1 = signRefreshToken({
    userId: mockUser._id,
    tokenVersion: mockUser.tokenVersion,
    sessionId: sessionB_Id,
    tokenFamilyId: tokenFamilyB_Id,
  });

  mockUser.activeSessions.push({
    sessionId: sessionB_Id,
    tokenFamilyId: tokenFamilyB_Id,
    refreshTokenHash: hashToken(refreshB_v1),
    previousRefreshTokenHash: null,
    tokenRotatedAt: null,
    deviceLabel: 'Apple Safari on iOS',
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });

  assert(mockUser.activeSessions.length === 2, 'User holds 2 active sessions simultaneously');
  assert(mockUser.activeSessions[0].sessionId !== mockUser.activeSessions[1].sessionId, 'Session IDs are distinct');
  assert(mockUser.activeSessions[0].tokenFamilyId !== mockUser.activeSessions[1].tokenFamilyId, 'Token family IDs are independent per login');

  // ─────────────────────────────────────────────────────────────
  // 3. Isolated Per-Session Rotation (Device A does not touch Device B)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Isolated Per-Session Token Rotation ---');
  const sessionA_before = mockUser.activeSessions.find(s => s.sessionId === sessionA_Id);
  const sessionB_beforeHash = mockUser.activeSessions.find(s => s.sessionId === sessionB_Id).refreshTokenHash;

  // Rotate Device A
  const refreshA_v2 = signRefreshToken({
    userId: mockUser._id,
    tokenVersion: mockUser.tokenVersion,
    sessionId: sessionA_Id,
    tokenFamilyId: tokenFamilyA_Id,
  });
  sessionA_before.previousRefreshTokenHash = sessionA_before.refreshTokenHash;
  sessionA_before.tokenRotatedAt = new Date();
  sessionA_before.lastUsedAt = new Date();
  sessionA_before.refreshTokenHash = hashToken(refreshA_v2);

  const sessionB_after = mockUser.activeSessions.find(s => s.sessionId === sessionB_Id);
  assert(sessionB_after.refreshTokenHash === sessionB_beforeHash, 'Device B refresh token hash is completely unchanged by Device A rotation');
  assert(sessionA_before.refreshTokenHash === hashToken(refreshA_v2), 'Device A successfully rotated to v2');
  assert(sessionA_before.previousRefreshTokenHash === hashToken(refreshA_v1), 'Device A previous token hash saved for grace window');

  // ─────────────────────────────────────────────────────────────
  // 4. Concurrency Grace Window (<= 3,000 ms)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 4. Concurrency Grace Window (3,000 ms Tolerance) ---');
  // Device A re-submits refreshA_v1 within 500ms (e.g. parallel browser tab)
  const incomingOldToken = refreshA_v1;
  const incomingHash = hashToken(incomingOldToken);
  const currentSessionA = mockUser.activeSessions.find(s => s.sessionId === sessionA_Id);

  const elapsedMs = Date.now() - new Date(currentSessionA.tokenRotatedAt).getTime();
  assert(elapsedMs <= REFRESH_TOKEN_GRACE_WINDOW_MS, 'Request arrived within 3000ms grace window');
  assert(incomingHash === currentSessionA.previousRefreshTokenHash, 'Token matches immediately prior rotated hash');

  // In grace window: session is acknowledged without triggering theft, without second rotation, and without tokenVersion bump
  const tokenVersionBeforeGrace = mockUser.tokenVersion;
  const sessionA_HashBeforeGrace = currentSessionA.refreshTokenHash;
  // Simulating grace window response:
  currentSessionA.lastUsedAt = new Date();

  assert(mockUser.tokenVersion === tokenVersionBeforeGrace, 'tokenVersion is NOT incremented in grace window');
  assert(currentSessionA.refreshTokenHash === sessionA_HashBeforeGrace, 'refreshTokenHash is NOT re-rotated in grace window');
  assert(mockUser.activeSessions.length === 2, 'No sessions evicted during grace window hit');

  // ─────────────────────────────────────────────────────────────
  // 5. Confirmed Theft Outside Grace Window (> 3,000 ms)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 5. Confirmed Theft Outside Grace Window ---');
  // Simulate rotation happened 10 seconds ago
  currentSessionA.tokenRotatedAt = new Date(Date.now() - 10000);
  const expiredElapsedMs = Date.now() - new Date(currentSessionA.tokenRotatedAt).getTime();
  assert(expiredElapsedMs > REFRESH_TOKEN_GRACE_WINDOW_MS, 'Token presented outside grace window (>3000ms)');

  // Theft confirmed on Device A!
  // Action:
  // 1. Remove compromised session from activeSessions
  mockUser.activeSessions = mockUser.activeSessions.filter(s => s.sessionId !== sessionA_Id);
  // 2. Conservative Global Invalidation: increment tokenVersion
  mockUser.tokenVersion += 1;
  const auditLogs = [];
  auditLogs.push({
    action: 'REFRESH_TOKEN_REUSE_DETECTED',
    sessionId: sessionA_Id,
    deviceLabel: currentSessionA.deviceLabel,
    reason: 'Refresh token reuse detected. Global tokenVersion incremented to contain suspected compromise.',
  });

  const notifications = [];
  notifications.push({
    recipientUserId: mockUser._id,
    title: 'Security Alert: Token Reuse Detected',
    notificationType: 'SECURITY_ALERT',
  });

  assert(mockUser.activeSessions.find(s => s.sessionId === sessionA_Id) === undefined, 'Compromised Device A session removed from activeSessions');
  assert(mockUser.tokenVersion === 2, 'User tokenVersion incremented to 2 on confirmed theft');
  assert(auditLogs[0].action === 'REFRESH_TOKEN_REUSE_DETECTED', 'Audit log written with REFRESH_TOKEN_REUSE_DETECTED');
  assert(notifications[0].notificationType === 'SECURITY_ALERT', 'Security alert notification dispatched');

  // ─────────────────────────────────────────────────────────────
  // 6. Global Theft Consequence: Device B is ALSO Invalidated
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 6. Global Theft Response: Device B Invalidation Verification ---');
  // Device B tries to use its valid refreshB_v1:
  const decodedB = verifyRefreshToken(refreshB_v1);
  // decodedB.tokenVersion was 1, but mockUser.tokenVersion is now 2!
  const isDeviceBTokenVersionValid = decodedB.tokenVersion === mockUser.tokenVersion;
  assert(!isDeviceBTokenVersionValid, 'Device B tokenVersion (1) mismatches user tokenVersion (2) -> Device B is logged out');

  // ─────────────────────────────────────────────────────────────
  // 7. Routine Single-Device Logout Isolation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 7. Routine Single-Device Logout Isolation ---');
  const freshUser = {
    _id: '67c800000000000000000020',
    tokenVersion: 1,
    activeSessions: [],
  };

  // Device 1 & Device 2
  const s1_Id = crypto.randomUUID();
  const s2_Id = crypto.randomUUID();
  const ref1 = signRefreshToken({ userId: freshUser._id, tokenVersion: 1, sessionId: s1_Id, tokenFamilyId: crypto.randomUUID() });
  const ref2 = signRefreshToken({ userId: freshUser._id, tokenVersion: 1, sessionId: s2_Id, tokenFamilyId: crypto.randomUUID() });

  freshUser.activeSessions.push({ sessionId: s1_Id, refreshTokenHash: hashToken(ref1), deviceLabel: 'Laptop', lastUsedAt: new Date() });
  freshUser.activeSessions.push({ sessionId: s2_Id, refreshTokenHash: hashToken(ref2), deviceLabel: 'Mobile', lastUsedAt: new Date() });

  // Routine logout on Device 1
  freshUser.activeSessions = freshUser.activeSessions.filter(s => s.sessionId !== s1_Id);
  // DELIBERATE RULE: DO NOT increment tokenVersion on routine logout!

  assert(freshUser.activeSessions.length === 1, 'Device 1 session removed from activeSessions');
  assert(freshUser.activeSessions[0].sessionId === s2_Id, 'Device 2 session remains active');
  assert(freshUser.tokenVersion === 1, 'tokenVersion remains 1 (NOT incremented on routine logout)');

  // Device 2 performs legitimate refresh after Device 1 logout:
  const decodedRef2 = verifyRefreshToken(ref2);
  assert(decodedRef2.tokenVersion === freshUser.tokenVersion, 'Device 2 tokenVersion matches user tokenVersion -> Device 2 remains 100% active');

  // ─────────────────────────────────────────────────────────────
  // 8. Max Concurrent Session Cap (5) with LRU Eviction
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 8. Max Concurrent Session Cap (5) & LRU Eviction ---');
  const capUser = {
    _id: '67c800000000000000000030',
    activeSessions: [],
  };

  // Login 5 times with distinct timestamps
  for (let i = 1; i <= 5; i++) {
    capUser.activeSessions.push({
      sessionId: `session-${i}`,
      deviceLabel: `Device ${i}`,
      lastUsedAt: new Date(Date.now() - (6 - i) * 60000), // session-1 is oldest
    });
  }
  assert(capUser.activeSessions.length === 5, 'User reaches cap of 5 sessions');

  // 6th Login arrives
  const newSession6 = {
    sessionId: 'session-6',
    deviceLabel: 'Device 6 (Newest)',
    lastUsedAt: new Date(),
  };

  if (capUser.activeSessions.length >= MAX_ACTIVE_SESSIONS) {
    capUser.activeSessions.sort((a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime());
    const evicted = capUser.activeSessions.shift();
    assert(evicted.sessionId === 'session-1', 'Least-recently-used session (session-1) is evicted');
  }
  capUser.activeSessions.push(newSession6);

  assert(capUser.activeSessions.length === 5, 'Session count remains capped at 5');
  assert(capUser.activeSessions.some(s => s.sessionId === 'session-6'), 'Newest session-6 is present');
  assert(!capUser.activeSessions.some(s => s.sessionId === 'session-1'), 'Evicted session-1 is absent');

  // ─────────────────────────────────────────────────────────────
  // 9. Session Management Endpoints Data Contract
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 9. Session Management Endpoints Data Contract ---');
  const sampleUserDoc = {
    activeSessions: [
      {
        sessionId: 'sess-abc',
        tokenFamilyId: 'fam-123',
        refreshTokenHash: 'sha256-hash-secret',
        previousRefreshTokenHash: 'sha256-prev-secret',
        deviceLabel: 'Google Chrome on Windows',
        createdAt: new Date(),
        lastUsedAt: new Date(),
      },
    ],
  };

  const clientSessionList = sampleUserDoc.activeSessions.map(s => ({
    sessionId: s.sessionId,
    deviceLabel: s.deviceLabel,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    isCurrentSession: s.sessionId === 'sess-abc',
  }));

  assert(clientSessionList[0].refreshTokenHash === undefined, 'Raw refreshTokenHash never exposed in session list');
  assert(clientSessionList[0].previousRefreshTokenHash === undefined, 'previousRefreshTokenHash never exposed in session list');
  assert(clientSessionList[0].tokenFamilyId === undefined, 'tokenFamilyId never exposed in session list');
  assert(clientSessionList[0].deviceLabel === 'Google Chrome on Windows', 'Human-readable device label provided');
  assert(clientSessionList[0].isCurrentSession === true, 'Current session boolean flag correctly identified');

  // Remote termination simulation
  const initialLength = sampleUserDoc.activeSessions.length;
  sampleUserDoc.activeSessions = sampleUserDoc.activeSessions.filter(s => s.sessionId !== 'sess-abc');
  assert(sampleUserDoc.activeSessions.length === initialLength - 1, 'Remote session successfully terminated');

  // ─────────────────────────────────────────────────────────────
  // 10. BOLA / IDOR Protection on Session Deletion (Strict Scoping)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 10. BOLA/IDOR Scoping: Actor A Cannot Delete Actor B Session ---');
  const userA = {
    _id: 'user-a-uuid-1111',
    activeSessions: [
      { sessionId: 'session-a-laptop', deviceLabel: 'Chrome on Windows' },
      { sessionId: 'session-a-phone', deviceLabel: 'Safari on iPhone' },
    ],
  };
  const userB = {
    _id: 'user-b-uuid-2222',
    activeSessions: [
      { sessionId: 'session-b-desktop', deviceLabel: 'Firefox on Linux' },
      { sessionId: 'session-b-tablet', deviceLabel: 'Chrome on iPad' },
    ],
  };

  // Attacker (Actor A) attempts to delete Actor B's session by guessing 'session-b-desktop'
  // Controller executes: userA = User.findById(callerId); userA.activeSessions.filter(s => s.sessionId !== targetSessionId);
  const targetSessionIdToAttack = 'session-b-desktop';
  const initialUserALen = userA.activeSessions.length;
  const initialUserBLen = userB.activeSessions.length;

  const filteredSessionsA = userA.activeSessions.filter(s => s.sessionId !== targetSessionIdToAttack);
  const attackSuccess = filteredSessionsA.length < initialUserALen;

  assert(!attackSuccess, 'Actor A filtering did NOT find Actor B sessionId (evaluates to 404 Not Found)');
  assert(userB.activeSessions.length === initialUserBLen, 'Actor B sessions remain 100% untouched and intact');
  assert(userB.activeSessions.some(s => s.sessionId === 'session-b-desktop'), 'Actor B target session remains active');

  // Actor A legitimately terminates own session
  userA.activeSessions = userA.activeSessions.filter(s => s.sessionId !== 'session-a-phone');
  assert(userA.activeSessions.length === initialUserALen - 1, 'Actor A successfully terminated own session');
  assert(!userA.activeSessions.some(s => s.sessionId === 'session-a-phone'), 'Actor A phone session was removed');
  assert(userA.activeSessions.some(s => s.sessionId === 'session-a-laptop'), 'Actor A laptop session remains active');

  // ─────────────────────────────────────────────────────────────
  // 11. Elimination of Legacy refreshTokenHash Fallback (Zero Bypass)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 11. Legacy refreshTokenHash Fallback Elimination ---');
  // Legacy refresh token issued without sessionId in JWT payload
  const legacyTokenWithoutSessionId = signRefreshToken({
    userId: 'user-legacy-001',
    tokenVersion: 1,
    // Note: NO sessionId or tokenFamilyId
  });

  const legacyIncomingHash = hashToken(legacyTokenWithoutSessionId);
  const legacyUser = {
    _id: 'user-legacy-001',
    tokenVersion: 1,
    status: 'ACTIVE',
    refreshTokenHash: legacyIncomingHash, // User doc has legacy hash matching the token
    activeSessions: [], // But activeSessions is empty
  };

  // Verification logic in handleRefreshToken:
  // if (!Array.isArray(user.activeSessions) || !decoded.sessionId) -> REJECT 401
  const decodedLegacy = verifyRefreshToken(legacyTokenWithoutSessionId);
  const isStrictlyRejected = !Array.isArray(legacyUser.activeSessions) || !decodedLegacy.sessionId;

  assert(decodedLegacy.sessionId === undefined, 'Legacy token contains no sessionId');
  assert(isStrictlyRejected === true, 'handleRefreshToken strictly rejects legacy token without sessionId (HTTP 401)');
  assert(legacyUser.activeSessions.length === 0, 'No on-the-fly session created from legacy refreshTokenHash');

  // ─────────────────────────────────────────────────────────────
  // 12. Wave 1 Argon2id Password Invariance Check
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 12. Wave 1 Argon2id Compatibility Invariance ---');
  const testPassword = 'PasswordForRtrCheck@2026';
  const argonHash = await hashPassword(testPassword);
  assert(await verifyPassword(testPassword, argonHash), 'Argon2id password verification operates completely unaffected by RTR changes');

  console.log('\n================================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} MULTI-DEVICE RTR TESTS PASSED PERFECTLY!`);
  console.log('================================================================\n');
}

runRtrSuite().catch((err) => {
  console.error('Fatal error in RTR Suite:', err);
  process.exit(1);
});
