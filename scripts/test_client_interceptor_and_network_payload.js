import axios from '../../client/node_modules/axios/index.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../src/models/User.js';
import { decryptMfaSecret, generateTotpToken } from '../src/utils/mfaUtils.js';
import { signMfaPendingToken, signAccessToken } from '../src/utils/tokenUtils.js';

dotenv.config();

const uri = process.env.MONGODB_URI;
const BASE_URL = 'http://localhost:5000/api/v1';

async function testClientInterceptorAndNetworkPayload() {
  console.log('================================================================');
  console.log('🌐 SIMULATING EXACT CLIENT AXIOS INTERCEPTOR & NETWORK PAYLOAD');
  console.log('================================================================\n');

  await mongoose.connect(uri);
  const User = mongoose.model('User');
  const user = await User.findOne({ email: 'liaquatabadeducation@gmail.com' }).select(
    '+mfa.secretCiphertext +mfa.secretIv +mfa.secretTag +mfa.lastConsumedWindow +tokenVersion'
  );

  const totpSecret = decryptMfaSecret({
    ciphertext: user.mfa.secretCiphertext,
    iv: user.mfa.secretIv,
    tag: user.mfa.secretTag,
  });

  // 1. Simulate Redux store containing an old, expired or stale accessToken from last night
  const mockReduxState = {
    auth: {
      user: { _id: user._id, role: user.role },
      accessToken: 'MOCK_STALE_ACCESS_TOKEN_FROM_LAST_NIGHT_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    },
  };

  // 2. Setup apiClient instance identical to client/src/services/apiClient.js
  const apiClient = axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json' },
  });

  // Attach our updated request interceptor (from client/src/services/apiClient.js)
  apiClient.interceptors.request.use((requestConfig) => {
    const requestUrlString = requestConfig?.url || '';
    const isAuthHandshakeEndpoint =
      requestUrlString.includes('/auth/login') ||
      requestUrlString.includes('/auth/refresh-token') ||
      requestUrlString.includes('/auth/logout') ||
      requestUrlString.includes('/auth/mfa/verify-login') ||
      requestUrlString.includes('/auth/mfa/recovery-login') ||
      requestUrlString.includes('/auth/mfa/setup') ||
      requestUrlString.includes('/auth/mfa/confirm') ||
      requestUrlString.includes('/auth/captcha') ||
      requestUrlString.includes('/auth/register') ||
      requestUrlString.includes('/auth/forgot-password') ||
      requestUrlString.includes('/auth/reset-password');

    // Interceptor rule: Do NOT inject stale session access tokens into auth/MFA endpoints,
    // and never overwrite an explicit Authorization header already supplied by caller
    if (!isAuthHandshakeEndpoint && !requestConfig.headers?.Authorization) {
      const activeAccessToken = mockReduxState.auth?.accessToken;
      if (activeAccessToken) {
        requestConfig.headers.Authorization = `Bearer ${activeAccessToken}`;
      }
    }
    return requestConfig;
  });

  // Record outgoing network request details
  let capturedOutgoingRequest = null;
  apiClient.interceptors.request.use((config) => {
    capturedOutgoingRequest = {
      url: `${config.baseURL}${config.url}`,
      method: config.method?.toUpperCase(),
      headers: { ...config.headers },
      data: config.data,
    };
    return config;
  });

  // 3. Setup authService.mfaVerifyLogin identical to client/src/services/authService.js
  const authService = {
    mfaVerifyLogin: async ({ totpCode, mfaPendingToken }) => {
      const response = await apiClient.post(
        '/auth/mfa/verify-login',
        {
          totpCode,
          mfaPendingToken,
        },
        {
          headers: mfaPendingToken ? { Authorization: `Bearer ${mfaPendingToken}` } : {},
        }
      );
      return response.data;
    },
  };

  // 4. Generate fresh MFA Pending Token (Step 1 output)
  const freshMfaPendingToken = signMfaPendingToken({
    userId: user._id.toString(),
    tokenVersion: user.tokenVersion,
  });

  // Generate fresh TOTP code
  const freshTotpCode = generateTotpToken(totpSecret, 1);

  console.log('--- EXECUTING CLIENT SERVICE: authService.mfaVerifyLogin ---');
  let responseData = null;
  let responseStatus = null;
  let responseError = null;

  try {
    const res = await authService.mfaVerifyLogin({
      totpCode: freshTotpCode,
      mfaPendingToken: freshMfaPendingToken,
    });
    responseData = res;
    responseStatus = 200;
  } catch (err) {
    responseError = err.response?.data || err.message;
    responseStatus = err.response?.status || 500;
  }

  console.log('\n================================================================');
  console.log('📡 INSPECTION OF ACTUAL OUTGOING NETWORK REQUEST');
  console.log('================================================================');
  console.log('Request URL:              ', capturedOutgoingRequest?.url);
  console.log('HTTP Method:              ', capturedOutgoingRequest?.method);
  console.log('Authorization Header:     ', capturedOutgoingRequest?.headers?.Authorization?.slice(0, 35) + '... (truncated)');
  console.log('Is Stale Token Blocked:   ', !capturedOutgoingRequest?.headers?.Authorization?.includes('MOCK_STALE_ACCESS_TOKEN'));
  console.log('Is mfaPendingToken Header:', capturedOutgoingRequest?.headers?.Authorization?.includes('Bearer ' + freshMfaPendingToken));
  console.log('mfaPendingToken in Body:  ', !!capturedOutgoingRequest?.data?.mfaPendingToken);
  console.log('totpCode in Body:         ', capturedOutgoingRequest?.data?.totpCode);
  console.log('----------------------------------------------------------------');
  console.log('Response HTTP Status:     ', responseStatus);
  console.log('Response Success:         ', responseData?.success);
  console.log('Response Message:         ', responseData?.message || responseError?.message);
  console.log('mfaVerified Claim:        ', responseData?.data?.user?.mfaVerified);
  console.log('AccessToken Issued:       ', !!responseData?.data?.accessToken);
  console.log('================================================================\n');

  if (responseStatus === 200 && responseData?.success) {
    console.log('✅ VERIFICATION PASSED: The request carried the correct MFA ticket without stale access-token pollution and succeeded with HTTP 200!');
  } else {
    console.log('❌ VERIFICATION FAILED: Unexpected response:', responseError);
  }

  await mongoose.disconnect();
}

testClientInterceptorAndNetworkPayload().catch(console.error);
