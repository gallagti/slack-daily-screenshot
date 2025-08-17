import { chromium } from 'playwright';
import { WebClient } from '@slack/web-api';

const {
  SLACK_BOT_TOKEN,
  CHANNEL_ID,
  TARGET_URLS = '',
  TIMEOUT_MS = '90000',
  VIEWPORT_W = '1366',
  VIEWPORT_H = '900',
  DEVICE_SCALE_FACTOR = '2',
  TITLE_PREFIX = 'Daily screenshot',
  ADD_COMMENT = 'true',

  // Appearance
  DARK_BG = '#0b0f14',
  DARK_SURFACE = '#121821',
  DARK_TEXT = '#ffffff',
  DARK_MUTED = '#3a4759',
  DARK_HEADER = '#1a2330',

  // Padding (around the table in the final image)
  PAD_AROUND = '96',          // ~1 inch ≈ 96px

  // Safety caps for auto-resize (you can raise if you have giant tables)
  MAX_OUT_W = '3600',
  MAX_OUT_H = '10000'
} = process.env;

if (!SLACK_BOT_TOKEN || !CHANNEL_ID || !TARGET_URLS) {
  console.error('Missing required env vars: SLACK_BOT_TOKEN, CHANNEL_ID, TARGET_URLS');
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);

// 1) Extract the largest visible table HTML from the real page (and strip links)
async function extractTableHTML(page) {
  return await page.evaluate(() => {
    const isVisible = (el) => {
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 5 && r.height > 5;
    };
    const candidates = [
      ...document.querySelectorAll('main table, #content table, .content table, .container table, article table, section table, body table')
    ].filter(isVisible);
    if (!candidates.length) return { ok: false, reason: 'no_table_found' };

    // Pick largest by area
    let best = candidates[0], bestArea = 0;
    for (const t of candidates) {
      const r = t.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = t; bestArea = area; }
    }

    // Strip links (render as plain text)
    best.querySelectorAll('a').forEach(a => {
      const span = document.createElement('span');
      span.textContent = a.textContent;
      a.replaceWith(span);
    });

    return { ok: true, html: best.outerHTML };
  });
}

// 2) Re-render just that table, auto-resize viewport to fit it, then clip to table + padding
async function renderTableAndScreenshot(browser, tableHTML) {
  const context = await browser.newContext({
    viewport: { width: parseInt(VIEWPORT_W, 10), height: parseInt(VIEWPORT_H, 10) },
    deviceScaleFactor: parseFloat(DEVICE_SCALE_FACTOR) || 1
  });
  const p = await context.newPage();

  // Note: no body padding—padding is added in the clip so it’s guaranteed visible even when we resize.
  const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: ${DARK_BG}; }
  body {
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, "Helvetica Neue", Arial;
  }
  table {
    border-collapse: collapse;
    background: ${DARK_SURFACE};
    color: ${DARK_TEXT};
    font-size: 22px;               /* body text */
    line-height: 1.5;
    margin: 0 auto;                /* center horizontally */
  }
  th, td {
    border: 1px solid ${DARK_MUTED};
    padding: 10px 16px;
    text-align: left;
    vertical-align: middle;
  }
  thead th {
    background: ${DARK_HEADER};
    color: ${DARK_TEXT};
    font-weight: 700;
    font-size: 24px;               /* header text */
  }
  /* force all text white, remove link styling just in case */
  * { color: ${DARK_TEXT} !important; text-decoration: none !important; }
</style>
</head>
<body>
  ${tableHTML}
</body>
</html>`.trim();

  await p.setContent(html, { waitUntil: 'load' });

  // Wait for the table and get its bounding box (CSS px)
  const table = await p.waitForSelector('table', { state: 'visible', timeout: 15000 });
  let box = await table.boundingBox();
  if (!box) {
    box = await p.$eval('table', el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  }

  // Expand clip by PAD_AROUND on all sides
  const PAD = Math.max(0, parseInt(PAD_AROUND, 10) || 0);
  const clip = {
    x: Math.max(0, Math.floor(box.x - PAD)),
    y: Math.max(0, Math.floor(box.y - PAD)),
    width: Math.max(1, Math.ceil(box.width + 2 * PAD)),
    height: Math.max(1, Math.ceil(box.height + 2 * PAD))
  };

  // Ensure the viewport is large enough to fully cover the clip region
  const needW = clip.x + clip.width + 2;   // a hair extra
  const needH = clip.y + clip.height + 2;

  const maxW = parseInt(MAX_OUT_W, 10) || 3600;
  const maxH = parseInt(MAX_OUT_H, 10) || 10000;

  const newW = Math.min(Math.max(needW, parseInt(VIEWPORT_W, 10)), maxW);
  const newH = Math.min(Math.max(needH, parseInt(VIEWPORT_H, 10)), maxH);

  await p.setViewportSize({ width: newW, height: newH });

  // Re-measure after resize (layout can shift slightly)
  const box2 = await table.boundingBox();
  const clip2 = {
    x: Math.max(0, Math.floor((box2?.x ?? box.x) - PAD)),
    y: Math.max(0, Math.floor((box2?.y ?? box.y) - PAD)),
    width: Math.max(1, Math.ceil((box2?.width ?? box.width) + 2 * PAD)),
    height: Math.max(1, Math.ceil((box2?.height ?? box.height) + 2 * PAD))
  };

  const png = await p.screenshot({ type: 'png', clip: clip2 });

  await context.close();
  return png;
}

async function run() {
  const urls = TARGET_URLS.split(',').map(s => s.trim()).filter(Boolean);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // Navigate original page just to extract the table HTML
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
      if (!res.ok) throw new Error(`Could not locate a table: ${res.reason}`);

      const png = await renderTableAndScreenshot(browser, res.html);
      const niceName = url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 80);
      const filename = `${niceName}-table-${dateTag}.png`;

      await slack.files.uploadV2({
        channel_id: CHANNEL_ID,
        filename,
        file: png,
        title: `${TITLE_PREFIX} • table only • dark`,
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
