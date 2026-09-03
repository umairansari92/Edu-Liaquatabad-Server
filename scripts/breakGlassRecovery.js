/**
 * Emergency Break-Glass Root Admin Recovery Script
 * Education Department Liaquatabad Town Centre (DMC)
 *
 * Usage:
 * node scripts/breakGlassRecovery.js <root_admin_email> <new_password>
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { connectDatabase } from '../config/database.js';
import User from '../src/models/User.js';
import AuditLog from '../src/models/AuditLog.js';
import Organization from '../src/models/Organization.js';
import Town from '../src/models/Town.js';
import { ROLES, SCOPES, USER_STATUS } from '../config/constants.js';
import { hashPassword } from '../src/utils/passwordUtils.js';

async function executeBreakGlass() {
  const email = process.argv[2];
  const newPassword = process.argv[3];

  if (!email || !newPassword) {
    console.error('❌ Usage: node scripts/breakGlassRecovery.js <email> <new_password>');
    process.exit(1);
  }

  if (newPassword.length < 12) {
    console.error('❌ Break-glass emergency password must be at least 12 characters.');
    process.exit(1);
  }

  await connectDatabase();

  const normalizedEmail = email.toLowerCase().trim();
  let rootUser = await User.findOne({ email: normalizedEmail });

  const passwordHash = await hashPassword(newPassword);

  if (rootUser) {
    // Elevate and reset existing account to ROOT_ADMIN
    rootUser.role = ROLES.ROOT_ADMIN;
    rootUser.scope = SCOPES.GLOBAL;
    rootUser.designation = 'Supreme Platform Authority (Break-Glass)';
    rootUser.status = USER_STATUS.ACTIVE;
    rootUser.passwordHash = passwordHash;
    rootUser.tokenVersion = (rootUser.tokenVersion || 0) + 1;
    await rootUser.save();
    console.log(`✅ Existing account [${normalizedEmail}] successfully recovered and elevated to ROOT_ADMIN.`);
  } else {
    // Provision fresh bootstrap ROOT_ADMIN
    let org = await Organization.findOne({ code: 'DMC_LIAQUATABAD' });
    if (!org) {
      org = await Organization.create({
        name: 'Education Department (DMC)',
        code: 'DMC_LIAQUATABAD',
      });
    }

    let town = await Town.findOne({ code: 'TOWN_LIAQ' });
    if (!town) {
      town = await Town.create({
        organizationId: org._id,
        name: 'Liaquatabad Town Centre',
        code: 'TOWN_LIAQ',
      });
    }

    rootUser = await User.create({
      organizationId: org._id,
      townId: town._id,
      fullName: 'System Root Administrator',
      email: normalizedEmail,
      designation: 'Supreme Platform Authority (Break-Glass)',
      role: ROLES.ROOT_ADMIN,
      scope: SCOPES.GLOBAL,
      status: USER_STATUS.ACTIVE,
      passwordHash,
      tokenVersion: 1,
    });
    console.log(`✅ New bootstrap ROOT_ADMIN account [${normalizedEmail}] provisioned.`);
  }

  // Record Immutable Audit Log
  await AuditLog.create({
    actorId: rootUser._id,
    actorRole: ROLES.ROOT_ADMIN,
    actorDesignation: 'CLI Emergency Recovery Engine',
    actorName: 'CLI Break-Glass Tool',
    action: 'ROOT_ADMIN_BREAK_GLASS_TRIGGERED',
    targetModel: 'User',
    targetId: rootUser._id,
    targetName: rootUser.fullName,
    newState: { role: ROLES.ROOT_ADMIN, status: USER_STATUS.ACTIVE, email: rootUser.email },
    result: 'SUCCESS',
    reason: 'Emergency command-line break-glass recovery procedure executed.',
    ipAddress: '127.0.0.1 (CLI)',
    userAgent: 'Node.js CLI Process',
  });

  console.log('🔒 Immutable Audit Log committed: ROOT_ADMIN_BREAK_GLASS_TRIGGERED');
  console.log('🎉 Break-Glass recovery complete. You may now sign in to the platform.');
  process.exit(0);
}

executeBreakGlass().catch((err) => {
  console.error('❌ Break-glass execution failed:', err);
  process.exit(1);
});
