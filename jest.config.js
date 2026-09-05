/**
 * Jest configuration for ESM (ES Modules) support.
 * The server uses "type": "module" in package.json,
 * requiring the experimental-vm-modules Node flag.
 */
export default {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 15000,
};
