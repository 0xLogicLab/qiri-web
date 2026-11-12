import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { approvalResult } from '../server/mapping.js';
const base = 'http://127.0.0.1:8787';
export async function api(route: string, body?: any): Promise<any> {
  const r = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${route}: ${r.status} ${await r.text()}`); return r.json();
}
export async function run(threadId: string, text: string, decision?: string) {
  const response = await fetch(base + '/api/agui/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, runId: crypto.randomUUID(), messages: [{ id: crypto.randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} }), signal: AbortSignal.timeout(240_000) });
  assert.equal(response.status, 200); const events: any[] = []; let buffer = '';
  for await (const chunk of response.body!) {
    buffer += new TextDecoder().decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!frame.startsWith('data: ')) continue;
      const e = JSON.parse(frame.slice(6)); events.push(e);
      if (e.type === 'CUSTOM' && e.name === 'qiri.approval') {
        if (!decision) throw new Error('Unexpected approval');
        await api('/api/agui/approval', { requestId: e.value.requestId, decision });
      }
    }
  }
  return events;
}
if (process.argv[1]?.endsWith('gateway-test.ts')) {
  await mkdir('.web-evidence/s1', { recursive: true });
  const { thread } = await api('/api/threads', {});
  const events = await run(thread.id, 'Use apply_patch to create hello.txt containing QIRI_WEB_FILE_OK in cwd, then run python3 -c "from pathlib import Path; print(Path(\'hello.txt\').read_text())". Finish by saying QIRI_WEB_TASK_OK. Do not ask for escalation.');
  await writeFile('.web-evidence/s1/task-events.json', JSON.stringify(events, null, 2));
  const types = events.map(e => e.type);
  for (const type of ['RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']) assert(types.includes(type), type);
  assert.equal(types[0], 'RUN_STARTED'); assert.equal(types.at(-1), 'RUN_FINISHED'); assert(!types.includes('RUN_ERROR'));
  const { thread: review } = await api('/api/threads', { review: true });
  const approval = await run(review.id, 'Run exactly python3 -c "print(\'QIRI_APPROVED_OK\')" in cwd. This is an approval roundtrip test: request command approval if required. Then say done.', 'once');
  await writeFile('.web-evidence/s1/approval-events.json', JSON.stringify(approval, null, 2));
  assert(approval.some(e => e.name === 'qiri.approval')); assert(approval.some(e => e.name === 'qiri.approvalResolved'));
  assert(approval.some(e => e.type === 'TOOL_CALL_RESULT' && e.content.includes('QIRI_APPROVED_OK') && JSON.parse(e.content).exitCode === 0));
  assert.equal(approval.at(-1)?.type, 'RUN_FINISHED');
  for (const kind of ['commandExecution', 'fileChange']) {
    assert.deepEqual(approvalResult(kind, {}, 'once'), { decision: 'accept' });
    assert.deepEqual(approvalResult(kind, {}, 'session'), { decision: 'acceptForSession' });
    assert.deepEqual(approvalResult(kind, {}, 'deny'), { decision: 'decline' });
  }
  assert.deepEqual(approvalResult('permissions', { permissions: { network: { enabled: true } } }, 'session'), { permissions: { network: { enabled: true } }, scope: 'session' });
  assert.deepEqual(approvalResult('permissions', {}, 'deny'), { permissions: {}, scope: 'turn' });
  const { messages } = await api(`/api/threads/${thread.id}`); assert(messages.some((m: any) => m.content?.includes('QIRI_WEB_TASK_OK')));
  const blocked = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'fs/readFile', params: { path: '/etc/passwd' } }) }); assert.equal(blocked.status, 404);
  await writeFile('.web-evidence/s1/summary.json', JSON.stringify({ threadId: thread.id, reviewThreadId: review.id, eventTypes: types, approvalCount: approval.filter(e => e.name === 'qiri.approval').length, historyMessages: messages.length, forbiddenRpcStatus: blocked.status }, null, 2));
  console.log('PASS real tool sequence, approval roundtrip, history, RPC boundary');
}
