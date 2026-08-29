import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const port = parseInt(process.env.SMTP_PORT || '465', 10);

export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: port,
  secure: process.env.SMTP_SECURE === 'true' || port === 465, // true for 465, false for 587
  auth: {
    user: process.env.SMTP_USER || 'liaquatabadeducation@gmail.com',
    pass: process.env.SMTP_PASS?.replace(/\s+/g, '') || '', // strip any spaces in app password
  },
});

export default transporter;
