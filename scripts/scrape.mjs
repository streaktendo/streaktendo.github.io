// Reads the Nintendo Australia store's digital-download charts (Switch 1 and
// Switch 2) once and records today's top 10 for each in data/au/history.json.
//
//   node scripts/scrape.mjs            read both charts and save them
//   node scripts/scrape.mjs --dry-run  read both charts and print them, save nothing
//
// Optional: CHART_SELECTOR = CSS selector for the element that wraps the ranked
// list, if other product tiles on the page get picked up by mistake.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const CHARTS = [
  { id: 'switch1', label: 'Switch 1', url: 'https://store.nintendo.com.au/au/digital-downloads/charts?platform=switch' },
  { id: 'switch2', label: 'Switch 2', url: 'https://store.nintendo.com.au/au/digital-downloads/charts?platform=switch2' },
];
const CHART_SELECTOR = process.env.CHART_SELECTOR || '';
const TZ = 'America/Los_Angeles';
const DATA_FILE = path.resolve('data/au/history.json');
const DEBUG_DIR = path.resolve('debug');
const KEEP = 10;
const MIN_GAMES = 5;
const dryRun = process.argv.includes('--dry-run');

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

// The chart shows the rank in front of each name ("7 Mario Kart 8 Deluxe").
// Take that number as the real rank when it follows on from the previous one
// (the page sometimes has entries we can't read, so small gaps are allowed).
// Titles like "51 Worldwide Games" at rank 5 are left alone.
function splitRank(title, prev) {
  const m = title.match(/^#?(\d{1,3})[.):]?\s+(.+)$/);
  if (m) {
    const n = Number(m[1]);
    if (n > prev && n <= prev + 5) return { rank: n, title: m[2] };
  }
  return { rank: prev + 1, title };
}

// Store pages link a small cached thumbnail; the full-size original sits at the
// same path without the /cache/<id>/ part.
function fullSize(url) {
  return url ? url.replace(/\/cache\/[0-9a-f]+\//i, '/') : url;
}

// Saves a game's image into data/images once, and reuses it after that.
const IMAGE_DIR = path.resolve('data/au/art');
async function saveImage(context, url, title) {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'game';
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  const existing = (await fs.readdir(IMAGE_DIR)).find((f) => f.replace(/\.[^.]+$/, '') === slug);
  if (existing) return `data/au/art/${existing}`;
  if (!url) return null;
  if (dryRun) return fullSize(url);
  for (const candidate of [fullSize(url), url]) {
    try {
      const res = await context.request.get(candidate, { timeout: 30_000 });
      const type = res.headers()['content-type'] || '';
      if (!res.ok() || !type.startsWith('image/')) continue;
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('avif') ? 'avif' : 'jpg';
      await fs.writeFile(path.join(IMAGE_DIR, `${slug}.${ext}`), await res.body());
      return `data/au/art/${slug}.${ext}`;
    } catch { /* try the next one */ }
  }
  return null;
}

function cleanTitle(t) {
  return String(t || '').replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
}

// Runs inside the page. Tries the common store layout first, then looser fallbacks,
// and returns product names in the order they appear on screen.
function extract(scope) {
  const root = (scope && document.querySelector(scope)) || document;
  const junk = /^(add to|buy|view|learn more|shop|see more|pre-?order|\$|free$)/i;
  const pickers = [
    () => [...root.querySelectorAll('a.product-item-link')],
    () => [...root.querySelectorAll('.product-item, li.item.product, .product-card, [data-product-id]')]
      .map((el) => el.querySelector('a[href]')).filter(Boolean),
    () => [...root.querySelectorAll('[class*="product" i] a[href]')],
  ];
  for (const pick of pickers) {
    const seen = new Set();
    const out = [];
    for (const a of pick()) {
      const href = (a.href || '').split(/[?#]/)[0];
      if (!href || seen.has(href)) continue;
      const card = a.closest('.product-item, .product-card, li, article') || a;
      const nameEl = card.querySelector('.product-item-link, .product-item-name, .product-name, h2, h3, h4');
      const img = card.querySelector('img[alt]');
      const title =
        (nameEl && nameEl.innerText.trim()) ||
        a.innerText.trim() ||
        (a.getAttribute('title') || '').trim() ||
        (img && img.alt.trim()) || '';
      if (!title || title.length > 150 || junk.test(title)) continue;
      let image = '';
      const pic = card.querySelector('img');
      if (pic) {
        const set = pic.getAttribute('srcset') || pic.getAttribute('data-srcset') || '';
        const biggest = set ? set.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop() : '';
        image = pic.getAttribute('data-src') || pic.getAttribute('data-original') || pic.getAttribute('data-lazy') || biggest || pic.currentSrc || pic.src || '';
        if (image.startsWith('data:')) image = '';
        if (image) image = new URL(image, location.href).href;
      }
      seen.add(href);
      out.push({ title, url: href, image });
    }
    if (out.length >= 5) return out;
  }
  return [];
}

async function saveDebug(page, id, reason) {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await fs.writeFile(path.join(DEBUG_DIR, `${id}-reason.txt`), reason + '\n');
    await fs.writeFile(path.join(DEBUG_DIR, `${id}-page.html`), await page.content());
    await page.screenshot({ path: path.join(DEBUG_DIR, `${id}-screenshot.png`), fullPage: true });
  } catch (e) {
    console.error('Could not save debug snapshot:', e.message);
  }
}

async function readChart(context, chart) {
  const page = await context.newPage();
  try {
    console.log(`\nReading ${chart.label}: ${chart.url}`);
    await page.goto(chart.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('a.product-item-link, .product-item, .product-card, [class*="product" i] a[href]', { timeout: 45_000 }).catch(() => {});
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(700); }
    await page.waitForTimeout(1500);

    // Work through the list in order so each rank is read relative to the one before it.
    let prev = 0;
    const games = [];
    for (const g of await page.evaluate(extract, CHART_SELECTOR)) {
      const r = splitRank(cleanTitle(g.title), prev);
      if (!r.title) continue;
      games.push({ ...r, url: g.url, imageUrl: g.image });
      prev = r.rank;
    }

    if (games.length < MIN_GAMES) {
      await saveDebug(page, chart.id, `Found only ${games.length} games.`);
      console.error(`${chart.label}: found only ${games.length} games. Saved a debug snapshot.`);
      return null;
    }
    const top = games.slice(0, KEEP);
    for (const g of top) g.image = await saveImage(context, g.imageUrl, g.title);
    top.forEach((g) => console.log(`${String(g.rank).padStart(2)}. ${g.title}${g.image ? '' : '   (no image found)'}`));
    return top;
  } catch (err) {
    await saveDebug(page, chart.id, String(err && err.message || err));
    console.error(`${chart.label}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'en-AU',
    viewport: { width: 1366, height: 1600 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  });

  const record = { capturedAt: new Date().toISOString(), no1: {}, charts: {} };
  try {
    for (const chart of CHARTS) {
      const top = await readChart(context, chart);
      if (top) { record.charts[chart.id] = top; record.no1[chart.id] = top[0].title; }
    }
  } finally {
    await browser.close();
  }

  const got = Object.keys(record.charts);
  console.log(`\n${today}: ` + CHARTS.map((c) => `${c.label} #1 = ${record.no1[c.id] ?? '(failed)'}`).join(' | '));
  if (!got.length) {
    console.error('Both charts failed. Nothing saved. Download the debug-snapshot from this run.');
    process.exit(1);
  }
  if (dryRun) { console.log('Dry run: nothing saved.'); return; }

  const history = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  history.days = history.days || {};
  history.days[today] = record;
  history.images = history.images || {};
  for (const list of Object.values(record.charts)) {
    for (const g of list) if (g.image && !g.image.startsWith('http')) history.images[g.title] = g.image;
  }
  history.days = Object.fromEntries(Object.entries(history.days).sort(([a], [b]) => a.localeCompare(b)));
  history.updatedAt = record.capturedAt;
  await fs.writeFile(DATA_FILE, JSON.stringify(history, null, 2) + '\n');
  console.log(`Saved ${today} to data/au/history.json`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
