import mongoose from 'mongoose';
import { initSystemControl } from '../src/services/systemControlService.js';

export const connectDatabase = async () => {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/liaquatabad_education_db';
  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`[MongoDB] Connected successfully to host: ${conn.connection.host}`);
    await initSystemControl();
  } catch (error) {
    console.error(`[MongoDB] Connection error: ${error.message}`);
    // In local dev without active mongo service, keep server running gracefully
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
};
