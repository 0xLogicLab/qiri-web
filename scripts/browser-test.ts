import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, symlink, unlink } from 'node:fs/promises';
import { api } from './gateway-test.js';
const out = '.web-evidence/s3';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.cwd() + '/.runtime/browsers/chromium-1254/chrome-linux-arm64/chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors: string[] = [], streams: any[][] = [], streamedText: string[] = [];
  const captures: Promise<void>[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', response => {
    if (response.url().endsWith('/api/agui/run')) captures.push((async () => {
      const text = await response.text(); const events = text.split('\n\n').filter(f => f.startsWith('data: ')).map(f => JSON.parse(f.slice(6))); streams.push(events); await writeFile(`${out}/events-partial.json`, JSON.stringify(streams, null, 2));
    })());
  });
  await page.goto('http://127.0.0.1:8787');
  await expect(page.getByRole('button', { name: '开始新的探索 ↗' })).toBeVisible();
  await page.screenshot({ path: `${out}/homepage.png`, fullPage: true });
  await writeFile(`${out}/homepage-dom.txt`, await page.locator('body').innerText());
  await page.getByRole('button', { name: '开始新的探索 ↗' }).click();
  const task = '在当前工作目录执行一个真实小任务，不要委派：1. 用 apply_patch 创建 research.txt，内容是 QIRI_BROWSER_FILE_OK。2. 执行 python3，读出这个文件并打印 QIRI_BROWSER_COMMAND_OK，然后只用 Python 标准库 struct/zlib 生成一个 80x60 的有效 RGB PNG，文件名 plot.png（渐变颜色即可）。不要只输出代码，要真实执行。3. 最后用 Markdown 粗体写 QIRI_BROWSER_DONE，并附一个 Python fenced 代码块 print(42)。';
  await page.getByRole('textbox', { name: '消息' }).fill(task);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.connection')).toContainText('正在工作');
  await expect(page.locator('.assistant strong').filter({ hasText: 'QIRI_BROWSER_DONE' })).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('.connection')).toContainText('准备就绪', { timeout: 240_000 });
  await expect(page.locator('img[alt="plot.png"]')).toBeVisible();
  await expect.poll(() => page.locator('img[alt="plot.png"]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 80)).toBe(true);
  await expect(page.locator('.diff').first()).toContainText('QIRI_BROWSER_FILE_OK');
  const id = await page.locator('.thread-entry.selected').getAttribute('data-thread-id'); assert(id);
  const files = await api(`/api/threads/${id}/artifacts`); assert(files.some((f: any) => f.path === 'plot.png'));
  const png = await fetch('http://127.0.0.1:8787' + files.find((f: any) => f.path === 'plot.png').url); assert.equal(png.headers.get('content-type'), 'image/png'); await writeFile(`${out}/plot.png`, Buffer.from(await png.arrayBuffer()));
  await page.screenshot({ path: `${out}/task.png`, fullPage: true });
  await writeFile(`${out}/task-dom.txt`, await page.locator('body').innerText());
  console.log('PASS browser file + command + PNG task', id);
  // Close the view, then reload the browser page and use the sidebar to restore.
  await page.getByRole('button', { name: '关闭当前会话' }).click();
  await page.reload();
  await page.locator(`[data-thread-id="${id}"]`).click();
  await expect(page.locator('.assistant').last()).toContainText('QIRI_BROWSER_DONE');
  await expect(page.locator('img[alt="plot.png"]')).toBeVisible();
  await expect(page.getByTestId('tool-card')).not.toHaveCount(0);
  await page.screenshot({ path: `${out}/restored.png`, fullPage: true });
  console.log('PASS sidebar restore after close/reload');
  const decisions: any[] = [];
  for (const decision of ['once', 'deny']) {
    await page.getByLabel('新会话启用命令审批').check();
    await page.getByRole('button', { name: /新建会话/ }).click();
    await expect(page.locator('.welcome')).toBeVisible();
    const text = decision === 'once'
      ? 'This is a command approval test. Execute exactly python3 -c "print(\'QIRI_BROWSER_APPROVED\')" in cwd, then say done. Do not replace the command or skip executing it.'
      : 'This is a command DENIAL test. Attempt exactly python3 -c "from pathlib import Path; Path(\'denied-marker.txt\').write_text(\'must-not-exist\')" in cwd. The user will deny it. If denied, stop and report the denial; do not retry, use another tool, or work around it.';
    await page.getByRole('textbox', { name: '消息' }).fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible({ timeout: 240_000 });
    await page.screenshot({ path: `${out}/approval-${decision}.png`, fullPage: true });
    await card.getByRole('button', { name: decision === 'once' ? '允许一次' : '拒绝', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.connection')).toContainText('准备就绪', { timeout: 240_000 });
    const reviewId = await page.locator('.thread-entry.selected').getAttribute('data-thread-id'); assert(reviewId);
    const result = await api(`/api/threads/${reviewId}`);
    const tools = result.thread.turns.flatMap((t: any) => t.items).filter((i: any) => i.type === 'commandExecution');
    if (decision === 'once') assert(tools.some((t: any) => t.exitCode === 0 && t.aggregatedOutput?.includes('QIRI_BROWSER_APPROVED')));
    else { assert(tools.every((t: any) => t.status === 'declined' || t.status === 'failed' || t.aggregatedOutput?.toLowerCase().includes('reject'))); assert(result.messages.some((m: any) => m.role === 'assistant' && /denied|rejected|拒绝/i.test(m.content || ''))); assert(!(await api(`/api/threads/${reviewId}/artifacts`)).some((f: any) => f.path === 'denied-marker.txt')); }
    decisions.push({ decision, threadId: reviewId, tools });
    await page.screenshot({ path: `${out}/resolved-${decision}.png`, fullPage: true });
    console.log('PASS frontend approval', decision);
  }
  // Public API boundaries and traversal/symlink protection.
  const forbidden: Record<string, number> = {};
  for (const method of ['fs/readFile', 'config/read', 'account/read']) {
    const r = await fetch('http://127.0.0.1:8787/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method }) }); assert.equal(r.status, 404); forbidden[method] = r.status;
  }
  const crossOrigin = await fetch('http://127.0.0.1:8787/api/threads', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(crossOrigin.status, 403);
  const registry = JSON.parse(await readFile('.runtime/threads.json', 'utf8'));
  const link = `${registry[id].cwd}/outside-link.png`;
  await symlink(process.cwd() + '/README.md', link);
  try { const r = await fetch(`http://127.0.0.1:8787/api/threads/${id}/artifacts/outside-link.png`); assert.equal(r.status, 403); } finally { await unlink(link); }
  await Promise.all(captures);
  assert.equal(streams.length, 3);
  for (const events of streams) { assert.equal(events[0].type, 'RUN_STARTED'); assert.equal(events.at(-1)?.type, 'RUN_FINISHED'); assert(!events.some(e => e.type === 'RUN_ERROR')); }
  for (const e of streams[0]) if (e.type === 'TEXT_MESSAGE_CONTENT') streamedText.push(e.delta);
  assert(streamedText.length > 1);
  assert(streams[0].some(e => e.type === 'TOOL_CALL_RESULT' && e.content.includes('QIRI_BROWSER_COMMAND_OK')));
  for (const events of streams.slice(1)) { assert(events.some(e => e.name === 'qiri.approval')); assert(events.some(e => e.name === 'qiri.approvalResolved')); }
  assert.deepEqual(errors, []);
  await writeFile(`${out}/events.json`, JSON.stringify(streams, null, 2));
  await writeFile(`${out}/summary.json`, JSON.stringify({ result: 'PASS', browser: 'Playwright Chromium 158 headless', taskThreadId: id, artifacts: files, approvals: decisions, streamedTextChunks: streamedText.length, historyRestored: true, browserErrors: errors, blockedRpc: forbidden, crossOriginStatus: crossOrigin.status, symlinkEscapeStatus: 403 }, null, 2));
  await writeFile(`${out}/final-dom.txt`, await page.locator('body').innerText());
  await unlink(`${out}/events-partial.json`).catch(() => {});
  console.log('PASS all S3 browser and boundary checks');
} finally { await browser.close(); }
