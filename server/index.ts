import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Rpc } from './rpc.js';
import { Mapping, approvalResult, historyMessages } from './mapping.js';

const root = path.resolve('.runtime/workspaces');
await mkdir(root, { recursive: true });
const registryFile = path.resolve('.runtime/threads.json');
type Meta = { cwd: string; review: boolean };
let registry: Record<string, Meta> = {};
try { registry = JSON.parse(await readFile(registryFile, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
const persist = () => writeFile(registryFile, JSON.stringify(registry, null, 2), { mode: 0o600 });
const rpc = new Rpc();
await rpc.ready;
const active = new Map<string, { mapping: Mapping; finish: () => void }>();
const loaded = new Set<string>();
const pending = new Map<string, { id: any; kind: string; params: any }>();
const known = (id: string) => { if (!registry[id]) throw Object.assign(new Error('Unknown web thread'), { status: 404 }); return registry[id]; };
function settle(threadId: string) {
  for (const [key, r] of pending) if (r.params.threadId === threadId) { rpc.reply(r.id, approvalResult(r.kind, r.params, 'deny')); pending.delete(key); }
}
rpc.on('message', x => {
  const p = x.params || {}, run = active.get(p.threadId);
  if (x.id !== undefined) {
    const match = /^item\/(commandExecution|fileChange|permissions)\/requestApproval$/.exec(x.method);
    if (match && run) {
      const requestId = randomUUID(); pending.set(requestId, { id: x.id, kind: match[1], params: p });
      run.mapping.custom('approval', { ...p, requestId, kind: match[1] });
    } else rpc.write({ id: x.id, error: { code: -32601, message: 'Unsupported or unattended server request' } });
    return;
  }
  if (x.method === 'serverRequest/resolved') {
    for (const [key, r] of pending) if (r.id === p.requestId) { pending.delete(key); run?.mapping.custom('approvalResolved', { requestId: key }); }
  }
  if (x.method === 'turn/completed' && run) {
    void artifacts(p.threadId).then(files => run.mapping.custom('artifacts', files)).catch(() => {}).finally(() => run.mapping.handle(x.method, p));
  } else run?.mapping.handle(x.method, p);
});
rpc.on('offline', () => { for (const r of active.values()) r.mapping.error('QIRI app-server disconnected; restart gateway'); });
rpc.on('protocolError', () => { for (const r of active.values()) r.mapping.error('Invalid QIRI protocol response'); });
const PORT = 8787;
const HOSTS = (process.env.QIRI_WEB_HOSTS || '127.0.0.1').split(',').map(x => x.trim()).filter(Boolean);
const ALLOWED_HOSTS = [...new Set([...HOSTS, '127.0.0.1', 'localhost'])].map(h => `${h}:${PORT}`);
const ALLOWED_ORIGINS = ALLOWED_HOSTS.map(h => `http://${h}`);
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const host = req.headers.host;
  if (!ALLOWED_HOSTS.includes(host || '')) return res.status(403).json({ error: 'Host forbidden' });
  if (req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)) return res.status(403).json({ error: 'Origin forbidden' });
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next();
});
app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: rpc.child.exitCode === null, activeRuns: active.size }));
app.post('/api/threads', async (req, res) => {
  const cwd = path.join(root, randomUUID()); await mkdir(cwd);
  const review = req.body?.review === true;
  const result = await rpc.call('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: review ? 'untrusted' : 'on-request', approvalsReviewer: 'user', developerInstructions: 'Only work inside your cwd. Do not modify other projects. Never delegate or spawn subagents. When an action is denied, do not retry it or work around that decision; explain the denial.' });
  loaded.add(result.thread.id); registry[result.thread.id] = { cwd, review }; await persist(); res.json({ thread: result.thread });
});
app.get('/api/threads', async (req, res) => {
  const result = await rpc.call('thread/list', { limit: 100, cwd: Object.values(registry).map(x => x.cwd), modelProviders: [], sourceKinds: [], cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null });
  res.json({ ...result, data: result.data.filter((t: any) => registry[t.id]) });
});
async function history(id: string) {
  known(id);
  const result = await rpc.call('thread/resume', { threadId: id, excludeTurns: false }).catch((e: Error) => { if (loaded.has(id) && e.message.includes('no rollout')) return { thread: { id, turns: [] } }; throw e; });
  loaded.add(id);
  if (!result.thread.cwd) return { thread: result.thread, messages: [], approvals: [] };
  let turns = result.thread.turns || [];
  // New paginated rollouts may omit full turns on resume.
  if (!turns.length) {
    let cursor: string | null = null;
    do { const page = await rpc.call('thread/turns/list', { threadId: id, limit: 100, sortDirection: 'asc', itemsView: 'full', cursor }); turns.push(...page.data); cursor = page.nextCursor; } while (cursor);
  }
  for (const turn of turns) if (turn.itemsView !== 'full' || !turn.items?.length) {
    let cursor: any = null; const items: any[] = [];
    do { const page = await rpc.call('thread/items/list', { threadId: id, turnId: turn.id, limit: 100, cursor }); items.push(...page.data.map((entry: any) => entry.item || entry)); cursor = page.nextCursor; } while (cursor);
    turn.items = items;
  }
  return { thread: { ...result.thread, turns }, messages: historyMessages(turns), approvals: [...pending].filter(([, r]) => r.params.threadId === id).map(([requestId, r]) => ({ ...r.params, requestId, kind: r.kind })) };
}
app.get('/api/threads/:id', async (req, res) => res.json(await history(req.params.id)));
app.post('/api/agui/approval', (req, res) => {
  const { requestId, decision } = req.body || {}, r = pending.get(requestId);
  if (!r) return res.status(404).json({ error: 'Approval expired or already resolved' });
  if (!['once', 'session', 'deny'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  rpc.reply(r.id, approvalResult(r.kind, r.params, decision)); pending.delete(requestId);
  active.get(r.params.threadId)?.mapping.custom('approvalResolved', { requestId, decision });
  res.json({ ok: true });
});
app.post('/api/agui/cancel', async (req, res) => {
  const id = req.body?.threadId; known(id);
  const run = active.get(id);
  if (!run) return res.status(409).json({ error: 'No active run' });
  await rpc.call('turn/interrupt', { threadId: id, turnId: (run.mapping as any).turnId }); res.json({ ok: true });
});
async function artifacts(id: string) {
  const base = known(id).cwd; const files: any[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 5 || files.length >= 100) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) { const rel = path.relative(base, full); files.push({ name: entry.name, path: rel, image: /\.(png|jpe?g)$/i.test(rel), url: `/api/threads/${id}/artifacts/${rel.split(path.sep).map(encodeURIComponent).join('/')}` }); }
    }
  }
  await walk(base, 0); return files;
}
app.get('/api/threads/:id/artifacts', async (req, res) => res.json(await artifacts(req.params.id)));
app.get('/api/threads/:id/artifacts/*file', async (req, res) => {
  const base = await realpath(known(req.params.id).cwd);
  const rel = (req.params.file as unknown as string[]).join('/');
  const full = await realpath(path.resolve(base, rel));
  if (!full.startsWith(base + path.sep) || !(await stat(full)).isFile()) return res.status(403).end();
  if (!/\.(png|jpe?g)$/i.test(full)) res.setHeader('Content-Disposition', 'attachment');
  res.sendFile(full, { dotfiles: 'allow' });
});
app.post('/api/agui/run', async (req, res) => {
  const { threadId, runId } = req.body || {}; known(threadId);
  if (typeof runId !== 'string' || !Array.isArray(req.body.messages)) return res.status(400).json({ error: 'Expected AG-UI RunAgentInput' });
  const last = [...req.body.messages].reverse().find((m: any) => m.role === 'user');
  if (!last || typeof last.content !== 'string' || !last.content.trim() || last.content.length > 100_000) return res.status(400).json({ error: 'Expected user text' });
  if (active.has(threadId)) return res.status(409).json({ error: 'Thread already running' });
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }).flushHeaders();
  let closed = false;
  const send = (e: any) => { if (!closed) res.write(`data: ${JSON.stringify(e)}\n\n`); };
  const heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15000);
  const finish = () => { clearInterval(heartbeat); clearTimeout(timeout); settle(threadId); active.delete(threadId); if (!closed) res.end(); closed = true; };
  const mapping = new Mapping(threadId, runId, send, finish);
  const timeout = setTimeout(() => { void interrupt(); mapping.error('Run exceeded 10 minute limit'); }, 600_000);
  active.set(threadId, { mapping, finish });
  async function interrupt() { const turnId = (mapping as any).turnId; if (turnId) await rpc.call('turn/interrupt', { threadId, turnId }).catch(() => {}); }
  res.on('close', () => { if (!closed) { closed = true; settle(threadId); void interrupt(); finish(); } });
  mapping.start();
  try {
    if (!loaded.has(threadId)) { await rpc.call('thread/resume', { threadId, excludeTurns: true }); loaded.add(threadId); }
    const result = await rpc.call('turn/start', { threadId, input: [{ type: 'text', text: last.content }], approvalPolicy: registry[threadId].review ? 'untrusted' : 'on-request', approvalsReviewer: 'user' });
    (mapping as any).turnId = result.turn.id;
  } catch (e: any) { mapping.error(e.message); }
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API; arbitrary RPC is not exposed' }));
app.use(express.static(path.resolve('dist'), { index: 'index.html' }));
app.get('/', (_req, res) => res.status(503).send('Build frontend with npm run build'));
app.use((err: any, _req: any, res: any, _next: any) => { if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Gateway error' }); });
const servers = HOSTS.map(host => app.listen(PORT, host, () => console.log(`QIRI Web http://${host}:${PORT}`)));
for (const server of servers) server.on('error', () => shutdown());
function shutdown() { for (const r of active.values()) r.mapping.error('Gateway shutting down'); for (const s of servers) s.close(); rpc.close(); setTimeout(() => process.exit(0), 500).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
