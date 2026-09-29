// Finds the nintendo.com product page for each US game on the site that doesn't
// have one yet, and saves them in data/us/links.json as "chart|title": url.
// The site falls back to a store search link for any game not found here.
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
for (const [key, href] of Object.entries(links)) {
  const i = key.indexOf('|');
  if (score(key.slice(i + 1), key.slice(0, i), href) <= 0) { delete links[key]; dropped++; }
}
if (dropped) console.log(`Re-checking ${dropped} saved link(s) that looked wrong.`);

const wanted = new Map();
for (const day of Object.values(history.days || {})) {
  for (const [chart, list] of Object.entries(day.charts || {})) {
    for (const g of list || []) {
      const key = `${chart}|${g.title}`;
      if (!links[key] && !wanted.has(key)) wanted.set(key, { chart, title: g.title });
    }
  }
}
if (!wanted.size) {
  if (dropped) await fs.writeFile(OUT, JSON.stringify(links, null, 2) + '\n');
  console.log('Every US game already has a link.');
  process.exit(0);
}
console.log(`Looking up ${Math.min(wanted.size, MAX_PER_RUN)} of ${wanted.size} games without a link...`);

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
if (dryRun || (!found && !dropped)) process.exit(0);
const sorted = Object.fromEntries(Object.entries(links).sort(([a], [b]) => a.localeCompare(b)));
await fs.writeFile(OUT, JSON.stringify(sorted, null, 2) + '\n');
console.log(`Saved ${OUT}`);
