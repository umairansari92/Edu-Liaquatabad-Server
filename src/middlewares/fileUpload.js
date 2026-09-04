import multer from 'multer';
import path from 'path';

// Pillar 5: 100% In-Memory Storage (Zero disk storage footprint)
const memoryStorage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const FORBIDDEN_EXTENSIONS = new Set([
  '.exe', '.sh', '.bat', '.cmd', '.php', '.phtml', '.js', '.ts', '.vbs',
  '.svg', '.html', '.htm', '.xhtml', '.shtml', '.asp', '.aspx', '.jsp',
  '.jar', '.py', '.rb', '.pl', '.cgi',
]);

/**
 * Sanitizes original filenames to eliminate path traversal and null bytes
 */
export const sanitizeFilename = (filename) => {
  if (!filename) return 'document';
  const basename = path.basename(filename);
  return basename
    .replace(/\0/g, '')
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .slice(0, 100);
};

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();

  // 1. Explicitly reject dangerous or scriptable file extensions
  if (FORBIDDEN_EXTENSIONS.has(ext)) {
    return cb(new Error(`Security rejection: File extension [${ext}] is strictly prohibited.`), false);
  }

  // 2. Assert MIME-type in allowed set
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(
      new Error(`Unsupported file format (${file.mimetype}). Permitted types: PDF, JPEG, PNG, WEBP, DOC, DOCX`),
      false
    );
  }

  // Sanitize filename on the file object
  file.sanitizedFilename = sanitizeFilename(file.originalname);
  cb(null, true);
};

export const uploadInMemory = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB max limit per file
    files: 5,                   // Maximum 5 files per request
  },
  fileFilter,
});

/**
 * Binary Magic-Byte File Signature Validator Middleware
 * Inspects raw buffer bytes to prevent MIME-type spoofing
 */
export const validateFileMagicBytes = (req, res, next) => {
  const file = req.file;
  if (!file || !file.buffer || file.buffer.length < 4) {
    return next();
  }

  const buf = file.buffer;
  let isValid = false;
  const mime = file.mimetype;

  // PDF: %PDF- (0x25 0x50 0x44 0x46)
  if (mime === 'application/pdf' && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    isValid = true;
  }
  // JPEG: FF D8 FF
  else if (mime === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    isValid = true;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  else if (
    mime === 'image/png' &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    isValid = true;
  }
  // WebP: RIFF at 0, WEBP at 8
  else if (
    mime === 'image/webp' &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    isValid = true;
  }
  // DOCX / Office Open XML (ZIP): PK (0x50 0x4B 0x03 0x04)
  else if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
  ) {
    isValid = true;
  }
  // Legacy DOC: 0xD0 0xCF 0x11 0xE0
  else if (
    mime === 'application/msword' &&
    buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
  ) {
    isValid = true;
  }

  if (!isValid) {
    return res.status(400).json({
      success: false,
      statusCode: 400,
      message: `File content verification failed: binary signature does not match declared type (${mime}).`,
    });
  }

  next();
};
