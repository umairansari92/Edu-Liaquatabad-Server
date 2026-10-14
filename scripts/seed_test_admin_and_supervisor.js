import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { hashPassword } from '../src/utils/passwordUtils.js';
import { ROLES, BASE_ROLES, SCOPES, USER_STATUS } from '../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

await mongoose.connect(process.env.MONGODB_URI);
const Organization = mongoose.model('Organization', new mongoose.Schema({ name: String, code: String }, { strict: false }));
const Town = mongoose.model('Town', new mongoose.Schema({ name: String, code: String, organizationId: mongoose.Schema.Types.ObjectId }, { strict: false }));
const School = mongoose.model('School', new mongoose.Schema({ name: String, schoolCode: String, townId: mongoose.Schema.Types.ObjectId }, { strict: false }));
const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }));

const org = await Organization.findOne();
const town = await Town.findOne();
const schools = await School.find();
const schoolIds = schools.map(s => s._id);

const passwordHash = await hashPassword('Liaquatabad2026!');

// 1. Admin
const adminUser = await User.findOneAndUpdate(
  { email: 'admin.liaquatabad@dmc.gov.pk' },
  {
    $set: {
      organizationId: org._id,
      townId: town._id,
      fullName: 'Tariq Mehmood Siddiqui (Town Admin)',
      email: 'admin.liaquatabad@dmc.gov.pk',
      passwordHash,
      role: ROLES.ADMIN,
      baseRole: BASE_ROLES.SUPERVISOR,
      scope: SCOPES.TOWN,
      status: USER_STATUS.ACTIVE,
      assignedSchools: schoolIds,
      tokenVersion: 0,
      'mfa.enabled': false
    }
  },
  { upsert: true, new: true }
);

// 2. Supervisor
const supervisorUser = await User.findOneAndUpdate(
  { email: 'supervisor.liaquatabad@dmc.gov.pk' },
  {
    $set: {
      organizationId: org._id,
      townId: town._id,
      fullName: 'Muhammad Rizwan Abbasi (Field Supervisor)',
      email: 'supervisor.liaquatabad@dmc.gov.pk',
      passwordHash,
      role: ROLES.SUPERVISOR,
      baseRole: BASE_ROLES.TEACHER,
      scope: SCOPES.TOWN,
      status: USER_STATUS.ACTIVE,
      assignedSchools: schoolIds,
      tokenVersion: 0,
      'mfa.enabled': false
    }
  },
  { upsert: true, new: true }
);

console.log('Seeded / Verified Admin:', adminUser.email, adminUser.role);
console.log('Seeded / Verified Supervisor:', supervisorUser.email, supervisorUser.role);

await mongoose.disconnect();
