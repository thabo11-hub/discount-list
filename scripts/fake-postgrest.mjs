// Test-only stand-in for the Supabase Data API: POST /rest/v1/rpc/<fn> runs public.<fn> as the
// anon role in the local test database and answers with PostgREST-style JSON and status codes.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.FAKE_PGRST_PORT || 54330);
const APIKEY = process.env.FAKE_PGRST_APIKEY || 'sb_publishable_localtestkey000000';
const SOCK = process.env.PGSOCK_DIR || '/tmp/ts-pgsock';
const PGPORT = process.env.PGPORT || '54329';
const DB = process.env.TEST_DB || 'trolleyscout_test';

const STATUS = { '42501': 403, '23505': 409, '23503': 409, PT404: 404, '57014': 504 };

function runRpc(fn, args) {
  let tag = 'a';
  const json = JSON.stringify(args);
  while (json.includes(`$${tag}$`)) tag = `a${crypto.randomBytes(4).toString('hex')}`;
  const sql = `set role anon;\nselect test.rpc('${fn}', $${tag}$${json}$${tag}$::jsonb);\n`;
  return new Promise((resolve) => {
    const p = spawn('psql', ['-h', SOCK, '-p', PGPORT, '-U', 'postgres', '-d', DB, '-X', '-q', '-A', '-t',
      '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-f', '-']);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out: out.trim(), err }));
    p.stdin.end(sql);
  });
}

http
  .createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url);
    if (req.method !== 'POST' || !m) return reply(404, { message: 'not found' });
    if (req.headers.apikey !== APIKEY) return reply(401, { message: 'Invalid API key' });
    let raw = '';
    for await (const c of req) raw += c;
    let args;
    try {
      args = JSON.parse(raw || '{}');
    } catch {
      return reply(400, { code: 'PGRST102', message: 'Empty or invalid json' });
    }
    const r = await runRpc(m[1], args);
    if (r.code !== 0) {
      const e = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(r.err) || [];
      return reply(STATUS[e[1]] || 400, { code: e[1] || 'XX000', message: e[2] || r.err.slice(0, 200) });
    }
    if (r.out === '') {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(r.out);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`fake Data API on http://127.0.0.1:${PORT}`));
