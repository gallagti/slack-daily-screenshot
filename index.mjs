import { chromium } from 'playwright';
import { WebClient } from '@slack/web-api';

const {
  SLACK_BOT_TOKEN,
  CHANNEL_ID,
  TARGET_URLS = '',
  TIMEOUT_MS = '90000',
  VIEWPORT_W = '1366',      // used only for initial load; final shot is fullPage
  VIEWPORT_H = '900',
  DEVICE_SCALE_FACTOR = '2',
  TITLE_PREFIX = 'Daily screenshot',
  ADD_COMMENT = 'true'
} = process.env;

if (!SLACK_BOT_TOKEN || !CHANNEL_ID || !TARGET_URLS) {
  console.error('Missing required env vars: SLACK_BOT_TOKEN, CHANNEL_ID, TARGET_URLS');
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);

// 1) On the original page, find the main table’s HTML (largest visible table).
async function extractTableHTML(page) {
  return await page.evaluate(() => {
    const isVisible = (el) => {
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 5 && r.height > 5;
    };

    // Prefer tables inside obvious content wrappers
    const candidates = [
      ...document.querySelectorAll('main table, #content table, .content table, .container table, article table, section table, body table')
    ].filter(isVisible);

    if (!candidates.length) return { ok: false, reason: 'no_table_found' };

    // Pick the largest by area
    let best = candidates[0];
    let bestArea = 0;
    for (const t of candidates) {
      const r = t.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = t; bestArea = area; }
    }
    return { ok: true, html: best.outerHTML };
  });
}

// 2) Render just that table in a clean page so the screenshot is only the table
async function renderTableAndScreenshot(browser, tableHTML, meta = {}) {
  const context = await browser.newContext({
    viewport: { width: parseInt(VIEWPORT_W, 10), height: parseInt(VIEWPORT_H, 10) },
    deviceScaleFactor: parseFloat(DEVICE_SCALE_FACTOR) || 1
  });
  const p = await context.newPage();

  const minimalHTML = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 16px;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
    background: white;
  }
  table {
    border-collapse: collapse;
    width: max-content;
    max-width: 100%;
  }
  th, td {
    border: 1px solid #ddd;
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
  }
  thead th { position: sticky; top: 0; background: #f5f5f5; }
</style>
</head>
<body>
  ${tableHTML}
</body>
</html>`.trim();

  await p.setContent(minimalHTML, { waitUntil: 'load' });

  // Expand width to fit the table but cap to something reasonable (Playwright stitches vertically)
  const contentSize = await p.evaluate(() => ({
    w: Math.ceil(document.documentElement.scrollWidth),
    h: Math.ceil(document.documentElement.scrollHeight)
  }));
  await p.setViewportSize({
    width: Math.min(Math.max(contentSize.w + 32, 600), 2400),  // grow to fit, clamp 600–2400
    height: Math.min(Math.max(contentSize.h + 32, 400), 3000)  // grow to fit, clamp 400–3000
  });

  const png = await p.screenshot({ fullPage: true, type: 'png' });
  await context.close();
  return png;
}

async function run() {
  const urls = TARGET_URLS.split(',').map(s => s.trim()).filter(Boolean);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // We only use this context to visit the real page and extract the table HTML
  const navContext = await browser.newContext({
    viewport: { width: parseInt(VIEWPORT_W, 10), height: parseInt(VIEWPORT_H, 10) },
    deviceScaleFactor: parseFloat(DEVICE_SCALE_FACTOR) || 1
  });
  const page = await navContext.newPage();

  const dateTag = new Date().toISOString().slice(0, 10);

  try {
    for (const url of urls) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: parseInt(TIMEOUT_MS, 10) });

      // Give any late-loading data a moment (adjust if needed)
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      const res = await extractTableHTML(page);
      if (!res.ok) {
        throw new Error(`Could not locate a table on the page: ${res.reason || 'unknown'}`);
      }

      const png = await renderTableAndScreenshot(browser, res.html);
      const niceName = url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 80);
      const filename = `${niceName}-table-${dateTag}.png`;

      await slack.files.uploadV2({
        channel_id: CHANNEL_ID,
        filename,
        file: png,
        title: `${TITLE_PREFIX} • table only`,
        initial_comment: ADD_COMMENT === 'true'
          ? `Table snapshot of <${url}> — ${dateTag}`
          : undefined,
        filetype: 'png'
      });

      console.log(`Uploaded table-only screenshot for: ${url}`);
    }
  } finally {
    await navContext.close();
    await browser.close();
  }
}

run().catch(err => {
  console.error('Run failed:', err);
  process.exit(1);
});
