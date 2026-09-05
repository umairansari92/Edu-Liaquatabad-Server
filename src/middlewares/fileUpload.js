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

const fileFilter = (request, uploadedFile, callbackFunction) => {
  const fileExtension = path.extname(uploadedFile.originalname || '').toLowerCase();

  // 1. Explicitly reject dangerous or scriptable file extensions
  if (FORBIDDEN_EXTENSIONS.has(fileExtension)) {
    return callbackFunction(new Error(`Security rejection: File extension [${fileExtension}] is strictly prohibited.`), false);
  }

  // 2. Assert MIME-type in allowed set
  if (!ALLOWED_MIME_TYPES.has(uploadedFile.mimetype)) {
    return callbackFunction(
      new Error(`Unsupported file format (${uploadedFile.mimetype}). Permitted types: PDF, JPEG, PNG, WEBP, DOC, DOCX`),
      false
    );
  }

  // Sanitize filename on the file object
  uploadedFile.sanitizedFilename = sanitizeFilename(uploadedFile.originalname);
  callbackFunction(null, true);
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
export const validateFileMagicBytes = (request, response, nextFunction) => {
  const uploadedFile = request.file;
  if (!uploadedFile || !uploadedFile.buffer || uploadedFile.buffer.length < 4) {
    return nextFunction();
  }

  const fileBuffer = uploadedFile.buffer;
  let isSignatureValid = false;
  const declaredMimeType = uploadedFile.mimetype;

  // PDF: %PDF- (0x25 0x50 0x44 0x46)
  if (declaredMimeType === 'application/pdf' && fileBuffer[0] === 0x25 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x44 && fileBuffer[3] === 0x46) {
    isSignatureValid = true;
  }
  // JPEG: FF D8 FF
  else if (declaredMimeType === 'image/jpeg' && fileBuffer[0] === 0xff && fileBuffer[1] === 0xd8 && fileBuffer[2] === 0xff) {
    isSignatureValid = true;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  else if (
    declaredMimeType === 'image/png' &&
    fileBuffer[0] === 0x89 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x4e && fileBuffer[3] === 0x47
  ) {
    isSignatureValid = true;
  }
  // WebP: RIFF at 0, WEBP at 8
  else if (
    declaredMimeType === 'image/webp' &&
    fileBuffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    fileBuffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    isSignatureValid = true;
  }
  // DOCX / Office Open XML (ZIP): PK (0x50 0x4B 0x03 0x04)
  else if (
    declaredMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4b && fileBuffer[2] === 0x03 && fileBuffer[3] === 0x04
  ) {
    isSignatureValid = true;
  }
  // Legacy DOC: 0xD0 0xCF 0x11 0xE0
  else if (
    declaredMimeType === 'application/msword' &&
    fileBuffer[0] === 0xd0 && fileBuffer[1] === 0xcf && fileBuffer[2] === 0x11 && fileBuffer[3] === 0xe0
  ) {
    isSignatureValid = true;
  }

  if (!isSignatureValid) {
    return response.status(400).json({
      success: false,
      statusCode: 400,
      message: `File content verification failed: binary signature does not match declared type (${declaredMimeType}).`,
    });
  }

  nextFunction();
};
