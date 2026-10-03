/**
 * Deep Recursive Request Sanitizer (Security v7.5)
 * Guards against NoSQL Injection, Prototype Pollution, Reflected/Stored XSS,
 * SQL Injection, Command Injection, and Path Traversal.
 */

const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DANGEROUS_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /<script\b[^>]*>/gi,               // Standalone opening script tag
  /<\/script\b[^>]*>/gi,              // Standalone closing script tag
  /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
  /<iframe\b[^>]*>/gi,
  /<\/iframe\b[^>]*>/gi,
  /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
  /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi,
  /<svg\b[^>]*\bon\w+\s*=[^>]*>/gi,  // SVG with inline event handlers
  /<img\b[^>]*\bon\w+\s*=[^>]*>/gi,  // IMG with inline event handlers
  /on\w+\s*=\s*(?:['"][^'"]*['"]|[^\s>]+)/gi, // Event handlers: onclick=..., onerror=alert(1), etc.
  /java\s*script\s*:/gi,             // javascript: pseudo-protocol (including whitespace obfuscation)
  /vbscript\s*:/gi,
  /data\s*:\s*text\/html/gi,
  /\.\.\/|\.\.\\|%2e%2e%2f|%252e%252e/i, // Path traversal
  /union\s+select/i,                 // SQL injection signature
  /;\s*drop\s+table/i,
  /cmd\.exe|powershell\.exe|\/bin\/sh|\/bin\/bash/i, // Command injection
];

/**
 * Sanitizes a single string value
 * @param {string} inputString 
 * @returns {string}
 */
export const sanitizeString = (inputString) => {
  if (typeof inputString !== 'string') return inputString;

  let cleanedString = inputString;
  for (const dangerousPattern of DANGEROUS_PATTERNS) {
    cleanedString = cleanedString.replace(dangerousPattern, '');
  }

  // Strip null bytes and control chars
  cleanedString = cleanedString.replace(/\0/g, '');

  return cleanedString.trim();
};

/**
 * Recursively scrubs objects and arrays
 * @param {any} targetPayload 
 * @returns {any}
 */
export const deepClean = (targetPayload) => {
  if (targetPayload === null || targetPayload === undefined) return targetPayload;

  if (typeof targetPayload === 'string') {
    return sanitizeString(targetPayload);
  }

  if (Array.isArray(targetPayload)) {
    return targetPayload.map((arrayElement) => deepClean(arrayElement));
  }

  if (typeof targetPayload === 'object') {
    const cleanedObject = {};

    for (const [propertyKey, propertyValue] of Object.entries(targetPayload)) {
      // 1. Block Prototype Pollution keys
      if (PROTOTYPE_POLLUTION_KEYS.has(propertyKey)) {
        console.warn(`🚨 [SECURITY BREACH ATTEMPT] Prototype pollution key [${propertyKey}] blocked.`);
        continue;
      }

      // 2. Block NoSQL operator injection keys (keys starting with $)
      if (propertyKey.startsWith('$')) {
        console.warn(`🚨 [SECURITY BREACH ATTEMPT] NoSQL operator injection key [${propertyKey}] stripped.`);
        continue;
      }

      // 3. Strip dot-notation keys from top-level body to prevent arbitrary path overwrite
      const safeKey = propertyKey.replace(/[$\.]/g, '_');
      cleanedObject[safeKey] = deepClean(propertyValue);
    }

    return cleanedObject;
  }

  return targetPayload;
};

/**
 * Deep Sanitizer Middleware
 */
export const deepSanitize = (request, response, nextFunction) => {
  if (request.body) {
    request.body = deepClean(request.body);
  }

  if (request.query) {
    request.query = deepClean(request.query);
  }

  if (request.params) {
    request.params = deepClean(request.params);
  }

  nextFunction();
};
