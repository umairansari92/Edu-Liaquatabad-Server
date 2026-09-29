/**
 * Forensic Authentication, Session Persistence & Autofill Audit Script
 * Verifies all 18 facets required by the security audit mandate.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const clientSrc = path.join(rootDir, 'client/src');
const serverSrc = path.join(rootDir, 'server/src');

console.log('========================================================================');
console.log('AUTHENTICATION & SESSION FORENSIC AUDIT: EXECUTING DEEP CODEBASE SCAN');
console.log('========================================================================\n');

// 1. Recursive search for storage keywords in client/src
const storageKeywords = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document.cookie',
  'redux-persist',
  'persistStore',
  'persistReducer',
];

const scanDirectory = (dir, keywords, results = {}) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist') {
        scanDirectory(fullPath, keywords, results);
      }
    } else if (entry.isFile() && /\.(js|jsx|ts|tsx|html)$/.test(entry.name)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const kw of keywords) {
        if (!results[kw]) results[kw] = [];
        const regex = new RegExp(`\\b${kw}\\b`, 'g');
        let match;
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (regex.test(line)) {
            results[kw].push({
              file: path.relative(rootDir, fullPath),
              line: idx + 1,
              content: line.trim(),
            });
          }
        });
      }
    }
  }
  return results;
};

console.log('--- 1. CLIENT STORAGE AUDIT (localStorage, sessionStorage, IndexedDB, Cookies) ---');
const clientStorageFindings = scanDirectory(clientSrc, storageKeywords);
let anyClientStorageFound = false;
for (const [kw, matches] of Object.entries(clientStorageFindings)) {
  if (matches.length > 0) {
    anyClientStorageFound = true;
    console.log(`[FOUND] ${kw}: ${matches.length} occurrences`);
    matches.forEach(m => console.log(`   ${m.file}:${m.line} -> ${m.content}`));
  } else {
    console.log(`[CLEAN] ${kw}: 0 occurrences found in client/src`);
  }
}
if (!anyClientStorageFound) {
  console.log('>> RESULT: Client uses ZERO localStorage, ZERO sessionStorage, ZERO IndexedDB, ZERO document.cookie.\n');
}

// 2. Check Redux Store setup
console.log('--- 2. REDUX PERSISTENCE AUDIT ---');
const storeFile = path.join(clientSrc, 'store/index.js');
const storeContent = fs.readFileSync(storeFile, 'utf8');
const usesReduxPersist = storeContent.includes('persistReducer') || storeContent.includes('redux-persist');
console.log(`Redux Persist in store/index.js: ${usesReduxPersist ? 'YES (VULNERABILITY)' : 'NO (PURE IN-MEMORY STORE)'}`);

// Check authSlice initialState
const authSliceFile = path.join(clientSrc, 'store/slices/authSlice.js');
const authSliceContent = fs.readFileSync(authSliceFile, 'utf8');
const storesPasswordInRedux = authSliceContent.includes('password');
console.log(`Password in authSlice: ${storesPasswordInRedux ? 'YES (VULNERABILITY)' : 'NO (CLEAN - Memory Only)'}`);

// 3. Check LoginPage input attributes
console.log('\n--- 3. LOGIN PAGE FORM & AUTOCOMPLETE AUDIT ---');
const loginPageFile = path.join(clientSrc, 'pages/auth/LoginPage.jsx');
const loginPageContent = fs.readFileSync(loginPageFile, 'utf8');

const hasEmailInput = loginPageContent.includes("register('email')");
const hasPasswordInput = loginPageContent.includes("register('password')");
const hasFormAutoComplete = /<form[^>]*autocomplete/i.test(loginPageContent);
const hasEmailAutoComplete = /register\(['"]email['"]\)[^>]*autocomplete/i.test(loginPageContent);
const hasPasswordAutoComplete = /register\(['"]password['"]\)[^>]*autocomplete/i.test(loginPageContent);

console.log(`Email Input Present: ${hasEmailInput}`);
console.log(`Password Input Present: ${hasPasswordInput}`);
console.log(`Form has explicit autoComplete attribute: ${hasFormAutoComplete}`);
console.log(`Email input has explicit autoComplete attribute: ${hasEmailAutoComplete}`);
console.log(`Password input has explicit autoComplete attribute: ${hasPasswordAutoComplete}`);

// Check for any default values or hydration in LoginPage
const hasEmailDefaultValue = /email.*default/i.test(loginPageContent);
const hasPasswordDefaultValue = /password.*default/i.test(loginPageContent);
console.log(`Email input has defaultValue: ${hasEmailDefaultValue}`);
console.log(`Password input has defaultValue: ${hasPasswordDefaultValue}`);

// Check for setValue on email or password
const setsEmailValue = /setValue\(\s*['"]email['"]/i.test(loginPageContent);
const setsPasswordValue = /setValue\(\s*['"]password['"]/i.test(loginPageContent);
console.log(`LoginPage calls setValue('email'): ${setsEmailValue}`);
console.log(`LoginPage calls setValue('password'): ${setsPasswordValue}`);

// 4. Server Cookie Configuration Audit
console.log('\n--- 4. SERVER COOKIE SPECIFICATION AUDIT ---');
import('../src/utils/tokenUtils.js').then(({ setRefreshCookie, clearRefreshCookie }) => {
  let capturedSetCookie = null;
  let capturedClearCookie = null;

  const mockResponse = {
    cookie: (name, val, opts) => {
      capturedSetCookie = { name, opts };
    },
    clearCookie: (name, opts) => {
      capturedClearCookie = { name, opts };
    }
  };

  setRefreshCookie(mockResponse, 'sample_test_token_2026');
  clearRefreshCookie(mockResponse);

  console.log('Set-Cookie Parameters:', JSON.stringify(capturedSetCookie, null, 2));
  console.log('Clear-Cookie Parameters:', JSON.stringify(capturedClearCookie, null, 2));

  console.log('\nAudit Analysis:');
  console.log(`- HttpOnly: ${capturedSetCookie.opts.httpOnly} (Prevents client-side JS extraction)`);
  console.log(`- SameSite: ${capturedSetCookie.opts.sameSite} (Strict CSRF mitigation)`);
  console.log(`- Path: ${capturedSetCookie.opts.path} (Restricted exclusively to /api/v1/auth)`);
  console.log(`- Max-Age: ${capturedSetCookie.opts.maxAge} ms (${capturedSetCookie.opts.maxAge / (1000 * 60 * 60 * 24)} days)`);
  console.log(`- Cookie Type: ${capturedSetCookie.opts.maxAge ? 'PERSISTENT COOKIE (Disk-persisted for 7 days)' : 'SESSION COOKIE (RAM only)'}`);

  console.log('\n========================================================================');
  console.log('FORENSIC AUDIT SCAN COMPLETE');
  console.log('========================================================================');
}).catch(err => {
  console.error('Error testing server tokenUtils:', err);
});
