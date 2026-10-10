import express from 'express';
import mongoose from 'mongoose';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { verifyAccessToken } from '../utils/tokenUtils.js';
import { ROLES } from '../../config/constants.js';

const router = express.Router();

router.get('/', (request, response) => {
  let actorRole = null;
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = verifyAccessToken(authHeader.split(' ')[1]);
      actorRole = decoded.role;
    } catch {
      // Invalid token, treat as unauthenticated
    }
  }

  const isPrivilegedAdmin = [ROLES.ROOT_ADMIN, ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(actorRole);

  // If caller specifically requests privileged telemetry but is not an authorized administrator
  if (request.query?.telemetry === 'true' && !isPrivilegedAdmin) {
    return sendError(response, 403, 'Access denied. Infrastructure telemetry is restricted to municipal administrators.');
  }

  // Base public / non-admin gateway health (Zero Infrastructure PII/Vitals)
  const baseHealthData = {
    service: 'Liaquatabad DMC School Management API & BFF Gateway',
    status: 'ONLINE',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  };

  if (!isPrivilegedAdmin) {
    return sendSuccess(response, 200, 'Education Department Liaquatabad Town Centre (DMC) API Gateway is active.', baseHealthData);
  }

  // Privileged Administrators Telemetry projection
  const memory = process.memoryUsage();
  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  const formattedUptime = `${hours}h ${minutes}m ${seconds}s`;

  const dbStateMap = {
    0: 'DISCONNECTED',
    1: 'CONNECTED',
    2: 'CONNECTING',
    3: 'DISCONNECTING',
  };

  return sendSuccess(response, 200, 'Education Department Liaquatabad Town Centre (DMC) Infrastructure Telemetry retrieved.', {
    ...baseHealthData,
    environment: process.env.NODE_ENV || 'development',
    uptime: uptimeSeconds,
    uptimeFormatted: formattedUptime,
    memory: {
      heapUsedMB: +(memory.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: +(memory.heapTotal / 1024 / 1024).toFixed(2),
      rssMB: +(memory.rss / 1024 / 1024).toFixed(2),
    },
    cpu: process.cpuUsage(),
    database: {
      status: dbStateMap[mongoose.connection.readyState] || 'UNKNOWN',
      name: mongoose.connection.name || 'default',
    },
    nodeVersion: process.version,
    platform: process.platform,
  });
});

export default router;
