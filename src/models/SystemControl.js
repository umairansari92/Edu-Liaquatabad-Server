import mongoose from 'mongoose';

const systemControlSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'SYSTEM_STATUS',
      trim: true,
    },
    isSuspended: {
      type: Boolean,
      default: false,
    },
    errorMessage: {
      type: String,
      default: 'Database connection pool exhausted: Connection timed out to primary replica cluster (Error: 0x80040154_DB_CLUSTER_FAIL).',
      trim: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const SystemControl = mongoose.model('SystemControl', systemControlSchema);

export default SystemControl;
