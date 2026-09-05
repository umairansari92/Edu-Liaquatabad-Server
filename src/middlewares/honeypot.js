/**
 * Honeypot Bot Detection Middleware
 * Silent trap field — bots auto-fill hidden fields, humans don't.
 * Server rejects any request where the honeypot field is populated.
 */

export const honeypotCheck = (request, response, nextFunction) => {
  // The hidden honeypot field name ('_gotcha' is a common convention).
  // Frontend forms must include: <input type="hidden" name="_gotcha" value="" style="display:none" />
  const honeypotValue = request.body?._gotcha;

  if (honeypotValue !== undefined && honeypotValue !== '') {
    // Silent rejection — do not reveal why the request was dropped
    console.warn(`[Honeypot] Bot submission detected from IP: ${request.ip} | UA: ${request.headers['user-agent']}`);
    // Return a fake 200 OK to confuse the bot — do not reveal detection
    return response.status(200).json({
      success: true,
      message: 'Registration received. Please wait for verification.',
    });
  }

  nextFunction();
};
