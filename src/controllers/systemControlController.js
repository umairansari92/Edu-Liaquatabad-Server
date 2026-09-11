import asyncHandler from 'express-async-handler';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { getSystemStatus, setSystemStatus } from '../services/systemControlService.js';
import AuditLog from '../models/AuditLog.js';

/**
 * GET /api/v1/system-control/status
 * Retrieve system operational status (ROOT_ADMIN only)
 */
export const handleGetSystemControlStatus = asyncHandler(async (request, response) => {
  const status = getSystemStatus();
  return sendSuccess(response, 200, 'System status retrieved.', status);
});

/**
 * POST /api/v1/system-control/toggle
 * Toggle system suspension / emergency outage mode (ROOT_ADMIN only)
 */
export const handleToggleSystemControl = asyncHandler(async (request, response) => {
  const { isSuspended, errorMessage } = request.body;

  if (typeof isSuspended !== 'boolean') {
    return sendError(response, 400, 'Parameter isSuspended must be a boolean.');
  }

  const updatedStatus = await setSystemStatus(
    isSuspended,
    errorMessage,
    request.user?._id || request.user?.userId
  );

  try {
    await AuditLog.create({
      actorId: request.user?._id || request.user?.userId,
      actorRole: request.user?.role,
      actorDesignation: request.user?.designation || '',
      actorName: request.user?.fullName || '',
      action: isSuspended ? 'EMERGENCY_KILLSWITCH_ACTIVATED' : 'EMERGENCY_KILLSWITCH_DEACTIVATED',
      result: 'SUCCESS',
      reason: isSuspended
        ? 'Emergency cluster outage simulation activated by ROOT_ADMIN'
        : 'System operations restored to normal by ROOT_ADMIN',
      requestMetadata: {
        ipAddress: request.ip || '',
        userAgent: request.headers['user-agent'] || '',
        method: request.method,
        url: request.originalUrl,
      },
      details: {
        isSuspended: updatedStatus.isSuspended,
        errorMessage: updatedStatus.errorMessage,
      },
    });
  } catch (auditError) {
    console.error('[SystemControl] Audit log write failed:', auditError.message);
  }

  return sendSuccess(
    response,
    200,
    isSuspended ? 'Emergency kill switch activated.' : 'System operations restored to normal.',
    updatedStatus
  );
});
