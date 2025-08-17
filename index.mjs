import { chromium } from 'playwright';
import { WebClient } from '@slack/web-api';

const {
  SLACK_BOT_TOKEN,
  CHANNEL_ID,
  TARGET_URLS = '',
  TIMEOUT_MS = '90000',
  VIEWPORT_W = '1366',          // used for loading pages; final image is clipped to the table
  VIEWPORT_H = '900',
  DEVICE_SCALE_FACTOR = '2',
  TITLE_PREFIX = 'Daily screenshot',
  ADD_COMMENT = 'true',
  // Appearance for the re-rendered table
  DARK_MODE = 'false',          // 'true' to enable dark styling
  DARK_BG = '#0b0f14',          // page background
  DARK_SURFACE = '#121821',     // table background
  DARK_TEXT = '#e9eef5',        // primary text
  DARK_MUTED = '#a9b4c0',       // secondary text / borders
  DARK_HEADER = '#1a2330'       // thead background
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

    // Prefer tables within common content wrappers
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

// 2) Render just that table in a clean page and screenshot exactly the table box (no whitespace).
async function renderTableAndScreenshot(browser, tableHTML) {
  const context = await browser.newContext({
    viewport: { width: parseInt(VIEWPORT_W, 10), height: parseInt(VIEWPORT_H, 10) },
    deviceScaleFactor: parseFloat(DEVICE_SCALE_FACTOR) || 1
  });
  const p = await context.newPage();

  const dark = (DARK_MODE || '').toLowerCase() === 'true';

  const minimalHTML = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  html, body { margin: 0; padding: 0; }
  body {
    background: ${dark ? DARK_BG : '#ffffff'};
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, "Helvetica Neue", Arial, "Noto Sans";
  }
  table {
    border-collapse: collapse;
    background: ${dark ? DARK_SURFACE : '#ffffff'};
    color: ${dark ? DARK_TEXT : '#111827'};
  }
  th, td {
    border: 1px solid ${dark ? DARK_MUTED : '#ddd'};
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
  }
  thead th {
    background: ${dark ? DARK_HEADER : '#f5f5f5'};
    color: ${dark ? DARK_TEXT : '#111827'};
  }
</style>
</head>
<body>
  ${tableHTML}
</body>
</html>`.trim();

  await p.setContent(minimalHTML, { waitUntil: 'load' });

  // Make sure the table is present
  const table = await p.waitForSelector('table', { state: 'visible', timeout: 15000 });

  // Get precise bounding box of the table (CSS pixels)
  let box = await table.boundingBox();
  if (!box) {
    // Fallback via $eval if boundingBox is null for any reason
    box = await p.$eval('table', el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  }

  // Round to integer pixels & clamp to >=1px width/height
  box.x = Math.max(0, Math.floor(box.x));
  box.y = Math.max(0, Math.floor(box.y));
  box.width = Math.max(1, Math.ceil(box.width));
  box.height = Math.max(1, Math.ceil(box.height));

  // Screenshot exactly that rectangle
  const png = await p.screenshot({ type: 'png', clip: box });

  await context.close();
  return png;
}

async function run() {
  const urls = TARGET_URLS.split(',').map(s => s.trim()).filter(Boolean);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // Navigation context to visit the real page and extract the table HTML
  const navContext = await browser.newContext({
    viewport: { width: parseInt(VIEWPORT_W, 10), height: parseInt(VIEWPORT_H, 10) },
    deviceScaleFactor: parseFloat(DEVICE_SCALE_FACTOR) || 1
  });
  const page = await navContext.newPage();

  const dateTag = new Date().toISOString().slice(0, 10);

  try {
    for (const url of urls) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: parseInt(TIMEOUT_MS, 10) });
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
        title: `${TITLE_PREFIX} • table only${(DARK_MODE || '').toLowerCase() === 'true' ? ' • dark' : ''}`,
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
