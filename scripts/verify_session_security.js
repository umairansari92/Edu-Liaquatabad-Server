/**
 * verify_session_security.js
 * Comprehensive automated regression and security test for Device Session Management:
 * 1. Isolated session retrieval (no cross-user leakage)
 * 2. Cross-user IDOR / BOLA termination prevention (404 rejection)
 * 3. Targeted remote session termination
 * 4. Revocation verification (terminated session refresh token invalidation)
 * 5. Preservation of untouched active sessions
 * 6. AuditLog creation with SESSION_TERMINATED
 * 7. Token/secret sanitization check (no hashes or JWTs exposed)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import User from '../src/models/User.js';
import AuditLog from '../src/models/AuditLog.js';
import {
  signAccessToken,
  signRefreshToken,
  hashToken,
} from '../src/utils/tokenUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/school_management_db';
const BASE_URL = 'http://localhost:5000/api/v1';

async function runSessionSecurityTests() {
  console.log('\n===============================================================');
  console.log('--- STARTING SESSION MANAGEMENT & SECURITY TEST SUITE ---');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB.\n');

    // Retrieve two test users (HM and Teacher)
    const userA = await User.findOne({ email: 'staff01.liaquatabad@dmc.gov.pk' }).select('+activeSessions');
    const userB = await User.findOne({ email: 'staff16.liaquatabad@dmc.gov.pk' }).select('+activeSessions');

    if (!userA || !userB) {
      throw new Error('Test users staff01 and staff16 not found.');
    }

    console.log(`User A (HM): ${userA.fullName} (${userA._id})`);
    console.log(`User B (Teacher): ${userB.fullName} (${userB._id})\n`);

    // Setup 2 mock sessions for User A and 1 for User B
    const sessionA1Id = 'test-session-a1-' + Date.now();
    const sessionA2Id = 'test-session-a2-' + Date.now();
    const sessionB1Id = 'test-session-b1-' + Date.now();

    const refreshTokenA1 = signRefreshToken({
      userId: userA._id,
      tokenVersion: userA.tokenVersion || 0,
      sessionId: sessionA1Id,
      tokenFamilyId: 'family-a1',
    });
    const refreshTokenA2 = signRefreshToken({
      userId: userA._id,
      tokenVersion: userA.tokenVersion || 0,
      sessionId: sessionA2Id,
      tokenFamilyId: 'family-a2',
    });
    const refreshTokenB1 = signRefreshToken({
      userId: userB._id,
      tokenVersion: userB.tokenVersion || 0,
      sessionId: sessionB1Id,
      tokenFamilyId: 'family-b1',
    });

    userA.activeSessions = [
      {
        sessionId: sessionA1Id,
        tokenFamilyId: 'family-a1',
        deviceLabel: 'Google Chrome on Windows (Current)',
        refreshTokenHash: hashToken(refreshTokenA1),
        createdAt: new Date(),
        lastUsedAt: new Date(),
      },
      {
        sessionId: sessionA2Id,
        tokenFamilyId: 'family-a2',
        deviceLabel: 'Mobile Safari on iPhone (Remote)',
        refreshTokenHash: hashToken(refreshTokenA2),
        createdAt: new Date(Date.now() - 3600000),
        lastUsedAt: new Date(Date.now() - 3600000),
      },
    ];
    await userA.save();

    userB.activeSessions = [
      {
        sessionId: sessionB1Id,
        tokenFamilyId: 'family-b1',
        deviceLabel: 'Mozilla Firefox on Linux',
        refreshTokenHash: hashToken(refreshTokenB1),
        createdAt: new Date(),
        lastUsedAt: new Date(),
      },
    ];
    await userB.save();

    const accessTokenA1 = signAccessToken({
      userId: userA._id,
      role: userA.role,
      designation: userA.designation,
      scope: userA.scope,
      tokenVersion: userA.tokenVersion || 0,
      organizationId: userA.organizationId,
      townId: userA.townId,
      schoolId: userA.schoolId,
      assignedSchools: userA.assignedSchools || [],
      mfaVerified: true,
    });

    // 1. User A lists sessions
    console.log('--- Test 1: User A lists active sessions ---');
    const listRes = await fetch(`${BASE_URL}/auth/sessions`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessTokenA1}`,
        'Cookie': `refreshToken=${refreshTokenA1}`,
      },
    });
    const listJson = await listRes.json();

    assert(listRes.status === 200, 'GET /api/v1/auth/sessions returned 200');
    assert(listJson.success === true, 'Response body success is true');
    const sessionsA = listJson.data?.sessions || [];
    assert(Array.isArray(sessionsA), 'Sessions list is an array');
    assert(sessionsA.length === 2, 'Sessions list contains exactly 2 sessions for User A');
    
    const returnedA1 = sessionsA.find(s => s.sessionId === sessionA1Id);
    const returnedA2 = sessionsA.find(s => s.sessionId === sessionA2Id);
    const returnedB1 = sessionsA.find(s => s.sessionId === sessionB1Id);

    assert(returnedA1 && returnedA1.isCurrentSession === true, 'Current session A1 is correctly tagged isCurrentSession=true');
    assert(returnedA2 && returnedA2.isCurrentSession === false, 'Remote session A2 is tagged isCurrentSession=false');
    assert(!returnedB1, 'Session B1 from User B is NOT present (isolated boundary)');

    // Check token sanitization
    const hasSecretLeak = sessionsA.some(s => s.refreshTokenHash || s.refreshToken || s.token);
    assert(!hasSecretLeak, 'No tokens, hashes, or secret keys leaked in session list');

    // 2. Cross-user IDOR / BOLA attempt: User A tries to terminate User B's session
    console.log('\n--- Test 2: Cross-user BOLA/IDOR attempt (User A terminates User B session) ---');
    const idorRes = await fetch(`${BASE_URL}/auth/sessions/${sessionB1Id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessTokenA1}`,
        'Cookie': `refreshToken=${refreshTokenA1}`,
      },
    });
    const idorJson = await idorRes.json();

    assert(idorRes.status === 404, 'DELETE /api/v1/auth/sessions/:sessionId for User B session returns 404');
    assert(idorJson.message === 'Session not found or already terminated.', 'Expected rejection message returned');

    // Verify User B's session was unaffected in DB
    const freshUserB = await User.findById(userB._id).select('+activeSessions');
    assert(freshUserB.activeSessions.some(s => s.sessionId === sessionB1Id), 'User B session B1 remains active and untouched');

    // 3. User A terminates remote session A2
    console.log('\n--- Test 3: User A terminates remote session A2 ---');
    const termRes = await fetch(`${BASE_URL}/auth/sessions/${sessionA2Id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessTokenA1}`,
        'Cookie': `refreshToken=${refreshTokenA1}`,
      },
    });
    const termJson = await termRes.json();

    assert(termRes.status === 200, 'DELETE /api/v1/auth/sessions/:sessionId returns 200');
    assert(termJson.success === true, 'Response success is true');

    // Verify session A2 is gone from User A
    const freshUserA = await User.findById(userA._id).select('+activeSessions');
    assert(freshUserA.activeSessions.length === 1, 'User A now has exactly 1 active session in DB');
    assert(!freshUserA.activeSessions.some(s => s.sessionId === sessionA2Id), 'Remote session A2 removed from DB');
    assert(freshUserA.activeSessions.some(s => s.sessionId === sessionA1Id), 'Current session A1 remains active');

    // 4. Verify terminated session A2 refresh token cannot be used
    console.log('\n--- Test 4: Revocation verification using terminated session A2 token ---');
    const refreshRes = await fetch(`${BASE_URL}/auth/refresh-token`, {
      method: 'POST',
      headers: {
        'Cookie': `refreshToken=${refreshTokenA2}`,
      },
    });

    assert(refreshRes.status === 401, 'Terminated session refresh token rejected with 401');

    // 5. Verify AuditLog creation
    console.log('\n--- Test 5: Verify AuditLog record for session termination ---');
    const auditRecord = await AuditLog.findOne({
      action: 'SESSION_TERMINATED',
      actorId: userA._id,
    }).sort({ createdAt: -1 });

    assert(!!auditRecord, 'AuditLog entry found for SESSION_TERMINATED');
    assert(auditRecord.result === 'SUCCESS', 'AuditLog result is SUCCESS');
    assert(auditRecord.targetModel === 'User', 'AuditLog targetModel is User');

    // 6. Terminate current session A1 and verify refresh cookie cleared
    console.log('\n--- Test 6: Terminate current session A1 clears cookie ---');
    const termCurrentRes = await fetch(`${BASE_URL}/auth/sessions/${sessionA1Id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessTokenA1}`,
        'Cookie': `refreshToken=${refreshTokenA1}`,
      },
    });

    assert(termCurrentRes.status === 200, 'Terminating current session returns 200');
    const setCookieHeader = termCurrentRes.headers.get('set-cookie') || '';
    const clearedCookie = setCookieHeader.includes('refreshToken=;') || setCookieHeader.includes('Max-Age=0') || setCookieHeader.includes('Expires=Thu, 01 Jan 1970');
    assert(clearedCookie, 'Set-Cookie header invalidates/clears refreshToken cookie');

    console.log('\n===============================================================');
    console.log(`SESSION SECURITY TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('===============================================================\n');

  } catch (error) {
    console.error('Test suite error:', error);
    failed++;
  } finally {
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
  }
}

runSessionSecurityTests();
