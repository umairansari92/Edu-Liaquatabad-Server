import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

await mongoose.connect(process.env.MONGODB_URI);
const User = mongoose.model('User', new mongoose.Schema({
  email: String,
  role: String,
  fullName: String,
  status: String,
  schoolId: mongoose.Schema.Types.ObjectId,
  mfa: Object
}, { strict: false }));

const users = await User.find({
  role: { $in: ['ROOT_ADMIN', 'SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'HM'] }
}, 'email role fullName status schoolId mfa.isEnabled').lean();

console.log('Privileged / HM users count:', users.length);
console.log(JSON.stringify(users.map(u => ({
  email: u.email,
  role: u.role,
  fullName: u.fullName,
  mfaEnabled: !!u.mfa?.isEnabled,
  schoolId: u.schoolId
})), null, 2));

await mongoose.disconnect();
