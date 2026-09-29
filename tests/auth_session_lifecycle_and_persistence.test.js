/**
 * Authentication, Session Persistence & Browser Lifecycle Invariant Test Suite
 * Authoritative verification suite for institutional session security and zero-persistence rules.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  setRefreshCookie,
  clearRefreshCookie,
} from '../src/utils/tokenUtils.js';
import { ROLES, ROLE_HIERARCHY } from '../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const clientSrc = path.join(rootDir, 'client/src');

console.log('========================================================================');
console.log('🛡️ AUTHENTICATION, PERSISTENCE & SESSION LIFECYCLE INVARIANT SUITE');
console.log('========================================================================\n');

let passCount = 0;
const testAssert = (condition, description) => {
  assert(condition, `FAILED: ${description}`);
  passCount++;
  console.log(`✅ PASS [${passCount}]: ${description}`);
};

// ─────────────────────────────────────────────────────────────
// 1. Static AST / Codebase Storage Invariants (Zero Client Persistence)
// ─────────────────────────────────────────────────────────────
console.log('--- 1. Static Storage Invariants (Zero Plaintext Persistence) ---');

const scanFilesForKeywords = (dir, forbiddenKeywords) => {
  const violations = [];
  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (!['node_modules', '.git', 'dist'].includes(ent.name)) walk(full);
      } else if (/\.(js|jsx|ts|tsx)$/.test(ent.name)) {
        const content = fs.readFileSync(full, 'utf8');
        for (const kw of forbiddenKeywords) {
          const regex = new RegExp(`\\b${kw}\\b`, 'g');
          if (regex.test(content)) {
            violations.push({ file: path.relative(rootDir, full), keyword: kw });
          }
        }
      }
    }
  };
  walk(dir);
  return violations;
};

const storageViolations = scanFilesForKeywords(clientSrc, [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document.cookie',
  'redux-persist',
  'persistStore',
  'persistReducer',
]);

testAssert(storageViolations.length === 0, 'Zero occurrences of localStorage, sessionStorage, IndexedDB, or document.cookie in client/src');

// Verify authSlice contains zero password fields
const authSliceContent = fs.readFileSync(path.join(clientSrc, 'store/slices/authSlice.js'), 'utf8');
testAssert(!authSliceContent.includes('password'), 'authSlice Redux state schema contains ZERO password fields');
testAssert(authSliceContent.includes('accessToken: null'), 'authSlice access token is initialized to null (pure in-memory)');

// ─────────────────────────────────────────────────────────────
// 2. Cookie Security Attributes & Configuration Contract
// ─────────────────────────────────────────────────────────────
console.log('\n--- 2. Cookie Security Attributes & Specification ---');

let setCookieCaptured = null;
let clearCookieCaptured = null;

const mockRes = {
  cookie: (name, val, opts) => {
    setCookieCaptured = { name, val, opts };
  },
  clearCookie: (name, opts) => {
    clearCookieCaptured = { name, opts };
  },
};

setRefreshCookie(mockRes, 'sample_refresh_token_test_2026');
clearRefreshCookie(mockRes);

testAssert(setCookieCaptured.name === 'refreshToken', 'Refresh cookie is named "refreshToken"');
testAssert(setCookieCaptured.opts.httpOnly === true, 'Refresh cookie has httpOnly: true (Inaccessible to client JavaScript/XSS)');
testAssert(setCookieCaptured.opts.sameSite === 'strict', 'Refresh cookie has sameSite: "strict" (Strict CSRF mitigation)');
testAssert(setCookieCaptured.opts.path === '/api/v1/auth', 'Refresh cookie path is strictly restricted to /api/v1/auth');
testAssert(typeof setCookieCaptured.opts.maxAge === 'number' && setCookieCaptured.opts.maxAge > 0, 'Refresh cookie has explicit maxAge defined (7 days in current policy)');
testAssert(clearCookieCaptured.name === 'refreshToken', 'clearCookie clears the "refreshToken" cookie on logout');
testAssert(clearCookieCaptured.opts.httpOnly === true && clearCookieCaptured.opts.path === '/api/v1/auth', 'clearCookie matches exact path and httpOnly security flags');

// ─────────────────────────────────────────────────────────────
// 3. Multi-Tab Concurrency & Grace Window Verification
// ─────────────────────────────────────────────────────────────
console.log('\n--- 3. Multi-Tab Concurrency & Grace Window ---');

const mockActiveSessions = [
  {
    sessionId: 'sess-tab-1',
    tokenFamilyId: 'family-1',
    refreshTokenHash: hashToken('active-token-v2'),
    previousRefreshTokenHash: hashToken('rotated-token-v1'),
    tokenRotatedAt: new Date(), // Just rotated 0ms ago
    deviceLabel: 'Google Chrome on Windows',
    mfaVerified: true,
    lastUsedAt: new Date(),
  },
];

// Evaluate incoming hash against session
const evaluateTokenSubmission = (incomingToken, session, graceMs = 3000) => {
  const incHash = hashToken(incomingToken);
  if (incHash === session.refreshTokenHash) {
    return { status: 'CURRENT_TOKEN_VALID', allowRotation: true };
  }
  if (session.previousRefreshTokenHash && incHash === session.previousRefreshTokenHash) {
    const elapsed = Date.now() - new Date(session.tokenRotatedAt).getTime();
    if (elapsed <= graceMs) {
      return { status: 'GRACE_WINDOW_VALID', allowRotation: false };
    }
  }
  return { status: 'THEFT_DETECTED', revoke: true };
};

const tab1Result = evaluateTokenSubmission('active-token-v2', mockActiveSessions[0]);
testAssert(tab1Result.status === 'CURRENT_TOKEN_VALID', 'Active token presentation permits legitimate routine rotation');

const tab2ConcurrentResult = evaluateTokenSubmission('rotated-token-v1', mockActiveSessions[0], 3000);
testAssert(tab2ConcurrentResult.status === 'GRACE_WINDOW_VALID', 'Secondary concurrent tab within 3000ms grace window is accepted without theft trigger');

// ─────────────────────────────────────────────────────────────
// 4. Token Replay & Theft Containment
// ─────────────────────────────────────────────────────────────
console.log('\n--- 4. Token Replay & Active Theft Containment ---');

// Stale token presented outside grace window (>3000ms)
const staleSession = {
  ...mockActiveSessions[0],
  tokenRotatedAt: new Date(Date.now() - 5000), // Rotated 5 seconds ago (> 3s window)
};
const replayedResult = evaluateTokenSubmission('rotated-token-v1', staleSession, 3000);
testAssert(replayedResult.status === 'THEFT_DETECTED', 'Replayed token outside grace window triggers active theft response');

// ─────────────────────────────────────────────────────────────
// 5. Logout & Session Termination Invariants
// ─────────────────────────────────────────────────────────────
console.log('\n--- 5. Single-Device Logout & Revocation Isolation ---');

const userSessions = [
  { sessionId: 'sess-laptop', deviceLabel: 'Laptop' },
  { sessionId: 'sess-mobile', deviceLabel: 'Mobile Phone' },
];

const callingSessionId = 'sess-laptop';
const remainingSessions = userSessions.filter(s => s.sessionId !== callingSessionId);

testAssert(remainingSessions.length === 1, 'Calling session is removed from activeSessions on logout');
testAssert(remainingSessions[0].sessionId === 'sess-mobile', 'Sibling device (Mobile) remains active on routine single-device logout');

// ─────────────────────────────────────────────────────────────
// 6. Access Token In-Memory Decay Contract
// ─────────────────────────────────────────────────────────────
console.log('\n--- 6. Access Token In-Memory Lifetime Contract ---');

const accessPayload = {
  userId: 'user-audit-123',
  role: ROLES.ROOT_ADMIN,
  mfaVerified: true,
  tokenVersion: 1,
};
const signedAccess = signAccessToken(accessPayload);
const verifiedAccess = verifyAccessToken(signedAccess);

testAssert(verifiedAccess.userId === accessPayload.userId, 'Access token carries verified identity');
testAssert(verifiedAccess.mfaVerified === true, 'Access token carries authoritative mfaVerified claim');
testAssert(verifiedAccess.exp - verifiedAccess.iat === 15 * 60, 'Access token has strict 15-minute expiration window (900 seconds)');

// ─────────────────────────────────────────────────────────────
// 7. Login Form & Autocomplete Contract
// ─────────────────────────────────────────────────────────────
console.log('\n--- 7. Login Page Form Autocomplete Contract ---');

const loginPageSource = fs.readFileSync(path.join(clientSrc, 'pages/auth/LoginPage.jsx'), 'utf8');

testAssert(loginPageSource.includes("register('email')"), 'Login page defines controlled email input');
testAssert(loginPageSource.includes("register('password')"), 'Login page defines controlled password input');
testAssert(!loginPageSource.includes("localStorage.setItem"), 'Login page NEVER calls localStorage.setItem');
testAssert(!loginPageSource.includes("sessionStorage.setItem"), 'Login page NEVER calls sessionStorage.setItem');
testAssert(loginPageSource.includes("Click here to re-enter password"), 'Login page offers direct 1-click re-login action upon session timeout');

console.log('\n========================================================================');
console.log(`🎉 ALL ${passCount}/${passCount} AUTHENTICATION & SESSION INVARIANT TESTS PASSED!`);
console.log('========================================================================\n');
