import mongoose from 'mongoose';

const AuditLogSchema = new mongoose.Schema({
  // WHO (Actor)
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actorRole: { type: String, required: true, index: true },
  actorDesignation: { type: String, default: '' },
  actorName: { type: String, default: '' },

  // WHAT (Action)
  action: { type: String, required: true, index: true },

  // TARGET (Affected Entity)
  targetModel: { type: String, required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  targetName: { type: String, default: '' },

  // WHERE (Context Boundaries)
  townId: { type: mongoose.Schema.Types.ObjectId, ref: 'Town', index: true },
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true },

  // STATE DIFF (Git-like Before & After)
  previousState: { type: mongoose.Schema.Types.Mixed },
  newState: { type: mongoose.Schema.Types.Mixed },

  // OUTCOME & JUSTIFICATION
  result: {
    type: String,
    enum: ['SUCCESS', 'DENIED', 'ERROR'],
    default: 'SUCCESS',
    index: true,
  },
  reason: { type: String, default: '' },

  // SECURITY TELEMETRY
  ipAddress: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  requestId: { type: String, default: '' },
}, {
  timestamps: { createdAt: true, updatedAt: false }, // Immutable Append-Only
});

// Explicitly prevent any update or delete operations on audit collection
AuditLogSchema.pre('updateOne', function () {
  throw new Error('Audit logs are strictly append-only. Modification is forbidden.');
});
AuditLogSchema.pre('updateMany', function () {
  throw new Error('Audit logs are strictly append-only. Modification is forbidden.');
});
AuditLogSchema.pre('deleteOne', function () {
  throw new Error('Audit logs are strictly append-only. Deletion is forbidden.');
});
AuditLogSchema.pre('deleteMany', function () {
  throw new Error('Audit logs are strictly append-only. Deletion is forbidden.');
});

export default mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
