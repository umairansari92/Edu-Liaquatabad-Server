import express from 'express';
import { sendSuccess } from '../utils/apiResponse.js';

const router = express.Router();

router.get('/', (request, response) => {
  return sendSuccess(response, 200, 'Education Department Liaquatabad Town Centre (DMC) API Gateway is active.', {
    service: 'Liaquatabad DMC School Management API & BFF Gateway',
    status: 'ONLINE',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

export default router;
