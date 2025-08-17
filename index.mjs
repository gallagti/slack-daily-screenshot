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
  ADD_COMMENT = 'true'
} = process.env;

if (!SLACK_BOT_TOKEN || !CHANNEL_ID || !TARGET_URLS) {
  console.error('Missing required env vars: SLACK_BOT_TOKEN, CHANNEL_ID, TARGET_URLS');
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);

// Build an explicit clip rect from the heading to the bottom-of-content link.
async function screenshotStatOnly(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: parseInt(TIMEOUT_MS, 10) });

  // 1) Find the heading and the bottom marker link(s)
  const heading = page.getByText(/PSD\s+Stat\s+of\s+the\s+Day/i).first();
  await heading.waitFor({ state: 'visible', timeout: parseInt(TIMEOUT_MS, 10) });
  const hb = await heading.boundingBox();
  if (!hb) throw new Error('Heading bbox not found');

  // Prefer “Stat of the Day List”, fall back to “Link to Today’s Stat”
  let bottomLocator = page.getByText(/Stat of the Day List/i).first();
  if (await bottomLocator.count() === 0) {
    bottomLocator = page.getByText(/Link to Today/i).first();
  }
  await bottomLocator.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  let bottomBox = await bottomLocator.boundingBox();

  // 2) Also detect the central content column to constrain left/right
  // Try common wrappers; fall back to viewport width.
  const columnLocator = page.locator('main, #content, .content, .container').first();
  let cb = await columnLocator.boundingBox();

  // 3) Page dimensions (in CSS px) so our clip doesn’t overflow
  const { pageW, pageH } = await page.evaluate(() => ({
    pageW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    pageH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
  }));

  // 4) Build the clip rectangle (CSS pixels)
  const PADDING_TOP = 8;
  const PADDING_SIDE = 8;
  const PADDING_BOTTOM = 12;

  const left = Math.max(0, Math.floor((cb?.x ?? 0)) - PADDING_SIDE);
  const right = Math.min(pageW, Math.ceil((cb ? cb.x + cb.width : pageW)) + PADDING_SIDE);
  const top = Math.max(0, Math.floor(hb.y) - PADDING_TOP);

  // If we didn’t find a bottom link, cap to the column bottom; else to the link’s top.
  const bottomCandidate = bottomBox ? bottomBox.y : (cb ? cb.y + cb.height : pageH);
  const bottom = Math.min(pageH, Math.ceil(bottomCandidate) + PADDING_BOTTOM);

  const clip = {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };

  // 5) Take a clipped screenshot (this is a real bitmap crop from the page)
  const png = await page.screenshot({ type: 'png', clip });
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
      const png = await screenshotStatOnly(page, url);
      const niceName = url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 80);
      const filename = `${niceName}-sotd-cropped-${dateTag}.png`;

      await slack.files.uploadV2({
        channel_id: CHANNEL_ID,
        filename,
        file: png,
        title: `${TITLE_PREFIX} • ${url} • SotD cropped`,
        initial_comment: ADD_COMMENT === 'true'
          ? `Snapshot of <${url}> — ${dateTag}`
          : undefined,
        filetype: 'png'
      });

      console.log(`Uploaded cropped image for: ${url}`);
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
