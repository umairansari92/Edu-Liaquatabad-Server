import mongoose from 'mongoose';

const NotificationSchema = new mongoose.Schema({
  recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  notificationType: {
    type: String,
    enum: ['ONBOARDING', 'TRANSFER', 'ATTENDANCE', 'EXAM_RESULT', 'CIRCULAR', 'SECURITY_ALERT'],
    required: true,
  },
  actionLink: { type: String, default: '' },
  isRead: { type: Boolean, default: false, index: true },
}, { timestamps: true });

export default mongoose.models.Notification || mongoose.model('Notification', NotificationSchema);
