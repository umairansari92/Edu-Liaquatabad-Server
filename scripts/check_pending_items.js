import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

await mongoose.connect(process.env.MONGODB_URI);
const SAR = mongoose.model('StaffAttendanceRecord', new mongoose.Schema({}, { strict: false }));
const LR = mongoose.model('LeaveRequest', new mongoose.Schema({}, { strict: false }));

const pendingAttendance = await SAR.find({ approvalStatus: 'PENDING' }).lean();
const leaves = await LR.find({ status: { $in: ['PENDING', 'SUPERSEDED', 'REJECTED'] } }).lean();

console.log('Pending Staff Attendance count:', pendingAttendance.length);
console.log('Pending Leaves count:', leaves.length);
console.log(JSON.stringify(leaves.map(l => ({
  id: l._id,
  type: l.leaveType,
  status: l.status,
  staffRole: l.staffRole,
  schoolId: l.schoolId,
  reason: l.reason
})), null, 2));

await mongoose.disconnect();
