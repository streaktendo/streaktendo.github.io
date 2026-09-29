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
  .replace(/[™®©]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const platformOf = (text) => /switch[\s_-]*2/i.test(text) ? 'switch2' : /switch/i.test(text) ? 'switch1' : null;

const history = JSON.parse(await fs.readFile(HISTORY, 'utf8'));
let links = {};
try { links = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* first run */ }

const wanted = new Map();
for (const day of Object.values(history.days || {})) {
  for (const [chart, list] of Object.entries(day.charts || {})) {
    for (const g of list || []) {
      const key = `${chart}|${g.title}`;
      if (!links[key] && !wanted.has(key)) wanted.set(key, { chart, title: g.title });
    }
  }
}
if (!wanted.size) { console.log('Every US game already has a link.'); process.exit(0); }
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
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('a[href*="/store/products/"]', { timeout: 30_000 });
      await page.waitForTimeout(1500);
      const cards = await page.$$eval('a[href*="/store/products/"]', (as) => as.map((a) => ({
        href: a.href.split(/[?#]/)[0],
        text: ((a.closest('li, article') || a).innerText || '').trim(),
      })));
      const want = norm(title);
      let best = null, bestScore = 0;
      for (const c of cards) {
        const t = norm(c.text);
        let score = 0;
        if (t.includes(want)) score += 2;
        else if (want.length > 12 && t.includes(want.slice(0, Math.floor(want.length * 0.7)))) score += 1;
        if (score && platformOf(c.text) === chart) score += 1;
        if (score > bestScore) { best = c; bestScore = score; }
      }
      if (best && bestScore >= 2) {
        links[key] = best.href;
        found++;
        console.log(`  found   ${title} (${chart}) -> ${best.href}`);
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
if (dryRun || !found) process.exit(0);
const sorted = Object.fromEntries(Object.entries(links).sort(([a], [b]) => a.localeCompare(b)));
await fs.writeFile(OUT, JSON.stringify(sorted, null, 2) + '\n');
console.log(`Saved ${OUT}`);
