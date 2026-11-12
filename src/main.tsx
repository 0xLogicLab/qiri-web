import { createRoot } from 'react-dom/client';
import { useState, useEffect, useMemo, useContext, createContext } from 'react';
import { AssistantRuntimeProvider, ThreadPrimitive, MessagePrimitive, ComposerPrimitive, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { useAgUiRuntime, fromAgUiMessages } from '@assistant-ui/react-ag-ui';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import { HttpAgent } from '@ag-ui/client';
import './style.css';

async function api(route: string, body?: any) {
  const response = await fetch(route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败'); return data;
}
const Live = createContext<{ tools: Record<string, any>; outputs: Record<string, string> }>({ tools: {}, outputs: {} });
function Diff({ value }: { value: string }) {
  return <pre className="diff" aria-label="文件差异">{value.split('\n').map((line, n) => <span key={n} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : line.startsWith('@@') ? 'hunk' : ''}>{line || ' '}<br/></span>)}</pre>;
}
function ToolCard({ toolCallId, toolName, args, result }: ToolCallMessagePartProps) {
  const live = useContext(Live);
  let parsed: any = result;
  if (typeof result === 'string') { try { parsed = JSON.parse(result); } catch { parsed = { aggregatedOutput: result }; } }
  const item = parsed || live.tools[toolCallId] || args || {};
  const output = item.aggregatedOutput || live.outputs[toolCallId] || '';
  const state = item.status || (result ? 'completed' : 'inProgress');
  return <details className="tool-card" open data-testid="tool-card">
    <summary><span className="tool-icon">{toolName === 'fileChange' ? '↗' : '⌘'}</span><strong>{toolName === 'commandExecution' ? '执行命令' : toolName === 'fileChange' ? '文件变更' : toolName}</strong><span className={`status ${state}`}>{state === 'inProgress' ? '运行中' : state === 'completed' ? '已完成' : state}</span></summary>
    {item.command && <pre className="command">$ {item.command}</pre>}
    {output && <pre className="output">{output}</pre>}
    {item.exitCode != null && <div className="tool-footer">退出码 {item.exitCode}{item.durationMs != null && ` · ${item.durationMs} ms`}</div>}
    {item.changes?.map((c: any, n: number) => <div key={n}><div className="file-path">{c.path}</div><Diff value={c.diff || ''}/></div>)}
    {item.error && <pre className="error">{JSON.stringify(item.error)}</pre>}
    {toolName !== 'commandExecution' && toolName !== 'fileChange' && <pre className="output">{JSON.stringify(item.result || item.arguments || item, null, 2)}</pre>}
  </details>;
}
function Markdown() { return <MarkdownTextPrimitive/>; }
const parts = { Text: Markdown, tools: { Fallback: ToolCard } };
function UserMessage() { return <MessagePrimitive.Root className="message user"><div className="message-label">你</div><MessagePrimitive.Parts components={{ Text: Markdown }}/></MessagePrimitive.Root>; }
function AssistantMessage() { return <MessagePrimitive.Root className="message assistant"><div className="message-label"><span className="mini-mark">Q</span> 穹理 <span>QIRI</span></div><MessagePrimitive.Parts components={parts}/></MessagePrimitive.Root>; }
function Approval({ request, onResolve }: { request: any; onResolve: (id: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function decide(decision: string) {
    setBusy(true); setError('');
    try { await api('/api/agui/approval', { requestId: request.requestId, decision }); onResolve(request.requestId); }
    catch (e: any) { setError(e.message); setBusy(false); }
  }
  return <section className="approval" data-testid="approval-card"><div className="eyebrow">需要你的决定</div><h3>批准{request.kind === 'commandExecution' ? '执行命令' : request.kind === 'fileChange' ? '文件变更' : '权限请求'}？</h3><pre>{request.command || request.reason || JSON.stringify(request.permissions || request)}</pre>{request.reason && request.command && <p>{request.reason}</p>}<div className="approval-actions"><button disabled={busy} onClick={() => decide('once')}>允许一次</button><button disabled={busy} onClick={() => decide('session')}>本会话允许</button><button className="deny" disabled={busy} onClick={() => decide('deny')}>拒绝</button></div>{error && <p role="alert" className="error">{error}</p>}</section>;
}
function Artifacts({ files }: { files: any[] }) {
  if (!files.length) return null;
  return <section className="artifacts"><div className="eyebrow">研究产物 · {files.length}</div><div className="artifact-grid">{files.map(f => <a href={f.url} key={f.path} target="_blank" rel="noreferrer" className="artifact">{f.image && <img src={f.url} alt={f.name} loading="lazy"/>}<span>↗ {f.name}</span><small>{f.path}</small></a>)}</div></section>;
}
function Chat({ initial, onUpdate, onBusy }: { initial: any; onUpdate: () => void; onBusy: (busy: boolean) => void }) {
  const id = initial.thread.id;
  const [tools, setTools] = useState<Record<string, any>>({}), [outputs, setOutputs] = useState<Record<string, string>>({});
  const [approvals, setApprovals] = useState<any[]>(initial.approvals || []), [files, setFiles] = useState<any[]>([]), [diff, setDiff] = useState(''), [error, setError] = useState(''), [running, setRunning] = useState(false);
  const agent = useMemo(() => new HttpAgent({ url: '/api/agui/run', threadId: id }), [id]);
  const runtime = useAgUiRuntime({ agent, onError: e => setError(e.message), onCancel: () => { void api('/api/agui/cancel', { threadId: id }).catch(() => {}); } });
  useEffect(() => { runtime.thread.reset(fromAgUiMessages(initial.messages || [])); }, [initial, runtime]);
  useEffect(() => { void api(`/api/threads/${id}/artifacts`).then(setFiles).catch(e => setError(e.message)); }, [id]);
  useEffect(() => {
    const subscription = agent.subscribe({
      onRunStartedEvent: () => { setRunning(true); onBusy(true); setError(''); },
      onCustomEvent: ({ event }) => {
        const v: any = event.value;
        if (event.name === 'qiri.tool') setTools(prev => ({ ...prev, [v.id]: v }));
        if (event.name === 'qiri.output') setOutputs(prev => ({ ...prev, [v.itemId]: (prev[v.itemId] || '') + (v.delta || v.message || '') }));
        if (event.name === 'qiri.approval') setApprovals(prev => [...prev.filter(a => a.requestId !== v.requestId), v]);
        if (event.name === 'qiri.approvalResolved') setApprovals(prev => prev.filter(a => a.requestId !== v.requestId));
        if (event.name === 'qiri.diff' && v.diff) setDiff(v.diff);
        if (event.name === 'qiri.artifacts') setFiles(v);
      },
      onRunFinishedEvent: () => { setRunning(false); onBusy(false); onUpdate(); void api(`/api/threads/${id}/artifacts`).then(setFiles).catch(() => {}); },
      onRunErrorEvent: ({ event }) => { setRunning(false); onBusy(false); setApprovals([]); setError(event.message); onUpdate(); },
      onRunFailed: ({ error: e }) => { setRunning(false); onBusy(false); setError(String(e)); },
    });
    return () => { subscription.unsubscribe(); onBusy(false); };
  }, [agent, id, onUpdate, onBusy]);
  return <AssistantRuntimeProvider runtime={runtime}><Live.Provider value={{ tools, outputs }}><main className="main"><header className="topbar"><div><span className="eyebrow">RESEARCH WORKSPACE</span><h1>与穹理一起，探寻答案。</h1></div><span className="connection"><i/>{running ? '正在工作' : '准备就绪'}</span></header>
    <ThreadPrimitive.Root className="thread"><ThreadPrimitive.Viewport className="viewport"><div className="conversation"><ThreadPrimitive.Empty><div className="welcome"><div className="orbit">Q</div><h2>从一个问题开始。</h2><p>讨论想法、执行分析，或一起创建下一份研究产物。<br/>穹理的每一步操作与审批，都会在这里呈现。</p><div className="suggestions"><button onClick={() => runtime.thread.append('请在当前目录创建一个 hello.txt，运行命令读出内容，并说明结果。')}>创建文件并验证 ↗</button><button onClick={() => runtime.thread.append('请用 Markdown 介绍你能如何协助研究，附一个 Python 代码块。不要调用工具。')}>探索研究助手 ↗</button></div></div></ThreadPrimitive.Empty><ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }}/>
      {approvals.map(a => <Approval key={a.requestId} request={a} onResolve={key => setApprovals(prev => prev.filter(x => x.requestId !== key))}/>)}
      {diff && <details className="turn-diff"><summary>本轮完整 diff</summary><Diff value={diff}/></details>}
      <Artifacts files={files}/>{error && <div className="error error-banner" role="alert">{error}</div>}
    </div></ThreadPrimitive.Viewport><div className="composer-wrap"><ComposerPrimitive.Root className="composer"><ComposerPrimitive.Input aria-label="消息" placeholder="向穹理提问，或描述一个研究任务…" autoFocus rows={2}/><div className="composer-bottom"><span>↵ 发送 · Shift + ↵ 换行</span>{running ? <ComposerPrimitive.Cancel className="send" aria-label="停止">停止 □</ComposerPrimitive.Cancel> : <ComposerPrimitive.Send className="send" aria-label="发送">发送 ↑</ComposerPrimitive.Send>}</div></ComposerPrimitive.Root><div className="footnote">穹理 QIRI · 单用户研究预览 · 执行前请检查重要操作</div></div></ThreadPrimitive.Root></main></Live.Provider></AssistantRuntimeProvider>;
}
function App() {
  const [threads, setThreads] = useState<any[]>([]), [current, setCurrent] = useState<any>(null), [review, setReview] = useState(false), [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [cursor, setCursor] = useState<string | null>(null);
  const refresh = useMemo(() => () => { void api('/api/threads').then(data => { setThreads(data.data); setCursor(data.nextCursor); }).catch(e => setError(e.message)); }, []);
  useEffect(refresh, [refresh]);
  async function create() {
    setLoading(true); setError('');
    try { const data = await api('/api/threads', { review }); setCurrent({ thread: data.thread, messages: [], approvals: [] }); refresh(); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }
  async function open(id: string) {
    if (current?.thread.id === id) return;
    setLoading(true); setError('');
    try { setCurrent(await api(`/api/threads/${id}`)); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }
  async function more() { try { const data = await api(`/api/threads?cursor=${encodeURIComponent(cursor!)}`); setThreads(prev => [...prev, ...data.data]); setCursor(data.nextCursor); } catch (e: any) { setError(e.message); } }
  return <div className="app"><aside className="sidebar"><div className="brand"><div className="brand-mark">Q</div><div>穹理 <span>QIRI</span><small>YOUR RESEARCH COMPANION</small></div></div><button className="new-thread" onClick={create} disabled={loading || busy}>＋ 新建会话 <span>↗</span></button><label className="review-toggle"><input type="checkbox" checked={review} onChange={e => setReview(e.target.checked)} disabled={busy}/> 新会话启用命令审批</label><div className="sidebar-heading">会话记录 <button onClick={refresh} aria-label="刷新会话">↻</button></div><nav aria-label="会话列表">{threads.map(t => <button key={t.id} data-thread-id={t.id} className={`thread-entry ${current?.thread.id === t.id ? 'selected' : ''}`} onClick={() => open(t.id)} disabled={busy || loading}><span>◌</span><div>{t.name || t.preview || '新会话'}<small>{new Date(t.updatedAt * 1000).toLocaleDateString('zh-CN')}</small></div></button>)}{!threads.length && <p className="empty-list">新的探索，从这里开始。</p>}{cursor && <button className="load-more" onClick={more}>更多会话</button>}</nav><div className="sidebar-bottom"><span className="local-dot"/> 本地工作空间<small>单用户 · 无鉴权 · Spike</small>{current && <button disabled={busy} onClick={() => setCurrent(null)}>关闭当前会话</button>}</div></aside><section className="workspace">{error && <div className="error error-banner" role="alert">{error}</div>}{loading && <div className="loading" role="status">正在加载会话…</div>}{current ? <Chat key={current.thread.id} initial={current} onUpdate={refresh} onBusy={setBusy}/> : <main className="landing"><span className="eyebrow">穹理 · QIRI</span><h1>让好奇心，<br/>抵达更远的地方。</h1><p>一个问题，一次实验，一份新的发现。<br/>你的研究工作空间已准备好。</p><button className="primary" onClick={create} disabled={loading}>开始新的探索 ↗</button><div className="landing-footer">思考 · 执行 · 验证</div></main>}</section></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
