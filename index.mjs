import { chromium } from 'playwright';
import { WebClient } from '@slack/web-api';

const {
  SLACK_BOT_TOKEN,
  CHANNEL_ID,
  TARGET_URLS = '',
  TIMEOUT_MS = '60000',
  VIEWPORT_W = '1366',
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

// Find the smallest reasonable ancestor element that CONTAINS the "Stat of the Day" heading
async function findSotDContainerHandle(page) {
  return await page.evaluateHandle(() => {
    const HEADING_TEXT_RE = /stat of the day/i;

    // 1) find the heading node
    const allHeadings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    const heading = allHeadings.find(h => HEADING_TEXT_RE.test(h.textContent || ''));
    if (!heading) return null;

    // 2) walk up to a good wrapper (avoid BODY/HTML; prefer main/article/section/.container/.content)
    const preferredSelectors = ['main', 'article', 'section', '#content', '.content', '.container'];
    let el = heading;

    // helper checks
    const isGoodSize = (node) => {
      const r = node.getBoundingClientRect();
      return r.width > 300 && r.height > 150;
    };

    // prefer first ancestor that matches a preferred selector and is reasonably sized
    let cur = heading;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (isGoodSize(cur) && preferredSelectors.some(sel => cur.matches?.(sel))) {
        el = cur;
        break;
      }
      cur = cur.parentElement;
    }

    // if nothing matched, climb until we get a reasonable sized block (but not body/html)
    if (el === heading) {
      cur = heading.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        const style = getComputedStyle(cur);
        const isInline = style.display === 'inline';
        if (!isInline && isGoodSize(cur)) { el = cur; break; }
        cur = cur.parentElement;
      }
    }

    return el || heading;
  });
}

async function screenshotSotD(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: parseInt(TIMEOUT_MS, 10) });
  // small settle window for any late assets
  await page.waitForLoadState('networkidle', { timeout: parseInt(TIMEOUT_MS, 10) });

  const handle = await findSotDContainerHandle(page);
  if (!handle) throw new Error('Could not find the Stat of the Day container.');

  const png = await handle.screenshot({ type: 'png' });
  await handle.dispose();
  return png;
}

async function run() {
  const urls = TARGET_URLS.split(',').map(s => s.trim()).filter(Boolean);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: parseInt(VIEWPORT_W, 10), height: parseInt(VIEWPORT_H, 10) },
    deviceScaleFactor: parseFloat(DEVICE_SCALE_FACTOR) || 1
  });
  const page = await context.newPage();
  const dateTag = new Date().toISOString().slice(0, 10);

  try {
    for (const url of urls) {
      const png = await screenshotSotD(page, url);
      const niceName = url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 80);
      const filename = `${niceName}-sotd-${dateTag}.png`;

      await slack.files.uploadV2({
        channel_id: CHANNEL_ID,
        filename,
        file: png,
        title: `${TITLE_PREFIX} • ${url} • Stat of the Day`,
        initial_comment: ADD_COMMENT === 'true'
          ? `Snapshot of <${url}> — ${dateTag}`
          : undefined
      });

      console.log(`Uploaded: ${url} (SotD container)`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch(err => {
  console.error('Run failed:', err);
  process.exit(1);
});
