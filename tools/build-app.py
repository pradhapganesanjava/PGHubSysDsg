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
  // Published so the store can pass non-app requests straight to the browser.
  // It cannot capture window.fetch itself: by the time its module is imported
  // this shim has already replaced it, so what it would capture is the shim —
  // and passthrough would call back into the handler forever. The first
  // cross-origin request after sign-in blew the stack exactly that way.
  window.__sysdsgNativeFetch = native;
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

        # Copy that still described the local Python server the app no
        # longer talks to — including a hint sitting under the note editor
        # and an alert users would actually see.
        (re.compile(r'      : "Docs load via the local server\\. Run <code>python3 server\\.py</code>\\.";'),
         '      : "Docs live in Google Drive — sign in to load them.";'),
        (re.compile(r'    label = "Pasted images are saved as files in the <b>images/</b> folder via the local server\\.";'),
         '    label = "Pasted images are uploaded to the module\'s <b>images/</b> folder in Google Drive.";'),
        (re.compile(r'    alert\("Could not save the tag — is the local server running\?\\n" \+ e\);'),
         '    alert("Could not save the tag to Google Drive.\\n" + e);'),

        # The document link opened a new tab, and its href was the raw
        # "drive:<id>" reference — a scheme no browser can follow, so it had
        # never worked. media.js now resolves it like any other Drive
        # reference, and it opens in place.
        (re.compile(r'        `<a href="\\$\\{doc\\.url\\}" target="_blank" rel="noopener">'
                    r'Open in new tab ↗</a></div>` \\+'),
         '        `<a href="${doc.url}">Open full page →</a></div>` +'),

        # The Docs tab latched `docsLoaded` before its request, so a single
        # failed load left it permanently claiming the folder was empty. With
        # the data coming over the network now rather than off localhost, a
        # transient failure is a real possibility, so only latch on success.
        (re.compile(
            r'  if \(docsLoaded\) return DOCS;\n  docsLoaded = true;\n'
            r'  if \(SERVER\) \{\n    try \{\n      const r = await fetch\("/docs"\);\n'
            r'      if \(r\.ok\) DOCS = await r\.json\(\);\n'
            r'    \} catch \(e\) \{ DOCS = \[\]; \}\n  \}'),
         '  if (docsLoaded) return DOCS;\n'
         '  if (SERVER) {\n    try {\n      const r = await fetch("/docs");\n'
         '      if (r.ok) { DOCS = await r.json(); docsLoaded = true; }\n'
         '    } catch (e) { DOCS = []; }\n  } else {\n    docsLoaded = true;\n  }'),

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
