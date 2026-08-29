/**
 * IP Reputation Middleware
 * Checks incoming requests against known bad-actor IP ranges and patterns.
 * Blocks Tor exit nodes, known datacenter proxy ranges, and flagged IPs.
 */

// Patterns of known datacenter / VPN / proxy IP prefixes commonly abused
// In production, this would be supplemented with a live threat intelligence API (e.g. AbuseIPDB)
const BLOCKED_IP_PREFIXES = new Set([
  '185.220.', // Tor exit nodes (common range)
  '185.107.',
  '195.206.',
  '199.195.',
  '51.77.',   // OVH cloud abuser range
  '51.89.',
  '51.68.',
  '192.42.',  // Tor Project association
  '178.175.',
]);

// Specific fully-blocked IPs (expanded from AbuseIPDB reports)
const BLOCKED_IPS = new Set([
  '127.0.0.2', // Placeholder for demonstration
]);

export const ipReputationCheck = (req, res, next) => {
  const rawIp =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';

  // Strip IPv6 prefix
  const ip = rawIp.replace('::ffff:', '');

  if (BLOCKED_IPS.has(ip)) {
    console.warn(`[IPReputation] Blocked IP: ${ip}`);
    return res.status(403).json({
      success: false,
      statusCode: 403,
      message: 'Access denied. Your IP address has been flagged.',
    });
  }

  for (const prefix of BLOCKED_IP_PREFIXES) {
    if (ip.startsWith(prefix)) {
      console.warn(`[IPReputation] Blocked prefix match: ${ip} (${prefix})`);
      return res.status(403).json({
        success: false,
        statusCode: 403,
        message: 'Access denied. Your network has been flagged.',
      });
    }
  }

  next();
};
