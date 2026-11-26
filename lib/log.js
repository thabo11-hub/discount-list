// Logging and monitoring. Structured JSON lines go to the Vercel runtime logs; security events
// are also written to the audit log table, which the admin page summarises with alerts.
// Never log passwords, tokens, cookies, keys or full emails.
import { rpc } from './db.js';

const REDACT = /pass(word)?|token|secret|key|cookie|authorization|csrf/i;

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = REDACT.test(k) && k !== 'stack' ? '[redacted]' : v;
  return out;
}

export function logEvent(level, event, fields = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...clean(fields) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export async function audit(ctx, event, severity = 'info', detail = {}, userId = null) {
  const safeDetail = clean(detail);
  logEvent(severity === 'info' ? 'info' : 'warn', event, { reqId: ctx?.reqId, userId, ...safeDetail });
  try {
    await rpc('dl_audit', {
      p_event: event,
      p_severity: severity,
      p_user_id: userId,
      p_ip_hash: ctx?.ipHash || null,
      p_detail: safeDetail,
    });
  } catch (err) {
    logEvent('error', 'audit_write_failed', { event, message: String(err?.message || err) });
  }
}
