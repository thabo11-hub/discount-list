import { rpc } from '../lib/db.js';
import { HttpError, route, send } from '../lib/http.js';
import { audit, logEvent } from '../lib/log.js';
import { safeEqual } from '../lib/security.js';

// Daily housekeeping (Vercel Cron sends "Authorization: Bearer $CRON_SECRET").
// Also keeps the free Supabase project active so it isn't paused for inactivity.
export default route(['GET'], async (ctx) => {
  if (!safeEqual(ctx.req.headers.authorization, `Bearer ${process.env.CRON_SECRET}`)) {
    await audit(ctx, 'cron_forbidden', 'warn', {});
    throw new HttpError(401, 'Not allowed.', { code: 'unauthorized' });
  }
  const result = await rpc('dl_cleanup', {});
  result.price_reports = (await rpc('dl_reports_cleanup', {})).deleted;
  logEvent('info', 'cleanup', result);
  send(ctx.res, 200, { ok: true, removed: result });
});
