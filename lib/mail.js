// Password reset email through Resend (https://resend.com). Plain text only, so nothing in the
// email can carry HTML or script. Without RESEND_API_KEY and MAIL_FROM, no email is sent.
import { logEvent } from './log.js';

export async function sendResetEmail(to, link) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from || !process.env.APP_ORIGIN) return { sent: false, reason: 'mail_not_configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'Reset your TrolleyScout password',
        text:
          `Someone asked to reset the password for this TrolleyScout account.\n\n` +
          `Choose a new password here:\n${link}\n\n` +
          `The link works once and expires in 30 minutes. If you didn't ask for this, ignore this email; ` +
          `your password stays the same.\n`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) logEvent('error', 'mail_failed', { status: res.status });
    return { sent: res.ok, reason: res.ok ? undefined : `mail_http_${res.status}` };
  } catch (err) {
    logEvent('error', 'mail_failed', { message: String(err?.message || err) });
    return { sent: false, reason: 'mail_error' };
  }
}
