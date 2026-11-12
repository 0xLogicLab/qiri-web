export type Event = Record<string, any> & { type: string };
export const isTool = (item: any) => !['userMessage', 'agentMessage', 'reasoning', 'hookPrompt'].includes(item.type);
export function approvalResult(kind: string, params: any, decision: string) {
  if (kind === 'permissions') return { permissions: decision === 'deny' ? {} : params.permissions, scope: decision === 'session' ? 'session' : 'turn' };
  return { decision: ({ once: 'accept', session: 'acceptForSession', deny: 'decline' } as Record<string, string>)[decision] };
}
export function historyMessages(turns: any[]) {
  const messages: any[] = [];
  for (const turn of turns) for (const item of turn.items || []) {
    if (item.type === 'userMessage') messages.push({ id: item.id, role: 'user', content: item.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') });
    else if (item.type === 'agentMessage') messages.push({ id: item.id, role: 'assistant', content: item.text });
    else if (isTool(item)) {
      messages.push({ id: `call-${item.id}`, role: 'assistant', toolCalls: [{ id: item.id, type: 'function', function: { name: item.type, arguments: JSON.stringify(item) } }] });
      messages.push({ id: `result-${item.id}`, role: 'tool', toolCallId: item.id, content: JSON.stringify(item) });
    }
  }
  return messages;
}
export class Mapping {
  texts = new Map<string, string>(); tools = new Set<string>(); started = false; ended = false;
  constructor(public threadId: string, public runId: string, public emit: (e: Event) => void, public done: () => void) {}
  custom(name: string, value: any) { this.emit({ type: 'CUSTOM', name: `qiri.${name}`, value }); }
  start() { if (!this.started) { this.started = true; this.emit({ type: 'RUN_STARTED', threadId: this.threadId, runId: this.runId }); } }
  textStart(id: string) { if (!this.texts.has(id)) { this.texts.set(id, ''); this.emit({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' }); } }
  toolStart(item: any) {
    if (this.tools.has(item.id)) return;
    this.tools.add(item.id);
    this.emit({ type: 'TOOL_CALL_START', toolCallId: item.id, toolCallName: item.type });
    this.emit({ type: 'TOOL_CALL_ARGS', toolCallId: item.id, delta: JSON.stringify(item) });
    this.emit({ type: 'TOOL_CALL_END', toolCallId: item.id });
  }
  error(message: string) { if (this.ended) return; this.start(); this.ended = true; this.emit({ type: 'RUN_ERROR', message }); this.done(); }
  handle(method: string, p: any) {
    if (this.ended) return;
    if (method === 'turn/started') this.start();
    if (['thread/started', 'thread/status/changed', 'thread/name/updated'].includes(method)) this.custom('thread', p);
    if (method === 'item/started' || method === 'item/completed') {
      const i = p.item;
      if (i.type === 'agentMessage') {
        this.textStart(i.id);
        if (method === 'item/completed') {
          if (!this.texts.get(i.id) && i.text) this.emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: i.id, delta: i.text });
          this.emit({ type: 'TEXT_MESSAGE_END', messageId: i.id });
        }
      } else if (isTool(i)) {
        this.toolStart(i); this.custom('tool', i);
        if (method === 'item/completed') this.emit({ type: 'TOOL_CALL_RESULT', messageId: `result-${i.id}`, toolCallId: i.id, content: JSON.stringify(i), role: 'tool' });
      }
    }
    if (method === 'item/agentMessage/delta') { this.textStart(p.itemId); this.texts.set(p.itemId, this.texts.get(p.itemId)! + p.delta); this.emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: p.itemId, delta: p.delta }); }
    if (/^item\/(commandExecution|fileChange)\/outputDelta$/.test(method) || method === 'item/mcpToolCall/progress') this.custom('output', p);
    if (method === 'turn/diff/updated' || method === 'item/fileChange/patchUpdated') this.custom('diff', p);
    if (method === 'turn/plan/updated') this.custom('plan', p);
    if (method === 'error') { if (p.willRetry) this.custom('error', p); else this.error(p.error?.message || 'QIRI run failed'); }
    if (method === 'turn/completed') {
      if (p.turn.status !== 'completed') return this.error(p.turn.error?.message || `Turn ${p.turn.status}`);
      this.ended = true; this.emit({ type: 'RUN_FINISHED', threadId: this.threadId, runId: this.runId }); this.done();
    }
  }
}
