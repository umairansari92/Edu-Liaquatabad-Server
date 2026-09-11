import mongoose from 'mongoose';
import SystemControl from '../models/SystemControl.js';

const DEFAULT_ERROR_MESSAGE =
  'Database connection pool exhausted: Connection timed out to primary replica cluster (Error: 0x80040154_DB_CLUSTER_FAIL).';

// In-memory ultra-fast cache
let isSuspendedCache = false;
let errorMessageCache = DEFAULT_ERROR_MESSAGE;
let isInitialized = false;

/**
 * Initialize system control cache from MongoDB on server startup
 */
export const initSystemControl = async () => {
  if (mongoose.connection.readyState !== 1) return;
  try {
    let doc = await SystemControl.findOne({ key: 'SYSTEM_STATUS' });
    if (!doc) {
      doc = await SystemControl.create({
        key: 'SYSTEM_STATUS',
        isSuspended: false,
        errorMessage: DEFAULT_ERROR_MESSAGE,
      });
    }
    isSuspendedCache = Boolean(doc.isSuspended);
    errorMessageCache = doc.errorMessage || DEFAULT_ERROR_MESSAGE;
    isInitialized = true;
    console.log(
      `[SystemControl] Initialized. Status: ${isSuspendedCache ? '🔴 SUSPENDED (OUTAGE ACTIVE)' : '🟢 OPERATIONAL'}`
    );
  } catch (error) {
    console.error('[SystemControl] Initialization failed:', error.message);
  }
};

/**
 * Get current system status from in-memory cache
 */
export const getSystemStatus = () => {
  return {
    isSuspended: isSuspendedCache,
    errorMessage: errorMessageCache,
    isInitialized,
  };
};

/**
 * Set system suspension status, updating both cache and DB
 */
export const setSystemStatus = async (isSuspended, errorMessage = null, updatedBy = null) => {
  const finalErrorMessage = errorMessage && errorMessage.trim() ? errorMessage.trim() : DEFAULT_ERROR_MESSAGE;
  
  isSuspendedCache = Boolean(isSuspended);
  errorMessageCache = finalErrorMessage;

  let result = {
    isSuspended: isSuspendedCache,
    errorMessage: errorMessageCache,
    updatedAt: new Date(),
  };

  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await SystemControl.findOneAndUpdate(
        { key: 'SYSTEM_STATUS' },
        {
          isSuspended: isSuspendedCache,
          errorMessage: errorMessageCache,
          updatedBy: updatedBy || null,
          updatedAt: new Date(),
        },
        { upsert: true, new: true }
      );
      if (doc) {
        result.isSuspended = doc.isSuspended;
        result.errorMessage = doc.errorMessage;
        result.updatedAt = doc.updatedAt;
      }
    } catch (dbError) {
      console.error('[SystemControl] DB persistence error:', dbError.message);
    }
  }

  return result;
};
