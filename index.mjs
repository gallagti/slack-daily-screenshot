import { chromium } from 'playwright';
import sharp from 'sharp';
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
  // tune these if needed
  MIN_CONTAINER_WIDTH = '300',
  MIN_CONTAINER_HEIGHT = '150',
  PADDING_TOP = '8',     // px extra above the heading
  PADDING_SIDES = '8',   // px
  PADDING_BOTTOM = '12'  // px
} = process.env;

if (!SLACK_BOT_TOKEN || !CHANNEL_ID || !TARGET_URLS) {
  console.error('Missing required env vars: SLACK_BOT_TOKEN, CHANNEL_ID, TARGET_URLS');
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);

/**
 * Returns metrics needed for cropping:
 *  - deviceScaleFactor
 *  - rect: { x, y, width, height } in **CSS pixels** of the area to crop
 * Strategy:
 *  1) Find the heading h1–h6 containing "Stat of the Day" (case-insensitive).
 *  2) Find a reasonable ancestor container (prefer main/article/section/.container/#content/.content)
 *  3) Build a rectangle that starts slightly above the heading and extends to the bottom of that container,
 *     with small side padding.
 */
async function getCropRect(page) {
  return await page.evaluate(
    ({ MIN_CONTAINER_WIDTH, MIN_CONTAINER_HEIGHT, PADDING_TOP, PADDING_SIDES, PADDING_BOTTOM }) => {
      const HEADING_RE = /stat of the day/i;
      const minW = parseInt(MIN_CONTAINER_WIDTH, 10);
      const minH = parseInt(MIN_CONTAINER_HEIGHT, 10);
      const padTop = parseInt(PADDING_TOP, 10);
      const padSides = parseInt(PADDING_SIDES, 10);
      const padBottom = parseInt(PADDING_BOTTOM, 10);

      // 1) locate heading
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      const heading = headings.find(h => HEADING_RE.test(h.textContent || ''));
      if (!heading) return { ok: false, reason: 'heading_not_found' };

      // 2) choose container
      const preferred = ['main', 'article', 'section', '#content', '.content', '.container'];
      const goodSize = el => {
        const r = el.getBoundingClientRect();
        return r.width >= minW && r.height >= minH;
      };
      const blocky = el => {
        const s = getComputedStyle(el);
        return s.display !== 'inline' && s.visibility !== 'hidden';
      };

      // climb up preferring known wrappers
      let container = heading;
      let cur = heading;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        if (goodSize(cur) && blocky(cur) && preferred.some(sel => cur.matches?.(sel))) {
          container = cur;
          break;
        }
        cur = cur.parentElement;
      }
      // fallback: pick the first sizable block ancestor
      if (container === heading) {
        cur = heading.parentElement;
        while (cur && cur !== document.body && cur !== document.documentElement) {
          if (goodSize(cur) && blocky(cur)) { container = cur; break; }
          cur = cur.parentElement;
        }
        if (!cur) container = heading; // absolute fallback
      }

      const hb = heading.getBoundingClientRect();
      const cb = container.getBoundingClientRect();

      // crop from a bit above the heading, to the bottom of the container
      const x = Math.max(0, Math.floor(cb.left) - padSides);
      const y = Math.max(0, Math.floor(hb.top) - padTop);
      const right = Math.ceil(cb.right) + padSides;
      const bottom = Math.ceil(cb.bottom) + padBottom;

      const width = Math.max(1, Math.floor(right - x));
      const height = Math.max(1, Math.floor(bottom - y));

      return {
        ok: true,
        rect: { x, y, width, height },
        dpr: window.devicePixelRatio || 1
      };
    },
    { MIN_CONTAINER_WIDTH, MIN_CONTAINER_HEIGHT, PADDING_TOP, PADDING_SIDES, PADDING_BOTTOM }
  );
}

// Convert CSS pixel rect → device pixels and crop the full-page PNG buffer
async function cropPng(fullPngBuffer, rectCss, dpr) {
  const rectPx = {
    left: Math.max(0, Math.round(rectCss.x * dpr)),
    top: Math.max(0, Math.round(rectCss.y * dpr)),
    width: Math.max(1, Math.round(rectCss.width * dpr)),
    height: Math.max(1, Math.round(rectCss.height * dpr))
  };
  return await sharp(fullPngBuffer).extract(rectPx).png().toBuffer();
}

async function captureAndUpload(url, page) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: parseInt(TIMEOUT_MS, 10) });
  await page.waitForLoadState('networkidle', { timeout: parseInt(TIMEOUT_MS, 10) });

  // 1) compute crop rectangle
  const info = await getCropRect(page);
  if (!info.ok) throw new Error(`Could not locate region: ${info.reason}`);

  // 2) take full-page screenshot (in device pixels)
  const fullPng = await page.screenshot({ fullPage: true, type: 'png' });

  // 3) crop to the rectangle (convert CSS px to device px using DPR)
  const cropped = await cropPng(fullPng, info.rect, info.dpr || parseFloat(DEVICE_SCALE_FACTOR) || 1);

  // 4) upload
  const dateTag = new Date().toISOString().slice(0, 10);
  const niceName = url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 80);
  const filename = `${niceName}-sotd-after-heading-${dateTag}.png`;

  await slack.files.uploadV2({
    channel_id: CHANNEL_ID,
    filename,
    file: cropped,
    title: `${TITLE_PREFIX} • ${url} • after heading`,
    initial_comment: ADD_COMMENT === 'true'
      ? `Snapshot of <${url}> — ${dateTag}`
      : undefined,
    // (optional) filetype helps Slack label it as an image
    filetype: 'png'
  });

  console.log(`Uploaded cropped image for: ${url}`);
}

async function run() {
  const urls = TARGET_URLS.split(',').map(s => s.trim()).filter(Boolean);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: parseInt(VIEWPORT_W, 10), height: parseInt(VIEWPORT_H, 10) },
    deviceScaleFactor: parseFloat(DEVICE_SCALE_FACTOR) || 1
  });
  const page = await context.newPage();

  try {
    for (const url of urls) {
      await captureAndUpload(url, page);
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
