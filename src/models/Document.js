import mongoose from 'mongoose';
import { DOCUMENT_TYPES, AUDIENCE_TYPES } from '../../config/constants.js';

const DocumentSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  townId: { type: mongoose.Schema.Types.ObjectId, ref: 'Town', index: true },
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true },

  title: { type: String, required: true, trim: true },
  documentType: {
    type: String,
    enum: Object.values(DOCUMENT_TYPES),
    required: true,
    index: true,
  },

  description: { type: String, default: '' },
  fileUrl: { type: String, required: true },
  cloudinaryPublicId: { type: String, required: true },
  fileMimeType: { type: String, required: true },
  fileSizeBytes: { type: Number },

  targetAudience: [{
    type: String,
    enum: Object.values(AUDIENCE_TYPES),
  }],

  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  publisherRole: { type: String, required: true },
  status: {
    type: String,
    enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
    default: 'PUBLISHED',
    index: true,
  },
}, { timestamps: true });

export default mongoose.models.Document || mongoose.model('Document', DocumentSchema);
