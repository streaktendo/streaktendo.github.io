#!/usr/bin/env python3
"""
Builds data/<region>/estimated.json from data/<region>/backfill.json.

Fills the days between weekly chart snapshots:
  - same #1 on both snapshots  -> that game for every day in between
  - different #1               -> switch on a documented date (release, etc.) from
                                  "changeovers" if one falls in the gap, else at the midpoint
  - gaps longer than max_gap_days are left empty
Days that already have real daily data in history.json are never touched (the site
also prefers real data over estimates).

Usage: python3 scripts/build_estimates.py us
"""
import datetime as dt, json, sys, os

region = sys.argv[1] if len(sys.argv) > 1 else 'us'
base = os.path.join('data', region)
try:
    cfg = json.load(open(os.path.join(base, 'backfill.json'), encoding='utf-8'))
except FileNotFoundError:
    cfg = {'observations': [], 'changeovers': []}
try:
    real = json.load(open(os.path.join(base, 'history.json'), encoding='utf-8')).get('days', {})
except FileNotFoundError:
    real = {}
max_gap = cfg.get('max_gap_days', 14)
D = lambda s: dt.date.fromisoformat(s)
days = {}

def put(day, chart, game, basis, source):
    key = day.isoformat()
    if chart in (real.get(key, {}).get('no1') or {}):
        return  # real daily data wins
    rec = days.setdefault(key, {'no1': {}, 'basis': {}, 'source': {}})
    rec['no1'][chart], rec['basis'][chart], rec['source'][chart] = game, basis, source

charts = sorted({o['chart'] for o in cfg['observations']} |
                {c for d in real.values() for c in (d.get('no1') or {})})
for chart in charts:
    obs = sorted((o for o in cfg['observations'] if o['chart'] == chart), key=lambda o: o['date'])
    for o in obs:
        put(D(o['date']), chart, o['no1'], 'Weekly chart snapshot', o['source'])
    # Anchors: weekly snapshots plus every real daily record, so the same rules also
    # fill days the daily check missed (e.g. a day the Mac couldn't run).
    found = {o['date']: (D(o['date']), o['no1'], o['source']) for o in obs}
    for d, rec in real.items():
        g = (rec.get('no1') or {}).get(chart)
        if g:
            found[d] = (D(d), g, None)
    anchors = [found[k] for k in sorted(found)]
    for (d0, a, src_a), (d1, b, src_b) in zip(anchors, anchors[1:]):
        gap = (d1 - d0).days
        if gap <= 1 or gap > max_gap:
            continue
        if a == b:
            for i in range(1, gap):
                put(d0 + dt.timedelta(i), chart, a, 'Between two weekly charts with the same #1', src_a)
            continue
        switch, why, why_src = None, None, None
        for c in cfg.get('changeovers', []):
            if c['chart'] == chart and c['game'] == b and d0 < D(c['first_day']) <= d1:
                switch, why, why_src = D(c['first_day']), c['reason'], c.get('source')
        if not switch:
            switch = d0 + dt.timedelta(days=(gap + 1) // 2)
            why = 'Changeover date unknown; split at the midpoint between weekly charts'
        for i in range(1, gap):
            day = d0 + dt.timedelta(i)
            if day < switch:
                put(day, chart, a, 'Still #1 before the changeover (' + why + ')', src_a)
            else:
                put(day, chart, b, 'Took #1 (' + why + ')', why_src or src_b)

out = {'region': region.upper(), 'about': 'Estimated from weekly charts; see backfill.json', 'days': dict(sorted(days.items()))}
with open(os.path.join(base, 'estimated.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('Wrote %s/estimated.json with %d days' % (base, len(days)))
