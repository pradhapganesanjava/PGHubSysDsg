#!/usr/bin/env python3
"""Pre-compute the payloads the old Python servers used to generate on demand.

Two of them:

  <module>/docs-index.json   what GET /docs returned for one module
  hub-index.json             what GET /__index__.json returned for the landing
                             page (every module's term/QA/topic list)


The Docs tab used to call GET /docs, which server.py answered by walking the
module's docs/ folder and building a list of {name,title,type,url,markdown,
text,tag,tags}. With the content in Drive there is no local folder to walk, so
we bake that same payload once, here, and upload it as docs-index.json.

Fidelity matters: the search index depends on server.py's html_to_text and
js_data_to_text. Rather than port that regex logic to JS and risk it drifting,
this script imports each module's own server.py and calls its load_docs()
directly — so the baked index is by construction identical to what the local
server produced.

Usage:  python3 tools/build-docs-index.py [--out DIR] [module ...]
"""
import argparse
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_server_module(module_dir):
    """Import <module_dir>/server.py under a unique name, with its own ROOT."""
    path = os.path.join(ROOT, module_dir, "server.py")
    if not os.path.isfile(path):
        return None
    name = "sysdsg_server_" + module_dir.replace("-", "_")
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)          # server only binds a port under __main__
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "tools", "out"))
    ap.add_argument("modules", nargs="*")
    args = ap.parse_args()

    hub = json.load(open(os.path.join(ROOT, "hub.json"), encoding="utf-8"))
    modules = args.modules or list(hub.get("modules", {}))

    os.makedirs(args.out, exist_ok=True)
    summary = {}

    for m in modules:
        mod = load_server_module(m)
        if mod is None:
            print(f"  {m:<18} no server.py — skipped")
            continue
        docs = mod.load_docs()
        # `url` pointed at the old local server ("/docs/<file>"). The Drive file
        # id is stitched in by migrate.mjs, which knows the uploaded ids; drop
        # the stale path now so nothing downstream trusts it.
        for d in docs:
            d.pop("url", None)
        dest = os.path.join(args.out, m)
        os.makedirs(dest, exist_ok=True)
        with open(os.path.join(dest, "docs-index.json"), "w", encoding="utf-8") as f:
            json.dump(docs, f, ensure_ascii=False)
        kinds = {}
        for d in docs:
            kinds[d["type"]] = kinds.get(d["type"], 0) + 1
        summary[m] = {"count": len(docs), "types": kinds}
        bytes_ = os.path.getsize(os.path.join(dest, "docs-index.json"))
        print(f"  {m:<18} {len(docs):>4} docs  {bytes_/1024:>8.0f} KB  {kinds}")

    with open(os.path.join(args.out, "_docs-summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    total = sum(v["count"] for v in summary.values())
    print(f"\n  {total} docs indexed across {len(summary)} modules")

    build_hub_index(args.out)
    print(f"  payloads written to {args.out}")


def build_hub_index(out_dir):
    """Bake GET /__index__.json — the landing page's cross-module content index.

    serve_hub.py already builds exactly this structure, so it is imported and
    called rather than reimplemented, for the same reason as load_docs above.
    The per-module `port` it emits is dropped: nothing runs on a port any more.
    """
    spec = importlib.util.spec_from_file_location(
        "sysdsg_hub_server", os.path.join(ROOT, "serve_hub.py"))
    hub_mod = importlib.util.module_from_spec(spec)
    sys.modules["sysdsg_hub_server"] = hub_mod
    spec.loader.exec_module(hub_mod)

    index = hub_mod.build_index()
    for m in index.get("modules", []):
        m.pop("port", None)
    with open(os.path.join(out_dir, "hub-index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)

    counts = {m["dir"]: len(m["terms"]) + len(m["qa"]) + len(m["topics"])
              for m in index.get("modules", [])}
    size = os.path.getsize(os.path.join(out_dir, "hub-index.json"))
    print(f"  hub index: {sum(counts.values())} items across "
          f"{len(counts)} modules, {size/1024:.0f} KB")


if __name__ == "__main__":
    main()
