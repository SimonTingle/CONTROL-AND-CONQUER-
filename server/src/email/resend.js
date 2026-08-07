/**
 * Thin wrapper over Resend's HTTP API — no SDK dependency needed for one call.
 *
 * Deliberately never throws for a caller to forget to catch: a failed send
 * must not become a 500 that also reveals "we tried to email someone" to
 * whoever's watching the response. Callers get a boolean and log the detail
 * themselves via the logger they already have.
 */

import { config } from '../config.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {import('fastify').FastifyBaseLogger} [opts.log]
 * @returns {Promise<boolean>} true if Resend accepted the send request.
 */
export async function sendEmail({ to, subject, html, log = console }) {
  if (!config.resendApiKey) {
    log.warn?.('[email] RESEND_API_KEY not set — email not sent') ??
      log.warn('[email] RESEND_API_KEY not set — email not sent');
    return false;
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: config.emailFrom, to, subject, html }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error?.({ status: res.status, body }, '[email] Resend rejected the send') ??
        log.error('[email] Resend rejected the send', res.status, body);
      return false;
    }
    return true;
  } catch (err) {
    log.error?.({ err }, '[email] send failed') ?? log.error('[email] send failed', err);
    return false;
  }
}

export function passwordResetEmail(resetUrl) {
  return {
    subject: 'Reset your Procedural Terrain password',
    html: `
      <p>Someone (hopefully you) asked to reset the password on your Procedural Terrain account.</p>
      <p><a href="${resetUrl}">Click here to set a new password</a>. This link works once and expires in 30 minutes.</p>
      <p>If you didn't request this, you can safely ignore this email — your password hasn't changed.</p>
    `,
  };
}
