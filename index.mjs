import { chromium } from 'playwright';
import { WebClient } from '@slack/web-api';

const {
  SLACK_BOT_TOKEN,
  CHANNEL_ID,
  TARGET_URLS = '',
  TIMEOUT_MS = '60000',
  VIEWPORT_W = '1366',
  VIEWPORT_H = '900',
  DEVICE_SCALE_FACTOR = '2',           // crisp text
  TITLE_PREFIX = 'Daily screenshot',
  ADD_COMMENT = 'true'
} = process.env;

if (!SLACK_BOT_TOKEN || !CHANNEL_ID || !TARGET_URLS) {
  console.error('Missing required env vars: SLACK_BOT_TOKEN, CHANNEL_ID, TARGET_URLS');
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);

// Heuristic: pick the centered, sizeable block container (the “one thing”)
async function getCenteredContainerHandle(page) {
  return await page.evaluateHandle(() => {
    const isBlock = el => {
      const s = getComputedStyle(el);
      return s.display !== 'inline' && s.visibility !== 'hidden';
    };
    const bigEnough = el => {
      const r = el.getBoundingClientRect();
      return r.width > 200 && r.height > 200;    // tweak if needed
    };

    // element under the exact viewport center
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    if (!el) return null;

    // climb to a good container (stop at body/html)
    while (el && el.parentElement && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
      if (isBlock(el) && bigEnough(el)) break;
      el = el.parentElement;
    }

    // If we landed on BODY/HTML, try common wrappers as a fallback
    if (el && (el.tagName === 'BODY' || el.tagName === 'HTML')) {
      el = document.querySelector('main, #main, .container, #content, .content, article') || document.body;
    }

    return el;
  });
}

async function screenshotMainThing(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: parseInt(TIMEOUT_MS, 10) });

  // Make sure layout has settled a bit
  await page.waitForLoadState('networkidle', { timeout: parseInt(TIMEOUT_MS, 10) });

  const handle = await getCenteredContainerHandle(page);
  if (!handle) throw new Error('Could not locate the centered container.');

  // Ensure it’s in view (Playwright will scroll for element screenshots)
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
      const png = await screenshotMainThing(page, url);
      const niceName = url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 80);
      const filename = `${niceName}-centered-${dateTag}.png`;

      await slack.files.uploadV2({
        channel_id: CHANNEL_ID,
        filename,
        file: png,
        title: `${TITLE_PREFIX} • ${url} • centered`,
        initial_comment: ADD_COMMENT === 'true'
          ? `Snapshot of <${url}> (centered content) — ${dateTag}`
          : undefined
      });

      console.log(`Uploaded: ${url} (centered)`);
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
