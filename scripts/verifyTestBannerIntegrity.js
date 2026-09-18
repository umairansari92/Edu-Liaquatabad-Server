import { execSync } from 'child_process';

const testFiles = [
  'tests/auth_suite.test.js',
  'tests/argon2_migration_suite.test.js',
  'tests/refresh_token_rotation_suite.test.js',
  'tests/root_admin_mfa_suite.test.js',
  'tests/authority_model_suite.test.js',
  'tests/auth_hierarchy_suite.test.js',
  'tests/security_suite.test.js',
  'tests/security_remediation_wave1.test.js',
  'tests/root_admin_module_suite.test.js',
  'tests/authority_negative_security_suite.test.js',
  'tests/authority_transition_matrix.test.js',
  'tests/teacher_attendance_security.test.js',
  'tests/seed_data_validation.test.js',
  'tests/staff_profile_and_approval_workflow.test.js',
  'tests/staff_profile_controller_integration.test.js',
  'tests/attendance_analytics_suite.test.js',
  'tests/town_holiday_and_timing_policy.test.js',
  'tests/announcement_and_public_stats.test.js',
  'tests/student_onboarding_flows.test.js',
  'tests/privacy_and_notifications.test.js',
  'tests/security_and_regression_verification.test.js',
  'tests/root_admin_privacy_and_dashboard_authority.test.js',
  'tests/hm_operational_authority_and_security.test.js',
  'tests/security_remediation_wave2_core.test.js'
];

console.log('Running test integrity verification across all 24 test suites...\n');

let totalBannerPassed = 0;
let totalBannerTotal = 0;
let totalPassLines = 0;
const fileResults = [];

for (const file of testFiles) {
  try {
    const output = execSync(`node ${file}`, {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Count individual PASS lines
    const passLines = (output.match(/✅\s*PASS/gi) || []).length;
    totalPassLines += passLines;

    // Search for closing banner patterns like "ALL X/Y ... PASSED" or "[X/Y] ... PASSED"
    let bannerMatch = output.match(/ALL\s+(\d+)\/(\d+)/i) ||
                      output.match(/PASSED:\s*(\d+)\/(\d+)/i) ||
                      output.match(/(\d+)\/(\d+)\s+TESTS?\s+PASSED/i) ||
                      output.match(/\[(\d+)\/(\d+)\]/i);

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
    console.log(`✓ ${file.padEnd(55)} Banner: ${passed}/${total} (Pass lines: ${passLines})`);
  } catch (err) {
    console.error(`✗ FAILED: ${file}`);
    console.error(err.stderr || err.stdout || err.message);
    process.exit(1);
  }
}

console.log('\n' + '='.repeat(70));
console.log(`TOTAL BANNER SUM: ${totalBannerPassed} / ${totalBannerTotal}`);
console.log(`TOTAL PASS LINES: ${totalPassLines}`);
console.log('='.repeat(70));
