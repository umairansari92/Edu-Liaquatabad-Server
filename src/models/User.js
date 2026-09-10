import mongoose from 'mongoose';
import { ROLES, BASE_ROLES, SCOPES, USER_STATUS, ROLE_HIERARCHY } from '../../config/constants.js';

const UserSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  townId: { type: mongoose.Schema.Types.ObjectId, ref: 'Town', index: true },
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true },
  assignedSchools: [{ type: mongoose.Schema.Types.ObjectId, ref: 'School' }],

  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  phoneNumber: { type: String, trim: true, default: '' },

  // Civil Service Title (e.g., "DDO", "Senior Clerk", "Accountant", "Head Master", "Teacher")
  // MANDATE: Designation has ZERO authorization power. Free-text metadata only.
  designation: { type: String, trim: true, default: '' },

  // Controlled Base Role at Onboarding (PEON, TEACHER, SUPERVISOR, STUDENT, PARENT)
  baseRole: {
    type: String,
    enum: Object.values(BASE_ROLES),
    default: function () {
      if (this.role && Object.values(BASE_ROLES).includes(this.role)) {
        return this.role;
      }
      if ([ROLES.HM, ROLES.TEACHER].includes(this.role)) return BASE_ROLES.TEACHER;
      if (this.role === ROLES.SUPERVISOR) return BASE_ROLES.SUPERVISOR;
      return BASE_ROLES.TEACHER;
    },
    index: true,
  },

  // System Authority Role (Technical Authorization Boundary)
  role: {
    type: String,
    enum: Object.values(ROLES),
    required: true,
    index: true,
  },

  // Operational Jurisdictional Scope (GLOBAL, TOWN, ASSIGNED_SCHOOLS, SCHOOL, CLASS_SECTION, SELF, CHILD)
  scope: {
    type: String,
    enum: Object.values(SCOPES),
    required: true,
  },

  // Optional Granular Capability Overrides (Bounded by Permission Ceiling)
  customPermissions: [{ type: String }],

  // Lifecycle State
  status: {
    type: String,
    enum: Object.values(USER_STATUS),
    default: USER_STATUS.PENDING_APPROVAL,
    index: true,
  },

  approvalDetails: {
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectionReason: { type: String, default: '' },
    correctionRemarks: { type: String, default: '' },
  },

  // Security & Session Revocation
  tokenVersion: { type: Number, default: 0 },
  lastLoginAt: { type: Date },
  refreshTokenHash: { type: String, select: false },
}, { timestamps: true });

// Virtual to easily read numerical hierarchy level
UserSchema.virtual('roleLevel').get(function () {
  return ROLE_HIERARCHY[this.role] || 0;
});

// Virtual alias: grantedAuthority maps to technical system role
UserSchema.virtual('grantedAuthority').get(function () {
  return this.role;
});

UserSchema.set('toJSON', { virtuals: true });
UserSchema.set('toObject', { virtuals: true });

export default mongoose.models.User || mongoose.model('User', UserSchema);
