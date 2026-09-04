/**
 * Deep Recursive Request Sanitizer (Security v7.5)
 * Guards against NoSQL Injection, Prototype Pollution, Reflected/Stored XSS,
 * SQL Injection, Command Injection, and Path Traversal.
 */

const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DANGEROUS_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
  /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
  /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi,
  /on\w+\s*=\s*(['"]).*?\1/gi,       // e.g. onload=, onclick=, onerror=
  /javascript\s*:/gi,                // javascript: pseudo-protocol
  /vbscript\s*:/gi,
  /data\s*:\s*text\/html/gi,
  /\.\.\/|\.\.\\|%2e%2e%2f|%252e%252e/i, // Path traversal
  /union\s+select/i,                 // SQL injection signature
  /;\s*drop\s+table/i,
  /cmd\.exe|powershell\.exe|\/bin\/sh|\/bin\/bash/i, // Command injection
];

/**
 * Sanitizes a single string value
 * @param {string} val 
 * @returns {string}
 */
const sanitizeString = (val) => {
  if (typeof val !== 'string') return val;

  let cleaned = val;
  for (const pattern of DANGEROUS_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Strip null bytes and control chars
  cleaned = cleaned.replace(/\0/g, '');

  return cleaned.trim();
};

/**
 * Recursively scrubs objects and arrays
 * @param {any} target 
 * @returns {any}
 */
const deepClean = (target) => {
  if (target === null || target === undefined) return target;

  if (typeof target === 'string') {
    return sanitizeString(target);
  }

  if (Array.isArray(target)) {
    return target.map((item) => deepClean(item));
  }

  if (typeof target === 'object') {
    const cleanedObj = {};

    for (const [key, value] of Object.entries(target)) {
      // 1. Block Prototype Pollution keys
      if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
        console.warn(`🚨 [SECURITY BREACH ATTEMPT] Prototype pollution key [${key}] blocked.`);
        continue;
      }

      // 2. Block NoSQL operator injection keys (keys starting with $)
      if (key.startsWith('$')) {
        console.warn(`🚨 [SECURITY BREACH ATTEMPT] NoSQL operator injection key [${key}] stripped.`);
        continue;
      }

      // 3. Strip dot-notation keys from top-level body to prevent arbitrary path overwrite
      const safeKey = key.replace(/[$\.]/g, '_');
      cleanedObj[safeKey] = deepClean(value);
    }

    return cleanedObj;
  }

  return target;
};

/**
 * Deep Sanitizer Middleware
 */
export const deepSanitize = (req, res, next) => {
  if (req.body) {
    req.body = deepClean(req.body);
  }

  if (req.query) {
    req.query = deepClean(req.query);
  }

  if (req.params) {
    req.params = deepClean(req.params);
  }

  next();
};
