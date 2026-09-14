import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, '../..');
const CLIENT_SRC = path.join(ROOT_DIR, 'client/src');
const SERVER_SRC = path.join(ROOT_DIR, 'server/src');

console.log('======================================================================');
console.log('🔍 STATIC SENSITIVE DATA & ARCHITECTURE SCAN');
console.log(`Scanning:\n - ${CLIENT_SRC}\n - ${SERVER_SRC}`);
console.log('======================================================================\n');

const findings = [];

const getAllFiles = (dir, extFilter = ['.js', '.jsx', '.ts', '.tsx']) => {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === 'node_modules' || file === 'dist' || file === '.git') continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getAllFiles(fullPath, extFilter));
    } else if (extFilter.includes(path.extname(file))) {
      results.push(fullPath);
    }
  }
  return results;
};

// 1. Scan client components for direct API calls
const clientFiles = getAllFiles(CLIENT_SRC);
const directApiViolationsInComponents = [];

const componentOrPagePattern = /client[\\/]src[\\/](components|pages)/;

for (const file of clientFiles) {
  const isComponent = componentOrPagePattern.test(file);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    // Check localStorage / sessionStorage with sensitive keys
    if (/(localStorage|sessionStorage)\.(setItem|getItem)/.test(line)) {
      if (/(cnic|bank|account|password|otp|token|secret|refresh)/i.test(line)) {
        findings.push({
          type: 'STORAGE_SENSITIVE_KEY',
          file: path.relative(ROOT_DIR, file),
          line: lineNum,
          content: line.trim(),
        });
      }
    }

    // Check console.log with sensitive variables
    if (/console\.(log|info|warn|debug)\(/.test(line)) {
      if (/(cnic|accountNumber|password|otp|token|secret|refreshToken)/i.test(line)) {
        findings.push({
          type: 'CONSOLE_LOG_SENSITIVE',
          file: path.relative(ROOT_DIR, file),
          line: lineNum,
          content: line.trim(),
        });
      }
    }
  });
}

// 2. Scan server files
const serverFiles = getAllFiles(SERVER_SRC);
for (const file of serverFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    // Check console.log with sensitive fields
    if (/console\.(log|info|warn|debug)\(/.test(line)) {
      if (/(cnic|bank|password|otp|refreshToken)/i.test(line) && !line.includes('mask') && !line.includes('sanitized')) {
        findings.push({
          type: 'SERVER_CONSOLE_SENSITIVE',
          file: path.relative(ROOT_DIR, file),
          line: lineNum,
          content: line.trim(),
        });
      }
    }
  });
}

console.log(`Scan completed. Total sensitive observations found: ${findings.length}`);
findings.forEach((f, i) => {
  console.log(`[${i + 1}] Type: ${f.type} | File: ${f.file}:${f.line}`);
  console.log(`    Snippet: ${f.content}`);
});

console.log('\n======================================================================');
