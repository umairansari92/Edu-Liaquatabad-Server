import mongoose from 'mongoose';

const AuditLogSchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actorRole: { type: String, required: true },
  action: { type: String, required: true, index: true },

  targetModel: { type: String, required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

  townId: { type: mongoose.Schema.Types.ObjectId, ref: 'Town', index: true },
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true },

  previousState: { type: mongoose.Schema.Types.Mixed },
  newState: { type: mongoose.Schema.Types.Mixed },

  ipAddress: { type: String, default: '' },
  userAgent: { type: String, default: '' },
}, {
  timestamps: { createdAt: true, updatedAt: false }, // Immutable
});

export default mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
