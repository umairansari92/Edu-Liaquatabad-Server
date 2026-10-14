import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyPassword } from '../src/utils/passwordUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

await mongoose.connect(process.env.MONGODB_URI);
const User = mongoose.model('User', new mongoose.Schema({
  email: String,
  passwordHash: String,
  role: String,
  fullName: String
}, { strict: false }));

const testAccounts = [
  'staff01.liaquatabad@dmc.gov.pk',
  'staff16.liaquatabad@dmc.gov.pk',
  'test.staff01@example.test',
  'redteam.http.admin.1791720202475@example.test',
  'supervisor.1791718370724@example.test',
  'liaquatabadeducation@gmail.com'
];

const passwordsToTry = [
  'Liaquatabad2026!',
  'DevPassword2026!',
  'Admin@123456',
  'RootAdmin2026!'
];

for (const email of testAccounts) {
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user) {
    console.log(`User not found: ${email}`);
    continue;
  }
  let matched = null;
  for (const pwd of passwordsToTry) {
    const ok = await verifyPassword(pwd, user.passwordHash);
    if (ok) {
      matched = pwd;
      break;
    }
  }
  console.log(`User: ${email} (${user.role}) -> Password match: ${matched || 'NONE'}`);
}

await mongoose.disconnect();
