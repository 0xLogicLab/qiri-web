import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
process.env.PLAYWRIGHT_BROWSERS_PATH = process.cwd() + '/.runtime/browsers';
const browser = await chromium.launch({ headless: true, executablePath: process.cwd() + '/.runtime/browsers/chromium-1254/chrome-linux-arm64/chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8787');
  await expect(page.getByText('让好奇心，')).toBeVisible();
  const summary = JSON.parse(await readFile('.web-evidence/s1/summary.json', 'utf8'));
  await page.locator(`[data-thread-id="${summary.threadId}"]`).click();
  await expect(page.getByTestId('tool-card')).toHaveCount(2);
  await expect(page.locator('.assistant').last()).toContainText('QIRI_WEB_TASK_OK');
  await expect(page.locator('.diff')).toContainText('QIRI_WEB_FILE_OK');
  await page.getByRole('button', { name: /新建会话/ }).click();
  await expect(page.locator('.welcome')).toBeVisible();
  await page.getByRole('textbox', { name: '消息' }).fill('Reply with exactly this Markdown, without tools: **QIRI_UI_OK** followed by a fenced python code block containing print(42).');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.assistant strong').filter({ hasText: 'QIRI_UI_OK' })).toContainText('QIRI_UI_OK', { timeout: 180_000 });
  await expect(page.locator('.assistant pre')).toContainText('print(42)', { timeout: 180_000 });
  await expect(page.locator('.connection')).toContainText('准备就绪', { timeout: 180_000 });
  await mkdir('.web-evidence/s2', { recursive: true });
  await page.screenshot({ path: '.web-evidence/s2/chat.png', fullPage: true });
  await writeFile('.web-evidence/s2/dom.txt', await page.locator('body').innerText());
  await writeFile('.web-evidence/s2/smoke.json', JSON.stringify({ result: 'PASS', browserErrors: errors, checks: ['homepage', 'history', 'tool cards', 'diff', 'composer', 'live Markdown', 'code block'] }, null, 2));
  expect(errors).toEqual([]); console.log('PASS browser UI smoke and live Markdown');
} finally { await browser.close(); }
