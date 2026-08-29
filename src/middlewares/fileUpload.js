import multer from 'multer';

// Pillar 5: 100% In-Memory Storage (Zero disk storage footprint)
const memoryStorage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file format (${file.mimetype}). Permitted types: PDF, JPEG, PNG, WEBP, DOC, DOCX`), false);
  }
};

export const uploadInMemory = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB max limit
  },
  fileFilter,
});
