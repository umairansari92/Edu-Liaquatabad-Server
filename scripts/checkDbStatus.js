import dotenv from 'dotenv';
dotenv.config();
import { connectDatabase } from '../config/database.js';
import School from '../src/models/School.js';
import User from '../src/models/User.js';
import TeacherProfile from '../src/models/TeacherProfile.js';
import StudentProfile from '../src/models/StudentProfile.js';
import Organization from '../src/models/Organization.js';
import Town from '../src/models/Town.js';

async function main() {
  await connectDatabase();
  const orgs = await Organization.find();
  const towns = await Town.find();
  const schools = await School.find();
  const users = await User.find();
  const teachers = await TeacherProfile.find();
  const students = await StudentProfile.find();

  console.log('--- DB SUMMARY ---');
  console.log('Organizations:', orgs.map(o => ({ id: o._id, code: o.code, name: o.name })));
  console.log('Towns:', towns.map(t => ({ id: t._id, code: t.code, name: t.name, orgId: t.organizationId })));
  const root = await User.findOne({ role: 'ROOT_ADMIN' });
  console.log('Root Admin Org:', root?.organizationId, 'Town:', root?.townId);
  console.log('Schools count:', schools.length);
  schools.forEach(s => console.log(`  - ${s.name} [${s.schoolCode}] (ID: ${s._id})`));
  console.log('Users count:', users.length);
  const roles = {};
  users.forEach(u => { roles[u.role] = (roles[u.role] || 0) + 1; });
  console.log('Roles breakdown:', roles);
  console.log('Teacher Profiles:', teachers.length);
  console.log('Student Profiles:', students.length);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
