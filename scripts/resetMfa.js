/**
 * Emergency CLI Tool: Reset User MFA for Device Change / Recovery
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Usage:
 * node scripts/resetMfa.js <email>
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDatabase } from '../config/database.js';
import User from '../src/models/User.js';
import AuditLog from '../src/models/AuditLog.js';

async function resetMfa() {
  const email = process.argv[2];

  if (!email) {
    console.error('❌ Usage: node scripts/resetMfa.js <email>');
    process.exit(1);
  }

  await connectDatabase();

  const normalizedEmail = email.toLowerCase().trim();
  const user = await User.findOne({ email: normalizedEmail }).select('+mfa +tokenVersion');

  if (!user) {
    console.error(`❌ User with email [${normalizedEmail}] not found.`);
    process.exit(1);
  }

  user.mfa = {
    enabled: false,
    enrolledAt: null,
    lastUsedAt: null,
    lastConsumedWindow: 0,
    recoveryCodes: [],
    secretCiphertext: null,
    secretIv: null,
    secretTag: null,
    pendingSecret: null,
  };

  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.activeSessions = [];
  await user.save();

  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    actorDesignation: 'CLI Maintenance Tool',
    actorName: 'CLI resetMfa.js',
    action: 'MFA_RESET_VIA_CLI',
    targetModel: 'User',
    targetId: user._id,
    targetName: user.fullName,
    townId: user.townId,
    schoolId: user.schoolId || null,
    result: 'SUCCESS',
    reason: 'MFA reset initiated via CLI for device change / re-enrollment.',
    ipAddress: '127.0.0.1 (CLI)',
    userAgent: 'Node.js CLI Process',
  });

  console.log(`\n================================================================`);
  console.log(`✅ MFA successfully cleared for [${normalizedEmail}] (${user.role})!`);
  console.log(`🔒 Token version incremented to ${user.tokenVersion}. All active sessions terminated.`);
  console.log(`📱 Next Steps:`);
  console.log(`   1. Open the portal and log in with ${normalizedEmail} and password.`);
  console.log(`   2. The setup wizard will immediately display the new QR code on screen.`);
  console.log(`   3. Scan it with Google Authenticator on your OWN mobile phone.`);
  console.log(`   4. Enter the 6-digit verification code to complete setup.`);
  console.log(`================================================================\n`);

  process.exit(0);
}

resetMfa().catch((err) => {
  console.error('❌ MFA reset execution failed:', err);
  process.exit(1);
});
