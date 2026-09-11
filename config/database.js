import mongoose from 'mongoose';
import { initSystemControl } from '../src/services/systemControlService.js';

let isConnecting = false;

// Register lifecycle listeners once
mongoose.connection.on('connected', () => {
  console.log(`[MongoDB] 🟢 Connected to cluster: ${mongoose.connection.host}`);
});

mongoose.connection.on('error', (err) => {
  console.error(`[MongoDB] 🔴 Connection error: ${err.message}`);
});

mongoose.connection.on('disconnected', () => {
  console.warn('[MongoDB] 🟡 Disconnected from database. Attempting auto-reconnect...');
  if (!isConnecting && process.env.NODE_ENV !== 'production') {
    setTimeout(connectDatabase, 5000);
  }
});

export const connectDatabase = async () => {
  if (mongoose.connection.readyState === 1) return;
  if (isConnecting) return;

  isConnecting = true;
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/liaquatabad_education_db';

  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 20,
    });
    console.log(`[MongoDB] Connected successfully to host: ${conn.connection.host}`);
    await initSystemControl();
  } catch (error) {
    console.error(`[MongoDB] Connection error: ${error.message}`);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    } else {
      // In development, retry connection after 5 seconds
      console.log('[MongoDB] Will retry connection in 5 seconds...');
      setTimeout(() => {
        isConnecting = false;
        connectDatabase();
      }, 5000);
    }
  } finally {
    isConnecting = false;
  }
};

