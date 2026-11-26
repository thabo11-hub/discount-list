import { rpc } from '../lib/db.js';
import { route, send } from '../lib/http.js';
import { logEvent } from '../lib/log.js';

// Public health check. Says only whether the app works; details go to the server logs.
export default route(['GET'], async (ctx) => {
  try {
    const r = await rpc('dl_health', {});
    send(ctx.res, 200, { ok: !!r?.ok });
  } catch (err) {
    logEvent('error', 'health_failed', { reqId: ctx.reqId, message: String(err?.message || err), code: err?.code });
    send(ctx.res, 503, { ok: false, ref: ctx.reqId });
  }
});
