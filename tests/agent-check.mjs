// Прогон реального извлечения текста и агента в Chromium: node tests/agent-check.mjs
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
const srv = await serve();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
await page.goto(`http://localhost:${srv.address().port}/tests/harness.html`);
await page.waitForFunction(() => window.ready);
const qs = JSON.parse(process.argv[2] || '[]');
const res = await page.evaluate((qs) => window.run(qs), qs);
console.log(JSON.stringify(res, null, 1));
await browser.close(); srv.close();
