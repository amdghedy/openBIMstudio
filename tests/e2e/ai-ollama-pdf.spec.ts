import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Attaches a generated PDF in the AI chat, sends a question to a real local Ollama model and
// asserts (1) the outgoing request carries the PDF text and (2) a reply renders in the chat.
// Selectors checked against the review/ai-ollama-pdf tree (092a3a0) with a stubbed model reply (MOCK_OLLAMA=1).
const model = process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b';
const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';

test('PDF attachment reaches a real local model and a reply renders', async ({ page }) => {
  test.setTimeout(240_000);
  const doc = await PDFDocument.create();
  doc.addPage().drawText('Beam schedule: B1 steel 6m. Project code ZX-42.', { x: 40, y: 700, size: 14 });
  const pdf = path.join(os.tmpdir(), 'ci-test.pdf');
  fs.writeFileSync(pdf, await doc.save());

  const sent: any[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/chat')) {
      try { sent.push(JSON.parse(r.postData() ?? '{}')); } catch { /* ignore */ }
    }
  });
  await page.addInitScript(([m, b]) => {
    localStorage.setItem('obs.ai.provider', JSON.stringify({ kind: 'ollama', endpoint: b, model: m }));
    localStorage.setItem('obs.ai.consent.hosts', JSON.stringify(['localhost', '127.0.0.1', b]));
  }, [model, base]);

  // Optional: answer the model call from a stub so the UI path can be checked without a model (MOCK_OLLAMA=1).
  if (process.env.MOCK_OLLAMA) {
    await page.route('**/ollama/api/chat', (route) => route.fulfill({
      status: 200, contentType: 'application/x-ndjson',
      body: JSON.stringify({ message: { role: 'assistant', content: 'The project code is ZX-42.' }, done: false }) + '\n'
        + JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n',
    }));
    await page.route('**/ollama/api/tags', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [{ name: model }] }) }));
  }
  await page.goto('/');
  // Enter the workspace from the home screen, then open the AI chat panel (hidden by default).
  await page.getByText('3D BIM Platform').first().click();
  await page.getByText('View', { exact: true }).first().click();
  await page.locator('[title^="Open the AI assistant"]').first().click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /Attach PDF/ }).click(),
  ]);
  await chooser.setFiles(pdf);
  // The PDF text is read in the browser after attach; wait for the chip before sending.
  await expect(page.getByText(/ci-test\.pdf \(1 page\)/)).toBeVisible({ timeout: 30_000 });
  const box = page.locator('textarea[placeholder^="Ask about the model"]').first();
  await box.fill('What is the project code?');
  await box.press('Enter');

  await expect.poll(() => sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(JSON.stringify(sent.at(-1)?.messages ?? '')).toContain('ZX-42');
  expect(sent.at(-1)?.options?.num_ctx).toBeGreaterThanOrEqual(8192);
  await expect(page.getByText(/ZX-42/).last()).toBeVisible({ timeout: 180_000 });
});
