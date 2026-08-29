import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import nodemailer from 'nodemailer';

async function testAll() {
  console.log('--- 🔍 Testing Credentials ---');

  // 1. MongoDB Atlas
  console.log('[1/3] Testing MongoDB Atlas...');
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 6000,
    });
    console.log(`✅ [MongoDB Atlas] Connected successfully! Host: ${conn.connection.host}`);
    await mongoose.disconnect();
  } catch (err) {
    console.error(`❌ [MongoDB Atlas] Error: ${err.message}`);
  }

  // 2. Cloudinary
  console.log('\n[2/3] Testing Cloudinary CDN...');
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  try {
    const ping = await cloudinary.api.ping();
    console.log(`✅ [Cloudinary] Connected successfully! Status: ${ping.status}`);
  } catch (err) {
    console.error(`❌ [Cloudinary] Error: ${err.message}`);
  }

  // 3. Gmail SMTP
  console.log('\n[3/3] Testing Google Gmail SMTP...');
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '465', 10),
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS.replace(/\s+/g, ''),
      },
    });
    await transporter.verify();
    console.log('✅ [Gmail SMTP] Authentication verified successfully! Ready to dispatch emails.');
  } catch (err) {
    console.error(`❌ [Gmail SMTP] Error: ${err.message}`);
  }

  console.log('\n--- 🎉 All Tests Complete ---');
  process.exit(0);
}

testAll();
