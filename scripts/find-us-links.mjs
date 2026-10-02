// Finds the nintendo.com product page for each US game on the site that doesn't
// have one yet, and saves them in data/us/links.json as "chart|title": url.
// The site falls back to a store search link for any game not found here.
//
// It also saves a picture from the product page for any game that has no picture
// yet (games that never appeared in the app's lists, e.g. ones only in estimated
// days), into data/us/web-art/ and data/us/web-art.json as "title": path.
//
//   node scripts/find-us-links.mjs            look up and save
//   node scripts/find-us-links.mjs --dry-run  look up and print only

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const HISTORY = 'data/us/history.json';
const OUT = 'data/us/links.json';
const MAX_PER_RUN = 40;
const dryRun = process.argv.includes('--dry-run');

const norm = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[™®©]/g, '').replace(/[’']/g, '').replace(/\+/g, ' plus ').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// nintendo.com product addresses end in "-switch" (Switch 1) or "-switch-2" (Switch 2),
// e.g. /store/products/mario-kart-8-deluxe-switch/. Score how well an address fits a game:
// right platform, not an amiibo or other merchandise, and a name as close as possible.
function score(title, chart, href) {
  const slug = (String(href).match(/\/products\/([^/?#]+)\/?$/) || [])[1] || '';
  const suffix = chart === 'switch2' ? /-switch-2$/ : /-switch$/;
  if (!suffix.test(slug)) return 0;
  if (/amiibo/.test(slug) && !/amiibo/i.test(title)) return 0;
  // Some games are sold in separate language versions (e.g. french-pokemon-firered-version-switch).
  // Never pick a non-English one unless the title asks for it.
  const lang = slug.match(/^(french|spanish|german|italian|japanese|korean|chinese|dutch|portuguese|russian)-/);
  if (lang && !new RegExp(lang[1], 'i').test(title)) return 0;
  const base = slug.replace(suffix, '').replace(/-/g, ' ');
  const want = norm(title);
  if (!want) return 0;
  if (base === want) return 100;
  if (base.startsWith(want + ' ')) return 60 - Math.min(40, base.length - want.length);
  if (want.startsWith(base + ' ')) return 50 - Math.min(40, want.length - base.length);
  if (base.includes(want)) return 30 - Math.min(20, (base.length - want.length) / 2);
  return 0;
}

const history = JSON.parse(await fs.readFile(HISTORY, 'utf8'));
let links = {};
try { links = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* first run */ }

// Drop saved links that don't pass the current checks, so they get looked up again.
let dropped = 0;
const droppedTitles = new Set();
for (const [key, href] of Object.entries(links)) {
  const i = key.indexOf('|');
  if (score(key.slice(i + 1), key.slice(0, i), href) <= 0) { delete links[key]; dropped++; droppedTitles.add(key.slice(i + 1)); }
}
if (dropped) console.log(`Re-checking ${dropped} saved link(s) that looked wrong.`);

// Also cover games that only appear in days estimated from weekly charts.
let estimated = { days: {} };
try { estimated = JSON.parse(await fs.readFile('data/us/estimated.json', 'utf8')); } catch { /* none yet */ }
for (const day of Object.values(estimated.days || {})) {
  day.charts = Object.fromEntries(Object.entries(day.no1 || {}).map(([chart, title]) => [chart, [{ title }]]));
}

const wanted = new Map();
for (const day of [...Object.values(history.days || {}), ...Object.values(estimated.days || {})]) {
  for (const [chart, list] of Object.entries(day.charts || {})) {
    for (const g of list || []) {
      const key = `${chart}|${g.title}`;
      if (!links[key] && !wanted.has(key)) wanted.set(key, { chart, title: g.title });
    }
  }
}
if (!wanted.size) console.log('Every US game already has a link.');
else console.log(`Looking up ${Math.min(wanted.size, MAX_PER_RUN)} of ${wanted.size} games without a link...`);

const browser = await chromium.launch();
const page = await browser.newPage({
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
});
let found = 0;
try {
  for (const [key, { chart, title }] of [...wanted].slice(0, MAX_PER_RUN)) {
    const url = `https://www.nintendo.com/us/search/#q=${encodeURIComponent(title)}&p=1&cat=gme&sort=df`;
    try {
      // Load a blank page first: the search URLs differ only after the "#", so without
      // this the browser keeps showing the previous search's results.
      await page.goto('about:blank');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('a[href*="/store/products/"]', { timeout: 30_000 });
      await page.waitForTimeout(3000);
      const hrefs = await page.$$eval('a[href*="/store/products/"]', (as) => as.map((a) => a.href.split(/[?#]/)[0]));
      let best = null, bestScore = 0;
      for (const href of new Set(hrefs)) {
        const sc = score(title, chart, href);
        if (sc > bestScore) { best = href; bestScore = sc; }
      }
      if (best) {
        links[key] = best;
        found++;
        console.log(`  found   ${title} (${chart}) -> ${best}`);
      } else {
        console.log(`  no match ${title} (${chart})`);
      }
    } catch (e) {
      console.log(`  failed  ${title}: ${e.message.split('\n')[0]}`);
    }
  }
} finally {
  await browser.close();
}

console.log(`Found ${found} new link(s).`);
if (!dryRun && (found || dropped)) {
  const sorted = Object.fromEntries(Object.entries(links).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(OUT, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Saved ${OUT}`);
}
await savePictures();

// ---------------------------------------------------------------- pictures
async function savePictures() {
  const ART_DIR = 'data/us/web-art';
  const ART_INDEX = 'data/us/web-art.json';
  let webArt = {};
  try { webArt = JSON.parse(await fs.readFile(ART_INDEX, 'utf8')); } catch { /* first run */ }
  // A picture taken from a page we've just rejected (e.g. a French version) gets replaced too.
  let artChanged = false;
  for (const t of droppedTitles) for (const k of [t, 'switch1|' + t, 'switch2|' + t]) if (webArt[k]) { delete webArt[k]; artChanged = true; }
  // Pictures are tracked per platform ("switch1|Title"), since the two versions of a game
  // can have different art. Older entries keyed by title alone still count for both.
  const haveArt = new Set([...Object.keys(history.images || {}), ...Object.keys(webArt)]);
  for (const day of Object.values(history.days || {})) {
    for (const [chart, list] of Object.entries(day.charts || {})) for (const g of list || []) if (g.image) haveArt.add(chart + '|' + g.title);
  }
  // Games with a store link but no picture for that platform yet.
  const need = new Map();
  for (const [key, url] of Object.entries(links)) {
    const title = key.slice(key.indexOf('|') + 1);
    if (!haveArt.has(key) && !haveArt.has(title) && !need.has(key)) need.set(key, url);
  }
  if (!need.size) {
    if (artChanged && !dryRun) await fs.writeFile(ART_INDEX, JSON.stringify(Object.fromEntries(Object.entries(webArt).sort()), null, 2) + '\n');
    console.log('Every US game already has a picture.');
    return;
  }
  console.log(`Fetching pictures for ${need.size} game(s) without one...`);
  await fs.mkdir(ART_DIR, { recursive: true });
  const slug = (t) => norm(t).replace(/ /g, '-').slice(0, 80) || 'game';
  const browser2 = await chromium.launch();
  const page2 = await browser2.newPage({ locale: 'en-US', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' });
  let saved = 0;
  try {
    for (const [key, url] of need) {
      const title = key.slice(key.indexOf('|') + 1), chart = key.slice(0, key.indexOf('|'));
      try {
        await page2.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page2.waitForTimeout(2000);
        const imgUrl = await page2.evaluate(() => {
          const og = document.querySelector('meta[property="og:image"]')?.content;
          if (og) return og;
          const tw = document.querySelector('meta[name="twitter:image"]')?.content;
          return tw || null;
        });
        if (!imgUrl) { console.log(`  no picture on page  ${title}`); continue; }
        const res = await page2.request.get(new URL(imgUrl, url).href, { timeout: 30_000 });
        const type = res.headers()['content-type'] || '';
        if (!res.ok() || !type.startsWith('image/')) { console.log(`  download failed     ${title}`); continue; }
        const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('avif') ? 'avif' : 'jpg';
        const path = `${ART_DIR}/${slug(title)}${chart === 'switch1' ? '-switch1' : ''}.${ext}`;
        if (!dryRun) await fs.writeFile(path, await res.body());
        webArt[key] = path;
        saved++;
        console.log(`  picture saved       ${title} -> ${path}`);
      } catch (e) {
        console.log(`  failed              ${title}: ${e.message.split('\n')[0]}`);
      }
    }
  } finally {
    await browser2.close();
  }
  if (!dryRun && (saved || artChanged)) {
    await fs.writeFile(ART_INDEX, JSON.stringify(Object.fromEntries(Object.entries(webArt).sort()), null, 2) + '\n');
    console.log(`Saved ${ART_INDEX}`);
  }
}
