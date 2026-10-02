#!/usr/bin/env python3
"""
STREAK-TENDO daily reader (Mac).

Opens the Nintendo Store app in the Android emulator, reads the Switch 2 and
Switch 1 Best Sellers lists (top 10 each), cuts each game's box art from the
screen, and saves the day to the website repo, then pushes it to GitHub.

  python3 ~/streaktendo/streaktendo.py            read, save, and push
  python3 ~/streaktendo/streaktendo.py --dry-run  read and print only

Uses only what ships with macOS + Xcode Command Line Tools + Android Studio.
"""
import datetime, json, os, re, shutil, struct, subprocess, sys, time, zlib
import xml.etree.ElementTree as ET

HOME = os.path.expanduser('~')
BASE = os.path.join(HOME, 'streaktendo')
REPO = os.path.join(BASE, 'streaktendo.github.io')   # the US website repo
LOGS = os.path.join(BASE, 'logs')
SDK = os.path.join(HOME, 'Library', 'Android', 'sdk')
ADB = os.path.join(SDK, 'platform-tools', 'adb')
EMU = os.path.join(SDK, 'emulator', 'emulator')
PKG = 'com.nintendo.znej'
KEEP = 10
DRY = '--dry-run' in sys.argv

# Screen layout measured from the app on a 1080x2400 Pixel.
LIST_TOP, LIST_BOTTOM = 300, 2190
ART_X, ART_W, ART_TOP_PAD, ART_BOTTOM_PAD = 53, 477, 21, 22
TABS = [('switch2', 'Nintendo Switch 2'), ('switch1', 'Nintendo Switch')]
# "Wait" answers Android's "isn't responding" pop-up without closing anything.
DISMISS = ['Wait', "Don't allow", "Don’t allow", 'Not now', 'No thanks', 'Skip', 'Later', 'Close', 'Cancel', 'OK']

os.makedirs(LOGS, exist_ok=True)
TODAY = datetime.datetime.now().strftime('%Y-%m-%d')   # the Mac's own time zone (Pacific)
WORK = os.path.join(LOGS, 'work-' + TODAY)
if os.path.isdir(WORK):
    shutil.rmtree(WORK)
os.makedirs(WORK)


def log(msg):
    line = time.strftime('%H:%M:%S ') + msg
    print(line, flush=True)
    with open(os.path.join(LOGS, 'run-' + TODAY + '.log'), 'a') as f:
        f.write(line + '\n')


def run(args, timeout=120, check=True, binary=False):
    r = subprocess.run(args, capture_output=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError('Command failed: %s\n%s' % (' '.join(args), r.stderr.decode(errors='replace')[:500]))
    return r.stdout if binary else r.stdout.decode(errors='replace')


def adb(*args, **kw):
    return run([ADB] + list(args), **kw)


def clean(t):
    t = (t or '').replace('\xa0', ' ').replace('\u200b', '')
    t = re.sub(r'[™®©]', '', t)
    return re.sub(r'\s+', ' ', t).strip()


# ---------------------------------------------------------------- emulator
def device_ready():
    try:
        return adb('shell', 'getprop', 'sys.boot_completed', timeout=15, check=False).strip() == '1'
    except Exception:
        return False


def wait_until_off(limit=90):
    for _ in range(limit // 3):
        if subprocess.run([ADB, 'get-state'], capture_output=True).returncode != 0:
            return
        time.sleep(3)


def start_emulator():
    # Always start from a fresh boot. A phone left running for days gets sluggish and
    # starts showing "isn't responding" pop-ups, which is what broke the morning run.
    if device_ready() or subprocess.run([ADB, 'get-state'], capture_output=True).returncode == 0:
        log('Phone was already running. Restarting it for a clean run...')
        stop_emulator()
        wait_until_off()
        time.sleep(5)
    avds = [a for a in run([EMU, '-list-avds']).split() if a]
    if not avds:
        raise RuntimeError('No virtual phone found in Android Studio.')
    name = os.environ.get('STREAKTENDO_AVD', avds[0])
    log('Starting phone "%s" in the background...' % name)
    extra = os.environ.get('STREAKTENDO_EMU_ARGS', '-no-window -gpu swiftshader_indirect').split()
    out = open(os.path.join(LOGS, 'emulator.log'), 'a')
    subprocess.Popen([EMU, '-avd', name, '-no-audio', '-no-boot-anim', '-no-snapshot-load', '-no-snapshot-save'] + extra,
                     stdout=out, stderr=out, start_new_session=True)
    adb('wait-for-device', timeout=600)
    for _ in range(180):
        if device_ready():
            break
        time.sleep(5)
    else:
        raise RuntimeError('The phone did not finish starting within 15 minutes.')
    log('Phone started. Letting it settle...')
    time.sleep(45)
    # Turn off animations: less work for the phone, fewer "isn't responding" pop-ups.
    for key in ('window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'):
        adb('shell', 'settings', 'put', 'global', key, '0', check=False)
    return True


def stop_emulator():
    adb('emu', 'kill', check=False, timeout=30)


# ---------------------------------------------------------------- screen helpers
def parse_nodes(xml):
    nodes = []
    for n in ET.fromstring(xml[xml.index('<?xml') if '<?xml' in xml else 0:]).iter('node'):
        m = re.findall(r'\d+', n.get('bounds', '[0,0][0,0]'))
        x1, y1, x2, y2 = map(int, m[:4])
        nodes.append({'text': clean(n.get('text')), 'desc': n.get('content-desc', ''),
                      'cls': n.get('class', ''), 'click': n.get('clickable') == 'true',
                      'b': (x1, y1, x2, y2)})
    return nodes


def dump():
    for attempt in range(4):
        adb('shell', 'uiautomator', 'dump', '/sdcard/st.xml', check=False, timeout=60)
        xml = adb('exec-out', 'cat', '/sdcard/st.xml', check=False, timeout=30)
        if '<hierarchy' in xml:
            return parse_nodes(xml)
        time.sleep(2)
    raise RuntimeError('Could not read the phone screen.')


def shot(path):
    with open(path, 'wb') as f:
        f.write(adb('exec-out', 'screencap', '-p', binary=True, timeout=60))


def tap(x, y, wait=3):
    adb('shell', 'input', 'tap', str(x), str(y))
    time.sleep(wait)


def swipe(y_from, y_to, wait=2.5):
    adb('shell', 'input', 'swipe', '540', str(y_from), '540', str(y_to), '900')
    time.sleep(wait)


def home_swipe():
    # Scroll along the right-hand margin (x=1060), outside the game tiles,
    # so a laggy swipe is less likely to count as a tap on something.
    adb('shell', 'input', 'swipe', '1060', '1800', '1060', '900', '700')
    time.sleep(3)


def center(b):
    return (b[0] + b[2]) // 2, (b[1] + b[3]) // 2


def save_debug(tag):
    try:
        shot(os.path.join(LOGS, 'debug-%s-%s.png' % (TODAY, tag)))
        adb('shell', 'uiautomator', 'dump', '/sdcard/st.xml', check=False)
        with open(os.path.join(LOGS, 'debug-%s-%s.xml' % (TODAY, tag)), 'w') as f:
            f.write(adb('exec-out', 'cat', '/sdcard/st.xml', check=False))
    except Exception:
        pass


def dismiss_popups(nodes):
    for label in DISMISS:
        for n in nodes:
            if n['text'] == label:
                log('Closing a pop-up ("%s").' % label)
                tap(*center(n['b']))
                return True
    return False


# ---------------------------------------------------------------- app navigation
def on_best_sellers(nodes):
    return any(n['text'] == 'Best Sellers' and n['b'][1] < LIST_TOP for n in nodes)


def open_best_sellers():
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
    adb('shell', 'input', 'keyevent', '82')
    adb('shell', 'svc', 'power', 'stayon', 'true', check=False)
    adb('shell', 'am', 'force-stop', PKG)
    adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1')
    time.sleep(12)
    for step in range(30):
        nodes = dump()
        if on_best_sellers(nodes):
            return
        if dismiss_popups(nodes):
            continue
        # A slow phone can turn a scroll into a tap and open some other page
        # (it once landed on "Nintendo Direct 9.9.2026"). If there's a back
        # button and we're not on Best Sellers, go back to the home screen.
        if any(n['desc'] == 'back button' for n in nodes):
            log('Ended up on another page by accident. Going back to the home screen.')
            adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
            time.sleep(4)
            continue
        link = [n for n in nodes if n['text'].lower().startswith('best sellers')
                and LIST_TOP <= n['b'][1] and n['b'][3] <= LIST_BOTTOM]
        if link:
            log('Found Best Sellers on the home screen. Opening it.')
            tap(*center(link[0]['b']), wait=5)
            continue
        home_swipe()
    save_debug('no-best-sellers')
    raise RuntimeError('Could not find Best Sellers in the app.')


def choose_tab(label):
    nodes = dump()
    tab = [n for n in nodes if n['text'] == label and n['b'][1] < 700]
    if not tab:
        # the tabs scroll away with the list; go back to the top first
        for _ in range(6):
            swipe(700, 2000, wait=1.5)
        nodes = dump()
        tab = [n for n in nodes if n['text'] == label and n['b'][1] < 700]
    if not tab:
        save_debug('no-tab')
        raise RuntimeError('Could not find the "%s" tab.' % label)
    tap(*center(tab[0]['b']), wait=5)
    for _ in range(3):
        swipe(700, 2000, wait=1.5)


RANK_RE = re.compile(r'^\d{1,3}$')
NOT_TITLE = re.compile(r'^(\$|[\d.,]+|NEW|Pre-?order|\d+% OFF|Free.*|Demo.*|Sale.*)$', re.I)


def rows_on_screen(nodes):
    """Returns [(rank, title, row_bounds)] for list rows whose rank badge is visible."""
    rows = [n for n in nodes if n['click'] and n['b'][0] == 0 and n['b'][2] >= 1000
            and n['b'][1] >= LIST_TOP - 5 and n['b'][3] <= LIST_BOTTOM + 5]
    out = []
    for r in rows:
        x1, y1, x2, y2 = r['b']
        inside = [n for n in nodes if n['cls'].endswith('TextView') and n['text']
                  and x1 <= n['b'][0] and n['b'][2] <= x2 and y1 <= n['b'][1] and n['b'][1] < y2]
        rank = next((n for n in inside if RANK_RE.match(n['text']) and n['b'][0] > 500), None)
        if not rank:
            continue
        title = next((n['text'] for n in inside if n is not rank and not NOT_TITLE.match(n['text'])
                      and n['b'][1] >= rank['b'][1]), None)
        if title:
            out.append((int(rank['text']), title, r['b']))
    return out


def read_chart(chart_id, label):
    log('Reading %s Best Sellers...' % label)
    choose_tab(label)
    found = {}
    art = {}
    last_sig = None
    for step in range(14):
        nodes = dump()
        png = os.path.join(WORK, '%s-%02d.png' % (chart_id, step))
        shot(png)
        rows = rows_on_screen(nodes)
        for rank, title, b in rows:
            if rank > KEEP:
                continue
            found.setdefault(rank, title)
            full = b[1] >= LIST_TOP and b[3] <= LIST_BOTTOM and (b[3] - b[1]) >= 480
            if full and rank not in art:
                art[rank] = (png, b)
        sig = tuple((r, t) for r, t, _ in rows)
        have_all = all(r in found and r in art for r in range(1, KEEP + 1))
        if have_all or (sig and sig == last_sig):
            break
        last_sig = sig
        swipe(1900, 800)
    if 1 not in found:
        save_debug('no-list-' + chart_id)
        raise RuntimeError('Could not read the %s list.' % label)
    top = []
    for rank in sorted(found):
        top.append({'rank': rank, 'title': clean(found[rank]), 'shot': art.get(rank)})
    for g in top:
        log('  %2d. %s%s' % (g['rank'], g['title'], '' if g['shot'] else '   (no picture)'))
    return top


# ---------------------------------------------------------------- pictures
def crop_png(src, dst, x, y, w, h):
    """Crop with macOS 'sips'; fall back to a small built-in PNG cropper."""
    r = subprocess.run(['sips', '-c', str(h), str(w), '--cropOffset', str(y), str(x), src, '--out', dst],
                       capture_output=True)
    if r.returncode == 0 and os.path.exists(dst):
        size = subprocess.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', dst], capture_output=True).stdout.decode()
        if ('pixelWidth: %d' % w) in size and ('pixelHeight: %d' % h) in size:
            return
    _crop_png_python(src, dst, x, y, w, h)


def _crop_png_python(src, dst, x, y, w, h):
    data = open(src, 'rb').read()
    pos, idat = 8, b''
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            W, H, depth, ctype = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
    bpp = {6: 4, 2: 3}[ctype]
    raw = zlib.decompress(idat)
    stride = W * bpp
    prev = bytearray(stride)
    rows = []
    for r in range(y + h):
        f = raw[r * (stride + 1)]
        line = bytearray(raw[r * (stride + 1) + 1:(r + 1) * (stride + 1)])
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                c = prev[i - bpp] if i >= bpp else 0
                b = prev[i]
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        if r >= y:
            rows.append(b'\x00' + bytes(line[x * bpp:(x + w) * bpp]))
        prev = line

    def chunk(t, b):
        return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
    with open(dst, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ctype, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b''))


def slug(title):
    s = title.lower()
    s = re.sub(r'[éèêë]', 'e', s)
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')
    return s[:80] or 'game'


def save_art(game, art_dir, chart_id):
    # Switch 1 and Switch 2 versions of a game can have different box art (e.g. Minecraft
    # Dungeons II), so Switch 1 pictures get their own file.
    name = slug(game['title']) + ('-switch1' if chart_id == 'switch1' else '') + '.jpg'
    path = os.path.join(art_dir, name)
    rel = 'data/us/art/' + name
    if os.path.exists(path) or not game['shot']:
        return rel if os.path.exists(path) else None
    png, b = game['shot']
    tmp = os.path.join(WORK, chart_id + '-' + slug(game['title']) + '.png')
    crop_png(png, tmp, ART_X, b[1] + ART_TOP_PAD, ART_W, (b[3] - b[1]) - ART_TOP_PAD - ART_BOTTOM_PAD)
    run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '88', tmp, '--out', path])
    return rel


# ---------------------------------------------------------------- saving
def git(*args, **kw):
    return run(['git', '-C', REPO] + list(args), **kw)


def save_day(charts):
    if not os.path.isdir(os.path.join(REPO, '.git')):
        raise RuntimeError('The website repo is missing at %s. Run setup.sh again.' % REPO)
    git('pull', '--rebase', '--quiet', timeout=120)
    hist_path = os.path.join(REPO, 'data', 'us', 'history.json')
    hist = json.load(open(hist_path))
    if hist.get('region') != 'US':
        raise RuntimeError('data/us/history.json in %s is not marked as US (region is %r). Not saving.' % (REPO, hist.get('region')))
    hist['source'] = 'Nintendo Store app (US), Best Sellers'
    hist['timezone'] = 'America/Los_Angeles'
    art_dir = os.path.join(REPO, 'data', 'us', 'art')
    os.makedirs(art_dir, exist_ok=True)
    hist.setdefault('images', {})
    record = {'capturedAt': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
              'method': 'app', 'no1': {}, 'charts': {}}
    for chart_id, top in charts.items():
        items = []
        for g in top:
            rel = save_art(g, art_dir, chart_id)
            if rel:
                hist['images'][chart_id + '|' + g['title']] = rel
            items.append({'rank': g['rank'], 'title': g['title'], 'image': rel})
        record['charts'][chart_id] = items
        record['no1'][chart_id] = items[0]['title'] if items and items[0]['rank'] == 1 else None
    hist['days'][TODAY] = record
    hist['days'] = dict(sorted(hist['days'].items()))
    hist['updatedAt'] = record['capturedAt']
    with open(hist_path, 'w') as f:
        json.dump(hist, f, indent=2, ensure_ascii=False)
        f.write('\n')
    git('add', 'data/us')
    if subprocess.run(['git', '-C', REPO, 'diff', '--cached', '--quiet']).returncode == 0:
        log('Nothing changed; nothing to push.')
        return
    git('commit', '-q', '-m', 'Record US eShop #1 for ' + TODAY)
    for attempt in range(3):
        if subprocess.run(['git', '-C', REPO, 'push', '-q'], timeout=180).returncode == 0:
            break
        log('Push was refused (probably the Australian job saved first). Catching up and retrying...')
        git('pull', '--rebase', '--quiet', timeout=120)
    else:
        raise RuntimeError('Could not push to GitHub after 3 tries.')
    log('Saved and pushed to GitHub.')


# ---------------------------------------------------------------- main
def main():
    for tool in (ADB, EMU):
        if not os.path.exists(tool):
            raise RuntimeError('Missing %s. Is Android Studio installed?' % tool)
    charts = None
    try:
        for attempt in (1, 2):
            try:
                start_emulator()
                open_best_sellers()
                charts = {}
                for chart_id, label in TABS:
                    charts[chart_id] = read_chart(chart_id, label)
                break
            except Exception as e:
                if attempt == 2:
                    raise
                log('Attempt 1 failed (%s). Restarting the phone and trying once more...' % e)
        log('#1 Switch 2: %s | #1 Switch 1: %s' % (charts['switch2'][0]['title'], charts['switch1'][0]['title']))
        if DRY:
            preview = os.path.join(LOGS, 'preview-' + TODAY)
            os.makedirs(preview, exist_ok=True)
            for chart_id, top in charts.items():
                for g in top[:3]:
                    if g['shot']:
                        png, b = g['shot']
                        crop_png(png, os.path.join(preview, '%s-%d.png' % (chart_id, g['rank'])), ART_X,
                                 b[1] + ART_TOP_PAD, ART_W, (b[3] - b[1]) - ART_TOP_PAD - ART_BOTTOM_PAD)
            log('Dry run: nothing saved. Sample pictures are in ' + preview)
            return
        save_day(charts)
    finally:
        adb('shell', 'am', 'force-stop', PKG, check=False)
        stop_emulator()   # shut the phone down after every run, so tomorrow starts fresh
        shutil.rmtree(WORK, ignore_errors=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log('FAILED: %s' % e)
        sys.exit(1)
