import { rpc } from '../lib/db.js';
import { HttpError, query, route, send } from '../lib/http.js';
import { EXT, sniffImage } from '../lib/images.js';
import * as v from '../lib/validate.js';

// Public, read-only access to deal flyer images uploaded by an admin.
export default route(['GET'], async (ctx) => {
  const id = query(ctx.req).get('id');
  if (!id) {
    const items = await rpc('dl_upload_list', {});
    return send(ctx.res, 200, { items }, { 'Cache-Control': 'public, max-age=60, s-maxage=120' });
  }
  v.uuid(id);
  const file = await rpc('dl_upload_get', { p_id: id });
  if (!file) throw new HttpError(404, 'Image not found.', { code: 'not_found' });
  const bytes = Buffer.from(file.b64, 'base64');
  const mime = sniffImage(bytes);
  if (!mime || mime !== file.mime) throw new HttpError(404, 'Image not found.', { code: 'not_found' });
  const { res } = ctx;
  res.statusCode = 200;
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Content-Disposition', `inline; filename="flyer-${id.slice(0, 8)}.${EXT[mime]}"`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('ETag', `"${file.sha256.slice(0, 32)}"`);
  res.end(bytes);
});
