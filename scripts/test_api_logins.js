// using built-in global fetch

async function testApiLogin(email, password) {
  // 1. Get captcha
  const capRes = await fetch('http://localhost:5000/api/v1/auth/captcha');
  const capData = await capRes.json();
  const q = capData.data.question;
  const match = q.match(/(\d+)\s*([\+\-\*])\s*(\d+)/);
  let ans = 0;
  if (match) {
    const a = parseInt(match[1], 10);
    const op = match[2];
    const b = parseInt(match[3], 10);
    if (op === '+') ans = a + b;
    else if (op === '-') ans = a - b;
    else if (op === '*') ans = a * b;
  }

  // 2. Login
  const loginRes = await fetch('http://localhost:5000/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      captchaAnswer: String(ans),
      captchaChallengeToken: capData.data.challengeToken
    })
  });
  const json = await loginRes.json();
  console.log(`Login ${email}: status=${loginRes.status}, success=${json.success}, role=${json.data?.user?.role}, mfaRequired=${json.data?.mfaRequired || false}`);
  return { status: loginRes.status, data: json.data };
}

console.log('Testing logins:');
await testApiLogin('staff01.liaquatabad@dmc.gov.pk', 'Liaquatabad2026!');
await testApiLogin('staff16.liaquatabad@dmc.gov.pk', 'Liaquatabad2026!');
await testApiLogin('admin.liaquatabad@dmc.gov.pk', 'Liaquatabad2026!');
await testApiLogin('supervisor.liaquatabad@dmc.gov.pk', 'Liaquatabad2026!');
await testApiLogin('test.staff01@example.test', 'DevPassword2026!');
