#!/usr/bin/env python3
"""Rewrite the landing page for the Drive-backed, statically-hosted hub.

Previously index.html assumed thirteen Python servers on localhost ports 8301+:
it linked to http://127.0.0.1:<port>/, probed each port for a "live" dot, and
told the user to run ./start.command. None of that exists any more — every
module is now the same page, module.html?m=<dir>, and the content comes from
Drive.

The edits are confined to link construction, the liveness probe, and the help
copy. The tree, search, preview and practice logic are untouched.

Run once. It refuses to run twice (it detects its own output).

Usage:  python3 tools/build-hub.py [--file index.html]
"""
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SHIM = '''<script>
/* Parks the page's opening fetches until app/hub-boot.js installs the
   Drive-backed handler — module scripts are deferred, this inline app is not.
   See the same shim in module.html. */
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

HOWTO = '''        <h2>▶ About this hub</h2>
        <p>Every term, answer, topic and document lives in a private Google Drive
        folder — nothing is stored in this site. Sign in with the account that owns
        that folder and the hub fills itself in. Click a card to open a module, or
        click any item in the left panel / Browse view to preview it right here.</p>
        <p>Edits you make are saved straight back to Drive.</p>'''

# (description, old, new) — every one must match exactly once.
EDITS = [
    ("tree item link",
     '''  return `<a class="ti" target="_blank" rel="noopener"
             href="http://127.0.0.1:${m.port}/${HASH[type](it.id)}"
             data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}" data-port="${m.port}"
             data-s="${search}"
             title="${label}">${label}${grp}</a>`;''',
     '''  return `<a class="ti"
             href="module.html?m=${encodeURIComponent(m.dir)}${HASH[type](it.id)}"
             data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}"
             data-s="${search}"
             title="${label}">${label}${grp}</a>`;'''),

    ("browse item link",
     '''  return `<a class="ti" target="_blank" rel="noopener"
             href="http://127.0.0.1:${m.port}/${HASH[type](it.id)}"
             data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}" data-port="${m.port}"
             data-s="${search}"''',
     '''  return `<a class="ti"
             href="module.html?m=${encodeURIComponent(m.dir)}${HASH[type](it.id)}"
             data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}"
             data-s="${search}"'''),

    ("module open link in tree",
     '''function modOpenLink(m){
  return `<a class="mod-open" href="http://127.0.0.1:${m.port}/" target="_blank" rel="noopener"
     data-port="${m.port}" title="Open ${esc(m.title)} — http://127.0.0.1:${m.port}/"><i></i>:${m.port} ↗</a>`;
}''',
     '''function modOpenLink(m){
  return `<a class="mod-open live" href="module.html?m=${encodeURIComponent(m.dir)}"
     title="Open ${esc(m.title)}"><i></i>Open →</a>`;
}'''),

    ("practice pool entry",
     '''        dir: m.dir, port: m.port, id: it.id, type: listKey,''',
     '''        dir: m.dir, id: it.id, type: listKey,'''),

    ("practice open link",
     '''  document.getElementById("practiceOpen").href =
    `http://127.0.0.1:${item.port}/${HASH[item.type](item.id)}`;''',
     '''  document.getElementById("practiceOpen").href =
    `module.html?m=${encodeURIComponent(item.dir)}${HASH[item.type](item.id)}`;'''),

    ("preview overlay open link",
     '''  document.getElementById("mOpen").href = `http://127.0.0.1:${ds.port}/${HASH[ds.type](ds.id)}`;''',
     '''  document.getElementById("mOpen").href =
    `module.html?m=${encodeURIComponent(ds.dir)}${HASH[ds.type](ds.id)}`;'''),

    ("module card",
     '''function cardHTML(dir, m){
  return `<a class="card off" data-port="${m.port}" href="http://127.0.0.1:${m.port}/" target="_blank" rel="noopener">
      <div class="top"><span class="ico">${m.emoji||"📚"}</span><span class="t">${esc(m.title)}</span></div>
      <p class="d">${esc(m.sub||"")}</p>
      <div class="foot"><span class="dot"><i></i><span class="lbl">checking…</span></span><span class="go">Open :${m.port} →</span></div>
    </a>`;
}''',
     '''function cardHTML(dir, m){
  return `<a class="card" href="module.html?m=${encodeURIComponent(dir)}">
      <div class="top"><span class="ico">${m.emoji||"📚"}</span><span class="t">${esc(m.title)}</span></div>
      <p class="d">${esc(m.sub||"")}</p>
      <div class="foot"><span class="dot live"><i></i><span class="lbl">in Drive</span></span><span class="go">Open →</span></div>
    </a>`;
}'''),

    # No ports to probe: every module is the same statically-hosted page.
    ("liveness probe",
     '''async function loadManifest(){ return (await fetch("hub.json", {cache:"no-store"})).json(); }
async function probe(port){ try{ await fetch("http://127.0.0.1:"+port+"/favicon.ico",{mode:"no-cors",cache:"no-store"}); return true; }catch(e){ return false; } }''',
     '''async function loadManifest(){ return (await fetch("hub.json", {cache:"no-store"})).json(); }'''),

    ("card render + status",
     '''  let live = 0; const cards = [...document.querySelectorAll(".card")];
  await Promise.all(cards.map(async card => {
    const up = await probe(card.dataset.port), dot = card.querySelector(".dot"), lbl = card.querySelector(".lbl");
    if(up){ card.classList.remove("off"); dot.classList.add("live"); lbl.textContent="live"; live++;
            LIVE_PORTS.add(+card.dataset.port); }
    else { dot.classList.remove("live"); lbl.textContent="offline"; LIVE_PORTS.delete(+card.dataset.port); }
  }));
  paintModOpen();                                   // the tree links share these results
  status.textContent = `${live}/${cards.length} modules live`;''',
     '''  const cards = [...document.querySelectorAll(".card")];
  status.textContent = `${cards.length} modules`;'''),

    # Leftovers from the port probe, which no longer exists.
    ("dead LIVE_PORTS set",
     '''const LIVE_PORTS = new Set();          // ports the card probe found up; shared with the tree
''',
     ''''''),

    ("paintModOpen no longer paints liveness",
     '''/* reuse the card probe results so the tree shows the same live dot, and keep a click
   on the link from also toggling the <details> — the handler sits on the link itself so
   the event still reaches it (the module opens) but never bubbles up to the summary */
function paintModOpen(){
  document.querySelectorAll("#tree a.mod-open").forEach(a => {
    a.classList.toggle("live", LIVE_PORTS.has(+a.dataset.port));
    if (a.dataset.wired) return;''',
     '''/* Every module is always reachable now, so there is no liveness to paint — this
   only stops a click on the link from also toggling the enclosing <details>. The
   handler sits on the link itself, so the event still opens the module but never
   bubbles up to the summary. */
function paintModOpen(){
  document.querySelectorAll("#tree a.mod-open").forEach(a => {
    if (a.dataset.wired) return;'''),

    ("browse pill: drop the undefined port",
     '''        `<button class="pill" data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}" data-port="${m.port}"''',
     '''        `<button class="pill" data-item data-dir="${m.dir}" data-type="${type}" data-id="${esc(it.id)}"'''),

    ("manifest failure message",
     '''  try { man = await loadManifest(); } catch(e){ status.textContent = "needs server — run ./start.command"; return; }''',
     '''  try { man = await loadManifest(); } catch(e){ status.textContent = "sign in to load modules"; return; }'''),

    ("copy-command button",
     '''document.getElementById("copyCmd").onclick = () => navigator.clipboard.writeText("./start.command");''',
     ''''''),

    ("howto panel",
     '''        <h2>▶ Starting the hub</h2>
        <p>Double-click <code>start.command</code> — it boots every module on its own port and opens this page. Green dot = the module's server is <b>live</b>. Click a card to open a whole module, or click any item in the left panel / Browse view to preview it right here.</p>
        <div class="cmd"><span>./start.command</span> <button class="mini" id="copyCmd">Copy</button></div>''',
     HOWTO),

    # Dead once module.html stopped reading it: the hub and the modules are one
    # origin now. It also recorded location.origin, which is wrong under a
    # GitHub Pages subpath.
    ("hub-url cookie",
     '''_setCookie("sysdsg_hub", location.origin + "/");
''',
     ''''''),

    # Internal navigation should stay in the same window. These two, the cards
    # and the tree/browse links all pointed at a new tab, which turned browsing
    # the hub into a pile of tabs. The arrow glyph changes with them so the
    # label does not promise a new tab it no longer opens.
    ("practice open-in-module link",
     '''<a class="ghost" id="practiceOpen" target="_blank" rel="noopener">Open in module ↗</a>''',
     '''<a class="ghost" id="practiceOpen">Open in module →</a>'''),

    ("preview overlay open-in-module link",
     '''<a id="mOpen" target="_blank" rel="noopener">Open in module ↗</a>''',
     '''<a id="mOpen">Open in module →</a>'''),

    ("footnote",
     '''<p class="footnote" id="hubFootnote">Modules &amp; ports are defined in <code>hub.json</code>. The tree, search and previews are built live from each module's data files.</p>''',
     '''<p class="footnote" id="hubFootnote">Content is read from Google Drive. The tree, search and previews are built live from each module's data.</p>'''),

    ("status placeholder",
     '''      <span class="status" id="status">checking…</span>''',
     '''      <span class="status" id="status">loading…</span>'''),

    ("empty tree hint",
     '''  if (!INDEX.modules.length){ meta.textContent = "run ./start.command to load contents"; tree.innerHTML=""; return; }''',
     '''  if (!INDEX.modules.length){ meta.textContent = "sign in to load contents"; tree.innerHTML=""; return; }'''),

    ("empty browse hint",
     '''  if (!INDEX.modules.length){ el.innerHTML = '<p class="no-results">Run ./start.command to load contents.</p>'; return; }''',
     '''  if (!INDEX.modules.length){ el.innerHTML = '<p class="no-results">Sign in to load contents.</p>'; return; }'''),

    ("empty practice hint",
     '''      : `No ${label} found — run ./start.command`;''',
     '''      : `No ${label} found`;'''),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default=os.path.join(ROOT, 'index.html'))
    a = ap.parse_args()

    with open(a.file, encoding='utf-8') as f:
        html = f.read()

    if '__sysdsgInstall' in html:
        sys.exit('  index.html already rewritten — nothing to do.')

    for desc, old, new in EDITS:
        n = html.count(old)
        if n != 1:
            sys.exit(f'  aborted: "{desc}" matched {n} times (expected 1)')
        html = html.replace(old, new, 1)
        print(f'  ok  {desc}')

    html = html.replace('<head>', '<head>\n' + SHIM, 1)
    idx = html.rindex('</script>') + len('</script>')
    html = html[:idx] + '\n<script type="module" src="app/hub-boot.js"></script>' + html[idx:]
    print('  ok  shim + boot script')

    with open(a.file, 'w', encoding='utf-8') as f:
        f.write(html)

    leftovers = [l for l in ('127.0.0.1', 'start.command', 'probe(')
                 if l in html]
    print(f"\n  wrote {a.file}")
    if leftovers:
        print(f"  note: still mentions {leftovers} — check these are intentional")


if __name__ == '__main__':
    main()
