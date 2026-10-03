import crypto from 'crypto';
import mongoose from 'mongoose';
import IdempotencyRecord from '../models/IdempotencyRecord.js';
import AuditLog from '../models/AuditLog.js';

/**
 * Deterministically computes SHA-256 fingerprint of request payload
 * Sorts object keys recursively to ensure order-independent hashing
 * @param {Object} request
 * @returns {string} SHA-256 hex string
 */
export const computeRequestFingerprint = (request) => {
  const normalizeObject = (targetValue) => {
    if (targetValue === null || typeof targetValue !== 'object') {
      return targetValue;
    }
    if (Array.isArray(targetValue)) {
      return targetValue.map(normalizeObject);
    }
    const sortedKeys = Object.keys(targetValue).sort();
    const sortedObject = {};
    for (const key of sortedKeys) {
      sortedObject[key] = normalizeObject(targetValue[key]);
    }
    return sortedObject;
  };

  const payloadRepresentation = {
    body: normalizeObject(request.body || {}),
    files: [],
  };

  // If request contains file attachments, incorporate file metadata into the fingerprint
  const attachedFiles = [];
  if (request.file) attachedFiles.push(request.file);
  if (request.files) {
    if (Array.isArray(request.files)) attachedFiles.push(...request.files);
    else if (typeof request.files === 'object') attachedFiles.push(...Object.values(request.files).flat());
  }

  if (attachedFiles.length > 0) {
    payloadRepresentation.files = attachedFiles.map((fileItem) => ({
      name: fileItem.originalname || fileItem.filename || '',
      size: fileItem.size || fileItem.buffer?.length || 0,
      mimetype: fileItem.mimetype || '',
    }));
  }

  const canonicalString = JSON.stringify(payloadRepresentation);
  return crypto.createHash('sha256').update(canonicalString).digest('hex');
};

/**
 * Server-Side Idempotency Guard Middleware
 * Intercepts mutating requests providing an 'Idempotency-Key' header.
 * 
 * Invariants:
 * 1. Guarantees identical execution result for network retries with matching payload.
 * 2. Blocks key-reuse attacks with differing payloads with 409 Conflict and security audit.
 * 3. Prevents concurrent duplicate in-flight mutations.
 * 4. Transparently passes through requests without an Idempotency-Key.
 */
export const idempotencyGuard = async (request, response, nextFunction) => {
  const mutatingMethods = ['POST', 'PATCH', 'PUT', 'DELETE'];
  if (!mutatingMethods.includes(request.method?.toUpperCase())) {
    return nextFunction();
  }

  const rawKey = request.headers['idempotency-key'] || request.headers['x-idempotency-key'];
  if (!rawKey) {
    return nextFunction();
  }

  const idempotencyKey = String(rawKey).trim();

  // Validate key format: 8 to 128 characters, safe URL-compatible characters
  if (!/^[a-zA-Z0-9_\-:.]{8,128}$/.test(idempotencyKey)) {
    return response.status(400).json({
      success: false,
      statusCode: 400,
      errorCode: 'INVALID_IDEMPOTENCY_KEY',
      message: 'Invalid Idempotency-Key header format. Must be 8 to 128 characters (alphanumeric, dashes, colons, underscores).',
    });
  }

  const actorUserId = request.user?._id || request.user?.userId;
  if (!actorUserId) {
    // Unauthenticated request cannot enforce per-user idempotency; pass through to auth middleware
    return nextFunction();
  }

  const currentFingerprint = computeRequestFingerprint(request);
  const endpointString = `${request.method} ${request.originalUrl || request.path}`;

  try {
    const existingRecord = await IdempotencyRecord.findOne({
      userId: actorUserId,
      idempotencyKey,
    });

    if (existingRecord) {
      // ─── CASE 1: Previously Completed (RESOLVED) ─────────────────────────
      if (existingRecord.status === 'RESOLVED') {
        // Verify Request Fingerprint Match
        if (existingRecord.requestFingerprint !== currentFingerprint) {
          // 🚨 IDEMPOTENCY KEY REUSE ATTACK / MISMATCHED PAYLOAD
          try {
            await AuditLog.create({
              actorId: actorUserId,
              actorRole: request.user?.role || 'UNKNOWN',
              actorName: request.user?.fullName || '',
              action: 'IDEMPOTENCY_KEY_REUSE',
              targetModel: 'IdempotencyRecord',
              targetId: existingRecord._id,
              targetName: endpointString,
              townId: mongoose.Types.ObjectId.isValid(request.user?.townId) ? request.user.townId : undefined,
              schoolId: mongoose.Types.ObjectId.isValid(request.user?.schoolId) ? request.user.schoolId : undefined,
              result: 'DENIED',
              reason: 'Idempotency key reuse attempted with differing request payload.',
              ipAddress: request.ip || '',
              userAgent: request.headers?.['user-agent'] || '',
              requestId: request.headers?.['x-request-id'] || '',
            });
          } catch (auditError) {
            console.error('[Idempotency] Failed to write security audit log:', auditError.message);
          }

          return response.status(409).json({
            success: false,
            statusCode: 409,
            errorCode: 'IDEMPOTENCY_KEY_REUSE',
            message: 'Idempotency key reuse detected with differing request payload. Mutation rejected.',
          });
        }

        // ✅ Legitimate Idempotent Replay: return cached status and response body
        response.setHeader('X-Idempotent-Replay', 'true');
        return response.status(existingRecord.responseStatusCode || 200).json(existingRecord.responseBody);
      }

      // ─── CASE 2: Currently In-Flight (PENDING) ───────────────────────────
      if (existingRecord.status === 'PENDING') {
        return response.status(409).json({
          success: false,
          statusCode: 409,
          errorCode: 'MUTATION_IN_FLIGHT',
          message: 'A mutation with this idempotency key is currently processing. Please wait for completion.',
          retryable: true,
        });
      }

      // ─── CASE 3: Previously Failed (FAILED) ──────────────────────────────
      // Allow retry by updating the record to PENDING
      existingRecord.status = 'PENDING';
      existingRecord.requestFingerprint = currentFingerprint;
      existingRecord.endpoint = endpointString;
      existingRecord.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await existingRecord.save();

      hookResponseInterceptor(response, existingRecord);
      return nextFunction();
    }

    // ─── CASE 4: New Key ──────────────────────────────────────────────────
    const newRecord = await IdempotencyRecord.create({
      userId: actorUserId,
      idempotencyKey,
      endpoint: endpointString,
      requestFingerprint: currentFingerprint,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    hookResponseInterceptor(response, newRecord);
    return nextFunction();
  } catch (dbError) {
    // If a duplicate key error occurs due to concurrent race condition (code 11000)
    if (dbError.code === 11000) {
      return response.status(409).json({
        success: false,
        statusCode: 409,
        errorCode: 'MUTATION_IN_FLIGHT',
        message: 'Concurrent mutation detected with identical idempotency key.',
        retryable: true,
      });
    }

    // Database error during idempotency check should not crash the request; log and proceed
    console.error('[Idempotency] Internal database check error:', dbError.message);
    return nextFunction();
  }
};

/**
 * Intercepts response.json to record the final execution outcome
 * @param {Object} response
 * @param {Object} idempotencyRecord
 */
const hookResponseInterceptor = (response, idempotencyRecord) => {
  const originalJson = response.json.bind(response);

  response.json = function (responseBody) {
    const statusCode = response.statusCode;

    // Cache responses for client results (2xx, 4xx). For 5xx server crashes, mark FAILED so client can retry.
    const isPermanentResult = statusCode >= 200 && statusCode < 500;
    const finalStatus = isPermanentResult ? 'RESOLVED' : 'FAILED';

    IdempotencyRecord.findByIdAndUpdate(idempotencyRecord._id, {
      status: finalStatus,
      responseStatusCode: statusCode,
      responseBody: responseBody,
    }).catch((updateError) => {
      console.error('[Idempotency] Failed to update final response:', updateError.message);
    });

    return originalJson(responseBody);
  };
};

export default idempotencyGuard;
