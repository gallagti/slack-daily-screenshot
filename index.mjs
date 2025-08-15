import { chromium, firefox, webkit } from 'playwright';
import { WebClient } from '@slack/web-api';

const {
  SLACK_BOT_TOKEN,
  CHANNEL_ID,
  TARGET_URLS = '',
  BROWSER = 'chromium',              // chromium | firefox | webkit
  VIEWPORT_W = '1366',
  VIEWPORT_H = '768',
  FULL_PAGE = 'true',                // "true" | "false"
  WAIT_UNTIL = 'networkidle',        // load | domcontentloaded | networkidle | commit
  WAIT_FOR_SELECTOR = '',            // e.g. '#chart' to be sure charts loaded
  ADD_COMMENT = 'true',              // "true" to add a Slack comment line
  TITLE_PREFIX = 'Daily screenshot',
  TIMEOUT_MS = '60000'               // per-page goto timeout
} = process.env;

if (!SLACK_BOT_TOKEN || !CHANNEL_ID || !TARGET_URLS) {
  console.error('Missing required env vars: SLACK_BOT_TOKEN, CHANNEL_ID, TARGET_URLS');
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);

function browserFor(name) {
  return { chromium, firefox, webkit }[name] || chromium;
}

async function screenshotOne(page, url) {
  await page.goto(url, { waitUntil: WAIT_UNTIL, timeout: parseInt(TIMEOUT_MS, 10) });

  if (WAIT_FOR_SELECTOR) {
    await page.waitForSelector(WAIT_FOR_SELECTOR, { timeout: parseInt(TIMEOUT_MS, 10) });
  }

  // Optional: page tweaks (hide cookie banners, etc.)
  // await page.locator('text=Accept').click({ timeout: 3000 }).catch(() => {});

  const buf = await page.screenshot({
    fullPage: FULL_PAGE === 'true',
    type: 'png'
  });
  return buf;
}

async function run() {
  const urls = TARGET_URLS.split(',').map(s => s.trim()).filter(Boolean);
  const bType = browserFor(BROWSER);
  const browser = await bType.launch({ args: ['--no-sandbox'] });
  const contextOpts = { viewport: { width: parseInt(VIEWPORT_W, 10), height: parseInt(VIEWPORT_H, 10) } };

  // Optional cookie-based auth support (paste JSON via secret STORAGE_STATE_JSON)
  if (process.env.STORAGE_STATE_JSON) {
    try {
      const storageState = JSON.parse(process.env.STORAGE_STATE_JSON);
      contextOpts.storageState = storageState;
    } catch (e) {
      console.warn('Could not parse STORAGE_STATE_JSON — continuing without it.');
    }
  }

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  const dateTag = new Date().toISOString().slice(0, 10);

  try {
    for (const url of urls) {
      const png = await screenshotOne(page, url);
      const niceName = url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 80);
      const filename = `${niceName}-${dateTag}.png`;

      await slack.files.uploadV2({
        channel_id: CHANNEL_ID,
        filename,
        file: png,
        title: `${TITLE_PREFIX} • ${url}`,
        initial_comment: ADD_COMMENT === 'true'
          ? `Here’s today’s snapshot of <${url}> (${dateTag})`
          : undefined
      });

      console.log(`Uploaded: ${url}`);
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
