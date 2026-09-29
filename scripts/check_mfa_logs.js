import mongoose from 'mongoose';
import '../src/models/AuditLog.js';
import '../src/models/User.js';

import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGODB_URI;
async function main() {
  await mongoose.connect(uri);
  const AuditLog = mongoose.model('AuditLog');
  const logs = await AuditLog.find({ action: { $regex: 'MFA' } }).sort({ createdAt: -1 }).limit(20);
  console.log('--- RECENT MFA AUDIT LOGS ---');
  logs.forEach(l => {
    console.log(`${l.createdAt.toISOString()} | Action: ${l.action} | Result: ${l.result} | Reason: ${l.reason || 'N/A'}`);
  });
  await mongoose.disconnect();
}
main().catch(console.error);
