#!/usr/bin/env python3
"""Generate module.html — the single module app — from a legacy module page.

All thirteen module folders held a byte-identical 3,131-line application that
differed only in its <title>, emoji, heading and one-line subtitle. Rather than
maintain thirteen copies, this collapses them into one page that reads its
identity from the ?m= query parameter at runtime.

01-foundations is the base because its stylesheet is a strict superset (it
carries four extra .diagram rules the others lack, harmless everywhere).

The transformations are deliberately small and mechanical — the 3,000 lines of
application logic are not touched, only the shell around them:

  * module identity  -> empty elements the boot script fills in
  * hub link         -> relative, so it survives a GitHub Pages subpath
  * mermaid          -> vendored locally instead of an absolute /vendor path
                        that never resolved (the tag has been 404ing)
  * a fetch shim     -> queues the app's opening requests until the Drive-backed
                        store installs; see the comment in the emitted HTML

Usage:  python3 tools/build-app.py [--base 01-foundations] [--out module.html]
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Runs before the application's inline script, which starts fetching immediately.
FETCH_SHIM = '''<script>
/* Bridge between the app's startup and the Drive-backed store.
 *
 * The application below is a classic (non-module) script, so it executes during
 * parsing — before app/boot.js, which is a module and therefore deferred. Its
 * first act is to fetch('/terms'), and on a static host that would 404 long
 * before the store exists to answer it.
 *
 * So window.fetch is replaced up front with a version that parks every call.
 * Once the store installs it calls __sysdsgInstall, the parked calls are
 * replayed into it, and fetch behaves normally from then on. The app just
 * experiences a slightly slow first request.
 */
(function () {
  var native = window.fetch.bind(window);
  var parked = [];
  var handler = null;
  window.__sysdsgInstall = function (fn) {
    handler = fn;
    var queued = parked.splice(0);
    for (var i = 0; i < queued.length; i++) queued[i]();
  };
  window.fetch = function (input, init) {
    if (handler) return handler(input, init);
    return new Promise(function (resolve, reject) {
      parked.push(function () { (handler || native)(input, init).then(resolve, reject); });
    });
  };
})();
</script>
'''

BOOT_TAG = '<script type="module" src="app/boot.js"></script>\n'


def build(base_dir, out_path):
    src = os.path.join(ROOT, base_dir, 'index.html')
    with open(src, encoding='utf-8') as f:
        html = f.read()

    subs = [
        # identity, filled in by boot.js once hub.json arrives from Drive
        (re.compile(r'<title>[^<]*</title>'), '<title>SysDsg Hub</title>'),
        (re.compile(r'<div class="logo">[^<]*</div>'),
         '<div class="logo" id="mod-emoji"></div>'),
        (re.compile(r'<h1>[^<]*</h1>'), '<h1 id="mod-title"></h1>'),
        (re.compile(r'<div class="sub">[^<]*</div>'),
         '<div class="sub" id="mod-sub"></div>'),
        # the hub lived on a hard-coded localhost port
        (re.compile(r'href="http://127\.0\.0\.1:\d+/"'), 'href="./"'),
        # absolute path never resolved on any host; vendor it relatively
        (re.compile(r'<script src="/vendor/mermaid\.min\.js"></script>'),
         '<script src="vendor/mermaid.min.js"></script>'),

        # The hub used to live on its own origin (port 8300), so its URL was
        # passed between apps in a cookie. Hub and module are now the same
        # static site, so both fall back to a relative link and the cookie
        # lookup goes away — it could only ever produce a dead localhost URL.
        (re.compile(r'a\.href = _getCookie\("sysdsg_hub"\) \|\| "http://127\.0\.0\.1:\d+/";'),
         'a.href = "./";'),
        (re.compile(r'if \(hb\) hb\.href = _getCookie\("sysdsg_hub"\) \|\| "http://127\.0\.0\.1:\d+/";'),
         'if (hb) hb.href = "./";'),
        (re.compile(r'   Cookies ignore port, so 127\.0\.0\.1:\d+\.\.\d+ \+ the hub all share one theme\. \*/'),
         '   The theme is shared with the hub landing page, which is same-origin. */'),

        # Stale offline message: there is no local server to run any more.
        (re.compile(
            r'        : "Docs load via the local server\. Run <code>python3 server\.py</code> '
            r'and open <code>http://127\.0\.0\.1:\d+/</code>\."\}</p></div>`;'),
         '        : "Docs live in Google Drive — sign in to load them."}</p></div>`;'),
    ]
    for pat, repl in subs:
        html, n = pat.subn(repl, html, count=1)
        if not n:
            sys.exit(f'  build failed: pattern not found -> {pat.pattern}')

    # shim goes as early as possible: immediately after <head>
    html = html.replace('<head>', '<head>\n' + FETCH_SHIM, 1)

    # boot module after the app's inline script closes
    idx = html.rindex('</script>') + len('</script>')
    html = html[:idx] + '\n' + BOOT_TAG + html[idx:]

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f'  {base_dir}/index.html -> {os.path.relpath(out_path, ROOT)}'
          f'  ({len(html.splitlines())} lines)')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='01-foundations')
    ap.add_argument('--out', default=os.path.join(ROOT, 'module.html'))
    a = ap.parse_args()
    build(a.base, a.out)
