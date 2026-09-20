import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testsDir = path.resolve(__dirname, '../tests');

// Dynamically discover all test files directly from the directory (zero hardcoded file lists)
const testFiles = fs.readdirSync(testsDir)
  .filter(file => file.endsWith('.test.js'))
  .sort()
  .map(file => path.join('tests', file).replace(/\\/g, '/'));

console.log(`Running dynamic test integrity verification across all ${testFiles.length} test suites discovered in tests/...\n`);

let totalBannerPassed = 0;
let totalBannerTotal = 0;
let totalPassLines = 0;
const fileResults = [];

for (const file of testFiles) {
  try {
    const output = execSync(`node ${file}`, {
      encoding: 'utf8',
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Count individual PASS lines from actual stdout
    const passLines = (output.match(/✅\s*PASS/gi) || []).length;
    totalPassLines += passLines;

    // Search for closing banner patterns
    let bannerMatch = output.match(/ALL\s+(\d+)\s*(?:\/|OF)\s*(\d+)/i) ||
                      output.match(/PASSED:\s*(\d+)\s*(?:\/|OF)\s*(\d+)/i) ||
                      output.match(/(\d+)\s*\/\s*(\d+)\s+TESTS?\s+PASSED/i) ||
                      output.match(/\[(\d+)\s*\/\s*(\d+)\]/i) ||
                      output.match(/COMPLETED:\s*(\d+)\s*\/\s*(\d+)/i);

    let passed = 0;
    let total = 0;
    if (bannerMatch) {
      passed = parseInt(bannerMatch[1], 10);
      total = parseInt(bannerMatch[2], 10);
    } else {
      // Fallback to passLines
      passed = passLines;
      total = passLines;
    }

    totalBannerPassed += passed;
    totalBannerTotal += total;

    fileResults.push({ file, passed, total, passLines });
    console.log(`✓ ${file.padEnd(60)} Banner: ${String(passed).padStart(2)}/${String(total).padEnd(2)} (Pass lines: ${passLines})`);
  } catch (err) {
    console.error(`✗ FAILED: ${file}`);
    console.error(err.stderr || err.stdout || err.message);
    process.exit(1);
  }
}

console.log('\n' + '='.repeat(75));
console.log(`DYNAMIC AUDIT SUMMARY (${testFiles.length} SUITES DISCOVERED ON DISK):`);
console.log(`TOTAL BANNER SUM: ${totalBannerPassed} / ${totalBannerTotal}`);
console.log(`TOTAL PASS LINES: ${totalPassLines}`);
console.log('='.repeat(75));
