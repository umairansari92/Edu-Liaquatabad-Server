import cloudinary from '../../config/cloudinary.js';

/**
 * Uploads an in-memory file buffer directly to Cloudinary using upload_stream
 *
 * @param {Buffer} fileBuffer - req.file.buffer from multer.memoryStorage
 * @param {Object} options
 * @param {string} options.folder - Cloudinary target folder (e.g. 'liaquatabad_sms/attendance')
 * @param {string} options.resourceType - 'image' | 'raw' | 'auto' (default: 'auto')
 * @param {string} [options.publicId] - Optional custom public ID
 * @returns {Promise<{ secure_url: string, public_id: string, format: string, bytes: number }>}
 */
export const uploadBufferToCloudinary = (fileBuffer, options = {}) => {
  const {
    folder = 'liaquatabad_sms/general',
    resourceType = 'auto',
    publicId = undefined,
  } = options;

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        public_id: publicId,
      },
      (error, result) => {
        if (error) {
          console.error('[Cloudinary Upload Error]', error.message);
          return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        }
        resolve({
          secureUrl: result.secure_url,
          publicId: result.public_id,
          format: result.format,
          bytes: result.bytes,
          resourceType: result.resource_type,
        });
      }
    );

    uploadStream.end(fileBuffer);
  });
};

/**
 * Deletes a file from Cloudinary by its public ID
 *
 * @param {string} publicId
 * @param {string} resourceType - 'image' | 'raw' | 'video'
 * @returns {Promise<Object>}
 */
export const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    return result;
  } catch (error) {
    console.error('[Cloudinary Delete Error]', error.message);
    throw new Error(`Failed to delete resource from Cloudinary: ${error.message}`);
  }
};

export default {
  uploadBufferToCloudinary,
  deleteFromCloudinary,
};
