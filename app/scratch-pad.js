/* Scratch Pad — a page opened over whatever you are reading, for jotting
 * something down about it.
 *
 * It behaves as the portal's Scratch Pad does (pghubtech: portal/src/components/
 * ScratchPad.tsx): docks to the bottom, left or right, resizes by its edge, and
 * writes in Rich, HTML, Preview or Draw over the same body format. Not a modal:
 * no backdrop and no focus trap, because the page behind has to stay usable.
 *
 * WHAT DIFFERS FROM THE PORTAL
 * - The notes are a tree down the side rather than a dropdown. Each note carries
 *   one tag, and "Hooks::Effects" files it under Hooks > Effects, the same
 *   nesting the pages use for their own groups.
 * - The notes belong to the module. They live in <Module>/scratch/ in Drive, one
 *   HTML file per note, with the tag in the file's description. That field is
 *   used rather than appProperties, whose 124-byte limit a nested tag could hit.
 * - Moving to another note saves the one being left first, and refuses to move
 *   if that save fails. Deleting moves a note to Drive's trash.
 *
 * A blank note writes nothing to Drive until there is something in it, so opening
 * the pad to glance at something leaves no file behind.
 */
import { LS } from './config.js'
import { Store } from './store.js'
import {
  moduleFolderId, ensureFolder, listFiles, createFile, updateFile,
  patchFile, readTextById, clearIdCache,
} from './drive.js'
import { createDrawPad, hwDocToBlockHtml, parseHwDoc } from './scratch-draw.js'
import { createRichEditor, sanitize } from './scratch-editor.js'
import { ICONS } from './scratch-icons.js'

const FOLDER = 'scratch'
const EXT = '.html'
const TAG_SEP = '::'
const AUTOSAVE_MS = 1600
const DEFAULT_H = 0.65
const DEFAULT_W = 0.42
const SIDE_DOCK_MIN_VW = 720
const COMPACT_W = 560        // below this the note list overlays instead of sitting beside
const MIN_H = 180
const MIN_W = 300
const DOCKS = ['bottom', 'left', 'right']
const DOCK_META = {
  bottom: { icon: ICONS.dockBottom, label: 'Bottom' },
  left:   { icon: ICONS.dockLeft,   label: 'Left' },
  right:  { icon: ICONS.dockRight,  label: 'Right' },
}
const TABS = [
  ['rich', 'Write', 'Rich text', ICONS.write],
  ['html', 'Code', 'Raw HTML', ICONS.code],
  ['preview', 'Read', 'Preview', ICONS.read],
  ['draw', 'Draw', 'Draw', ICONS.draw],
]
const SHEET_GAP = 10        // the sheet floats this far off the window's edge

// A pencil mid-stroke on a circle, the portal's mark.
const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M17.4 6.3a8.4 8.4 0 1 0 3 6.4"/>
  <path d="M20.6 4.2 13 11.8l-2.6.9.9-2.6 7.6-7.6a1.2 1.2 0 0 1 1.7 1.7z"/></svg>`

const CSS = `
.pghub-scratch-launch {
  width: 32px; height: 32px; flex: 0 0 auto; padding: 0; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  color: var(--accent); background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  transition: background .15s, color .15s, transform .15s;
}
.pghub-scratch-launch svg { width: 17px; height: 17px; display: block; }
.pghub-scratch-launch:hover { transform: translateY(-1px); }
.pghub-scratch-launch:hover, .pghub-scratch-launch.active { background: var(--accent); color: var(--accent-ink, #fff); }
.pghub-scratch-launch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 860px) {
  .pghub-scratch-launch { margin-left: auto; }
  .pghub-scratch-launch + .tp, .pghub-scratch-launch + .theme-select { margin-left: 0; }
}
/* This hub's floating home button would sit on the note list and the drawing
   tools. The header has its own, so this one steps aside while the pad is open. */
body.sp-open #hub-home { display: none; }
body.sp-resizing-h, body.sp-resizing-h * { cursor: col-resize !important; user-select: none !important; }
body.sp-resizing-v, body.sp-resizing-v * { cursor: ns-resize !important; user-select: none !important; }

/* ── the sheet ─────────────────────────────────────────────────────────── */
#pghub-scratch {
  --sp-danger: var(--danger, #e5534b);
  --sp-ok: var(--ok, #3fb950);
  --sp-warn: var(--warn, #e3a008);
  --sp-hair: color-mix(in srgb, var(--border) 75%, transparent);
  --sp-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  position: fixed; z-index: 95; display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.5;
  border: 1px solid var(--border); border-radius: 16px;
  box-shadow: 0 18px 50px rgba(0,0,0,.32), 0 2px 8px rgba(0,0,0,.14);
  animation: sp-rise .16s ease-out;
}
@keyframes sp-rise { from { opacity: 0; transform: translateY(8px); } }
@media (prefers-reduced-motion: reduce) { #pghub-scratch { animation: none; } }
#pghub-scratch *, #pghub-scratch *::before, #pghub-scratch *::after { box-sizing: border-box; }
#pghub-scratch .sp-ic { width: 16px; height: 16px; display: block; flex: none; }
#pghub-scratch.dock-bottom { left: 10px; right: 10px; bottom: 10px; }
#pghub-scratch.dock-left, #pghub-scratch.dock-right { top: calc(var(--sp-top, 0px) + 8px); bottom: 10px; }
#pghub-scratch.dock-left  { left: 10px; }
#pghub-scratch.dock-right { right: 10px; }

/* A hit area along the page-facing edge with a small pill to show it moves. */
#pghub-scratch .sp-grip {
  position: absolute; z-index: 8; left: 0; right: 0; top: 0; height: 10px; cursor: ns-resize; touch-action: none;
  display: flex; align-items: center; justify-content: center;
}
#pghub-scratch .sp-grip::after {
  content: ""; width: 42px; height: 4px; border-radius: 4px; background: var(--border); transition: background .12s, width .12s;
}
#pghub-scratch .sp-grip:hover::after { background: var(--accent); width: 60px; }
#pghub-scratch.dock-left .sp-grip, #pghub-scratch.dock-right .sp-grip {
  top: 0; bottom: 0; left: auto; right: auto; width: 10px; height: auto; cursor: col-resize;
}
#pghub-scratch.dock-left  .sp-grip { right: 0; }
#pghub-scratch.dock-right .sp-grip { left: 0; }
#pghub-scratch.dock-left .sp-grip::after, #pghub-scratch.dock-right .sp-grip::after { width: 4px; height: 42px; }
#pghub-scratch.dock-left .sp-grip:hover::after, #pghub-scratch.dock-right .sp-grip:hover::after { width: 4px; height: 60px; }

/* ── the title bar ─────────────────────────────────────────────────────── */
#pghub-scratch .sp-hd {
  display: flex; align-items: center; gap: 10px; flex-shrink: 0; flex-wrap: wrap;
  padding: 12px 12px 9px; border-bottom: 1px solid var(--sp-hair);
}
#pghub-scratch .sp-icon-btn {
  width: 30px; height: 30px; padding: 0; flex: none; border-radius: 8px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 0; color: var(--muted); transition: background .12s, color .12s;
}
#pghub-scratch .sp-icon-btn:hover:not(:disabled) { background: var(--panel-2); color: var(--text); }
#pghub-scratch .sp-icon-btn.active { color: var(--accent); }
#pghub-scratch .sp-icon-btn:disabled { opacity: .35; cursor: default; }
#pghub-scratch .sp-icon-btn.sp-danger-hover:hover:not(:disabled) { background: color-mix(in srgb, var(--sp-danger) 14%, transparent); color: var(--sp-danger); }
#pghub-scratch :is(.sp-icon-btn, .sp-row, .sp-seg button, .sp-text-btn, .sp-new, .hw-tool, .hw-fab-btn, .rf-tb-btn):focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

#pghub-scratch .sp-title { flex: 1 1 200px; min-width: 150px; display: flex; flex-direction: column; gap: 1px; }
#pghub-scratch .sp-name, #pghub-scratch .sp-tag {
  width: 100%; min-width: 0; background: transparent; border: 0; outline: 0; padding: 0 2px; font-family: inherit; color: var(--text);
}
#pghub-scratch .sp-name { font-size: 15px; font-weight: 650; letter-spacing: -.01em; line-height: 1.3; }
#pghub-scratch .sp-tag-row { display: flex; align-items: center; gap: 4px; color: var(--muted); }
#pghub-scratch .sp-tag-row .sp-ic { width: 12px; height: 12px; }
#pghub-scratch .sp-tag { font-size: 11.5px; color: var(--muted); line-height: 1.4; }
#pghub-scratch .sp-tag:focus { color: var(--text); }
#pghub-scratch .sp-tag::placeholder { color: var(--muted); opacity: .7; }
#pghub-scratch .sp-title:focus-within .sp-tag-row { color: var(--accent); }

/* The mode switch: one control with a sliding-looking active segment. */
#pghub-scratch .sp-seg {
  display: inline-flex; flex: none; gap: 2px; padding: 3px; border-radius: 10px;
  background: var(--panel-2); border: 1px solid var(--sp-hair);
}
#pghub-scratch .sp-seg button {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border: 0; border-radius: 7px; cursor: pointer;
  background: transparent; color: var(--muted); font: inherit; font-size: 12px; font-weight: 600; line-height: 1.4;
  transition: background .12s, color .12s;
}
#pghub-scratch .sp-seg .sp-ic { width: 14px; height: 14px; }
#pghub-scratch .sp-seg button:hover { color: var(--text); }
#pghub-scratch .sp-seg button.active { background: var(--bg); color: var(--accent); box-shadow: 0 1px 3px rgba(0,0,0,.18); }
#pghub-scratch.compact .sp-seg button span { display: none; }
#pghub-scratch.compact .sp-seg button { padding: 5px 8px; }

#pghub-scratch .sp-actions { display: flex; align-items: center; gap: 2px; flex: none; margin-left: auto; }
#pghub-scratch .sp-state {
  display: inline-flex; align-items: center; gap: 5px; max-width: 190px; margin-right: 6px;
  font-size: 11px; color: var(--muted); white-space: nowrap;
}
#pghub-scratch .sp-state .sp-state-text { overflow: hidden; text-overflow: ellipsis; }
#pghub-scratch .sp-state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--muted); }
#pghub-scratch .sp-state[data-kind="saved"]::before { background: var(--sp-ok); }
#pghub-scratch .sp-state[data-kind="dirty"]::before { background: var(--sp-warn); }
#pghub-scratch .sp-state[data-kind="busy"]::before { background: var(--accent); animation: sp-pulse 1s infinite; }
#pghub-scratch .sp-state[data-kind="err"] { color: var(--sp-danger); }
#pghub-scratch .sp-state[data-kind="err"]::before { background: var(--sp-danger); }
@keyframes sp-pulse { 50% { opacity: .35; } }
#pghub-scratch .sp-text-btn {
  padding: 5px 12px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
  background: var(--panel-2); color: var(--text); border: 1px solid var(--sp-hair);
}
#pghub-scratch .sp-primary { background: var(--accent); color: var(--accent-ink, #fff); border-color: transparent; }
#pghub-scratch .sp-primary:hover:not(:disabled) { filter: brightness(1.08); }
#pghub-scratch .sp-primary:disabled { opacity: .45; cursor: default; }
#pghub-scratch .sp-save { display: inline-flex; align-items: center; gap: 5px; margin-right: 4px; padding: 5px 10px; }
#pghub-scratch .sp-save .sp-ic { width: 14px; height: 14px; }

/* ── the note library ──────────────────────────────────────────────────── */
#pghub-scratch .sp-main { flex: 1; min-height: 0; display: flex; position: relative; }
#pghub-scratch .sp-nav {
  flex: 0 0 236px; min-height: 0; display: flex; flex-direction: column;
  border-right: 1px solid var(--sp-hair); background: var(--panel);
}
#pghub-scratch.nav-hidden .sp-nav { display: none; }
#pghub-scratch.compact .sp-nav {
  position: absolute; left: 0; top: 0; bottom: 0; width: min(270px, 88%); z-index: 5;
  box-shadow: 10px 0 26px rgba(0,0,0,.28);
}
#pghub-scratch .sp-new {
  display: flex; align-items: center; justify-content: center; gap: 6px; flex-shrink: 0; margin: 10px 10px 6px; padding: 7px 10px;
  border-radius: 9px; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 600;
  background: var(--accent-soft); color: var(--accent); border: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
  transition: background .12s, color .12s;
}
#pghub-scratch .sp-new:hover { background: var(--accent); color: var(--accent-ink, #fff); border-style: solid; }
#pghub-scratch .sp-new .sp-ic { width: 14px; height: 14px; }
#pghub-scratch .sp-tree { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px 12px; scrollbar-width: thin; }
#pghub-scratch .sp-tree-empty { padding: 18px 12px; color: var(--muted); font-size: 12px; text-align: center; line-height: 1.6; }
#pghub-scratch .sp-row {
  position: relative; display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; cursor: pointer; margin: 1px 0;
  background: transparent; border: 0; border-radius: 8px; padding-top: 5px; padding-bottom: 5px; padding-right: 8px;
  color: var(--text); font: inherit; font-size: 12.5px; line-height: 1.35; transition: background .1s;
}
#pghub-scratch .sp-row:hover { background: var(--panel-2); }
#pghub-scratch .sp-label { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#pghub-scratch .sp-group { color: var(--muted); font-size: 11.5px; font-weight: 700; letter-spacing: .02em; }
#pghub-scratch .sp-group .sp-label { flex: 1; }
#pghub-scratch .sp-group:hover { color: var(--text); }
#pghub-scratch .sp-caret { flex: none; display: inline-flex; width: 13px; }
#pghub-scratch .sp-caret .sp-ic { width: 13px; height: 13px; }
#pghub-scratch .sp-count {
  flex: none; min-width: 18px; padding: 0 5px; text-align: center; border-radius: 9px;
  font-size: 10px; font-weight: 600; background: var(--panel-2); color: var(--muted);
}
#pghub-scratch .sp-note-text { flex: 1; min-width: 0; }
#pghub-scratch .sp-when { display: block; font-size: 10.5px; color: var(--muted); }
#pghub-scratch .sp-note[aria-current="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
#pghub-scratch .sp-note[aria-current="true"]::before {
  content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; border-radius: 3px; background: var(--accent);
}
#pghub-scratch .sp-note[aria-current="true"] .sp-when { color: inherit; opacity: .75; font-weight: 400; }
#pghub-scratch .sp-note.draft .sp-label { font-style: italic; }

/* ── the writing area ──────────────────────────────────────────────────── */
#pghub-scratch .sp-body { flex: 1; min-width: 0; min-height: 0; overflow: auto; position: relative; scrollbar-width: thin; }
#pghub-scratch .sp-body.is-draw { display: flex; flex-direction: column; overflow: hidden; }
#pghub-scratch .sp-html {
  display: block; width: 100%; height: 100%; resize: none; padding: 16px 20px; outline: none; border: 0;
  background: var(--panel); color: var(--text); font-family: var(--sp-mono); font-size: 12.5px; line-height: 1.6;
}
#pghub-scratch .sp-preview { max-width: 780px; margin: 0 auto; padding: 20px 24px 40px; }
#pghub-scratch .sp-scroll {
  position: absolute; right: 12px; top: 50%; transform: translateY(-50%); z-index: 3;
  display: flex; flex-direction: column; border-radius: 10px; overflow: hidden;
  background: var(--panel); border: 1px solid var(--sp-hair); box-shadow: 0 3px 12px rgba(0,0,0,.2);
  opacity: .7; transition: opacity .12s;
}
#pghub-scratch .sp-scroll:hover { opacity: 1; }
#pghub-scratch .sp-scroll[hidden] { display: none; }
#pghub-scratch .sp-scroll button {
  width: 30px; height: 30px; padding: 0; border: 0; cursor: pointer; touch-action: manipulation;
  display: flex; align-items: center; justify-content: center; background: transparent; color: var(--muted);
}
#pghub-scratch .sp-scroll button:hover { background: var(--panel-2); color: var(--accent); }
#pghub-scratch .sp-dialog {
  position: absolute; inset: 10px; z-index: 7; display: flex; flex-direction: column; gap: 8px; padding: 12px;
  background: var(--panel); border: 1px solid var(--accent); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.3);
}
#pghub-scratch .sp-dialog textarea {
  flex: 1; min-height: 0; resize: none; padding: 10px; outline: none; color: var(--text); background: var(--bg);
  border: 1px solid var(--sp-hair); border-radius: 8px; font-family: var(--sp-mono); font-size: 12.5px;
}
#pghub-scratch .sp-dialog-row { display: flex; justify-content: flex-end; gap: 6px; }

#pghub-scratch .rf-rich-wrap { display: flex; flex-direction: column; min-height: 100%; }
#pghub-scratch .rf-rich-toolbar {
  position: sticky; top: 8px; z-index: 2; align-self: center; max-width: calc(100% - 20px); margin: 8px 10px 0;
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 1px; padding: 4px 6px;
  background: var(--panel); border: 1px solid var(--sp-hair); border-radius: 12px; box-shadow: 0 3px 14px rgba(0,0,0,.14);
}
#pghub-scratch .rf-tb-btn {
  min-width: 26px; height: 26px; padding: 0 5px; display: inline-flex; align-items: center; justify-content: center; margin: 0;
  font-size: 12.5px; line-height: 1; background: transparent; color: var(--text); font-family: inherit; text-transform: none; letter-spacing: 0;
  border: 0; border-radius: 6px; cursor: pointer; transition: background .1s, color .1s;
}
#pghub-scratch .rf-tb-btn .sp-ic { width: 15px; height: 15px; }
#pghub-scratch .rf-tb-btn:hover { background: var(--accent-soft); color: var(--accent); }
#pghub-scratch .rf-tb-divider { width: 1px; height: 16px; margin: 0 4px; background: var(--border); }
#pghub-scratch .rf-tb-color { position: relative; overflow: hidden; }
#pghub-scratch .rf-tb-color input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; }
#pghub-scratch .rf-rich-editor {
  flex: 1; width: 100%; max-width: 780px; margin: 0 auto; min-height: 160px; padding: 18px 24px 40px; outline: none; font-size: 14px; line-height: 1.7;
}
#pghub-scratch .rf-rich-editor:empty::before { content: attr(data-placeholder); color: var(--muted); opacity: .6; pointer-events: none; }
#pghub-scratch :is(.rf-rich-editor, .sp-preview) { overflow-wrap: anywhere; }
#pghub-scratch :is(.rf-rich-editor, .sp-preview) :is(h1, h2, h3) { margin: .7em 0 .3em; line-height: 1.3; border: 0; padding: 0; }
#pghub-scratch :is(.rf-rich-editor, .sp-preview) p { margin: .4em 0; }
#pghub-scratch :is(.rf-rich-editor, .sp-preview) :is(ul, ol) { margin: .4em 0; padding-left: 1.6em; }
#pghub-scratch :is(.rf-rich-editor, .sp-preview) blockquote {
  margin: .6em 0; padding: 6px 12px; border-left: 3px solid var(--accent);
  color: var(--muted); background: var(--panel); border-radius: 0 8px 8px 0;
}
#pghub-scratch :is(.rf-rich-editor, .sp-preview) pre {
  margin: .6em 0; padding: 10px 12px; background: var(--panel-2); border-radius: 8px;
  font-family: var(--sp-mono); font-size: 12px; overflow-x: auto; white-space: pre-wrap;
}
#pghub-scratch :is(.rf-rich-editor, .sp-preview) code { font-family: var(--sp-mono); font-size: 12px; }
#pghub-scratch :is(.rf-rich-editor, .sp-preview) a { color: var(--accent); text-decoration: underline; }
#pghub-scratch :is(.rf-rich-editor, .sp-preview) img { max-width: 100%; height: auto; border-radius: 6px; }
#pghub-scratch :is(.rf-rich-editor, .sp-preview) table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
#pghub-scratch .rf-html-embed {
  border: 1px dashed var(--accent); border-radius: 10px; padding: 8px 12px; margin: 8px 0; background: var(--accent-soft); cursor: pointer;
}
#pghub-scratch .rf-html-embed-label {
  font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--accent); font-weight: 700; margin-bottom: 6px; user-select: none;
}

/* ── the drawing desk ──────────────────────────────────────────────────── */
#pghub-scratch .hw-wrap { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; position: relative; }
#pghub-scratch :is(.hw-canvas-wrap, .hw-canvas-stack, .hw-canvas) {
  touch-action: none; -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
}
#pghub-scratch .hw-canvas-wrap.hw-panning,
#pghub-scratch .hw-canvas-wrap.hw-panning :is(.hw-canvas-stack, .hw-canvas) { touch-action: auto; cursor: grab; }
#pghub-scratch .hw-canvas-wrap {
  flex: 1 1 auto; min-height: 0; overflow: auto; padding: 18px 18px 76px; display: block; scrollbar-width: thin;
  background-color: var(--panel);
  background-image: radial-gradient(color-mix(in srgb, var(--muted) 35%, transparent) 1px, transparent 1px);
  background-size: 18px 18px;
}
#pghub-scratch .hw-canvas-stack {
  position: relative; width: calc(100% * var(--hw-zoom, 1)); max-width: calc(760px * var(--hw-zoom, 1));
  margin: 0 auto; aspect-ratio: 1000 / 1400; height: auto;
  background: #fff; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,.2), 0 10px 30px rgba(0,0,0,.18);
}
#pghub-scratch .hw-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair; }
/* The tools run along the bottom as one dock, where a hand already is. */
#pghub-scratch .hw-fab {
  position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 4; width: max-content; max-width: calc(100% - 20px);
  display: flex; align-items: flex-end; gap: 6px;
}
#pghub-scratch .hw-fab-panel {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px 0; min-width: 0; max-height: 60vh; overflow: auto; padding: 5px 4px;
  background: var(--bg); border: 1px solid var(--sp-hair); border-radius: 14px; box-shadow: 0 8px 26px rgba(0,0,0,.28);
  animation: sp-rise .12s ease-out;
}
@media (prefers-reduced-motion: reduce) { #pghub-scratch .hw-fab-panel { animation: none; } }
#pghub-scratch .hw-fab-row { display: flex; align-items: center; gap: 3px; padding: 0 7px; }
#pghub-scratch .hw-fab-row + .hw-fab-row { border-left: 1px solid var(--sp-hair); }
#pghub-scratch .hw-tool {
  width: 30px; height: 30px; padding: 0; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 0; color: var(--text); font: inherit; font-size: 14px; line-height: 1;
}
#pghub-scratch .hw-tool:hover:not(:disabled) { background: var(--panel-2); }
#pghub-scratch .hw-tool.active { background: var(--accent); color: var(--accent-ink, #fff); }
#pghub-scratch .hw-tool:disabled { opacity: .3; cursor: not-allowed; }
#pghub-scratch .hw-swatch {
  width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--bg); box-shadow: 0 0 0 1px var(--border); cursor: pointer; padding: 0; transition: transform .1s;
}
#pghub-scratch .hw-swatch:hover { transform: scale(1.12); }
#pghub-scratch .hw-swatch.active { box-shadow: 0 0 0 2px var(--accent); transform: scale(1.12); }
#pghub-scratch .hw-size {
  width: 26px; height: 26px; border-radius: 8px; background: transparent; padding: 0; cursor: pointer;
  border: 0; display: flex; align-items: center; justify-content: center;
}
#pghub-scratch .hw-size:hover { background: var(--panel-2); }
#pghub-scratch .hw-size.active { background: var(--accent-soft); }
#pghub-scratch .hw-size span { background: var(--text); border-radius: 50%; display: block; }
#pghub-scratch .hw-pageno { font-size: 11.5px; color: var(--muted); min-width: 34px; text-align: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
#pghub-scratch .hw-fab-btn {
  width: 42px; height: 42px; flex: none; border-radius: 14px; padding: 0; cursor: pointer; touch-action: manipulation;
  display: flex; align-items: center; justify-content: center; line-height: 1;
  background: var(--bg); border: 2px solid var(--sp-hair); color: var(--text); box-shadow: 0 8px 26px rgba(0,0,0,.28);
}
#pghub-scratch .hw-fab-btn .sp-ic { width: 18px; height: 18px; }
#pghub-scratch .hw-fab-btn:hover { color: var(--accent); }
#pghub-scratch .hw-lens {
  position: absolute; right: 12px; top: 12px; z-index: 4; width: 68px; aspect-ratio: 1000 / 1400;
  background: #fff; border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.28);
  overflow: hidden; cursor: crosshair; opacity: .85; touch-action: none;
}
#pghub-scratch .hw-lens:hover { opacity: 1; }
#pghub-scratch .hw-lens-page { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
#pghub-scratch .hw-lens-view { position: absolute; border: 1.5px solid var(--accent); background: var(--accent-soft); border-radius: 2px; pointer-events: none; }

@media (max-width: 720px) {
  #pghub-scratch.dock-bottom { left: 0; right: 0; bottom: 0; border-radius: 16px 16px 0 0; border-width: 1px 0 0; }
  #pghub-scratch .sp-grip { height: 14px; }
  #pghub-scratch .sp-state .sp-state-text { display: none; }
  #pghub-scratch .sp-state { margin-right: 2px; }
  #pghub-scratch .sp-seg { order: 5; flex: 1 0 100%; }
  #pghub-scratch .sp-seg button { flex: 1; justify-content: center; }
  #pghub-scratch.compact .sp-seg button span { display: inline; }
  #pghub-scratch .hw-fab-btn { width: 48px; height: 48px; }
  #pghub-scratch .hw-lens { width: 58px; right: 8px; top: 8px; }
  #pghub-scratch .sp-scroll { right: 8px; }
  #pghub-scratch .sp-scroll button { width: 36px; height: 36px; }
}
`

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props)
  n.append(...kids)
  return n
}
const button = (cls, label, title, on) => {
  const b = el('button', { type: 'button', className: cls, title })
  if (label.startsWith('<svg')) b.innerHTML = label
  else b.textContent = label
  b.setAttribute('aria-label', title)
  b.addEventListener('click', on)
  return b
}

/** "2026-09-06 15-42": sorts chronologically and is legal in a filename. */
function defaultName(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`
}
/** "2h ago": how long since a note changed, for its row in the list. */
function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  const min = Math.round(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
/** Tidies "  Hooks ::  Effects:: " to "Hooks::Effects". */
export const normalizeTag = t => String(t ?? '').split(TAG_SEP).map(s => s.trim()).filter(Boolean).join(TAG_SEP)

/** The rich-text half of a body: everything except the handwriting block. */
function textOf(body) {
  const d = new DOMParser().parseFromString(`<!doctype html><body>${body}</body>`, 'text/html')
  d.querySelectorAll('.hw-doc, img.hw-page').forEach(n => n.remove())
  return d.body.innerHTML.trim()
}

/** Groups first, alphabetically; a group's own notes keep the list's order. */
export function buildTree(notes) {
  const root = { name: '', path: '', groups: new Map(), notes: [], count: 0 }
  for (const note of notes) {
    let node = root
    node.count++
    for (const part of normalizeTag(note.tag).split(TAG_SEP).filter(Boolean)) {
      if (!node.groups.has(part)) {
        node.groups.set(part, {
          name: part, path: node.path ? node.path + TAG_SEP + part : part,
          groups: new Map(), notes: [], count: 0,
        })
      }
      node = node.groups.get(part)
      node.count++
    }
    node.notes.push(note)
  }
  return root
}

// ── storage ──────────────────────────────────────────────────────────────────

// For this session only. This hub keeps no copy of its content on disk, and a
// note's text should not be the first thing to change that.
const session = new Map()
const cacheGet = async key => session.get(key) ?? null
const cachePut = (key, entry) => { session.set(key, entry) }
let folderPromise = null
function folder() {
  return folderPromise ??= moduleFolderId(Store.mod)
    .then(id => ensureFolder(id, FOLDER))
    .catch(e => { folderPromise = null; throw e })
}
const stripExt = n => n.endsWith(EXT) ? n.slice(0, -EXT.length) : n
const FIELDS = 'id,name,modifiedTime,description'

async function listNotes() {
  const run = async () => (await listFiles(await folder(), FIELDS))
    .filter(f => f.name.endsWith(EXT))
    .map(f => ({ id: f.id, name: stripExt(f.name), modifiedTime: f.modifiedTime, tag: f.description ?? '' }))
    .sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)))
  try { return await run() }
  catch (e) {
    if (e?.status !== 404) throw e
    // The folder was removed behind a remembered id, so find or make it again.
    clearIdCache(); folderPromise = null
    return run()
  }
}
const bodyBlob = html => new Blob([html], { type: 'text/html' })
const LIST_KEY = 'scratch/list'
const bodyKey = id => `scratch/${id}`

// ── the panel ────────────────────────────────────────────────────────────────

export function installScratchPad() {
  const swatches = document.getElementById('themeSwatches')
  // Notes are written to Store.mod's own folder, so a page that does not know
  // its module gets no button.
  if (!swatches || !Store.mod) return

  document.head.appendChild(el('style', { textContent: CSS }))

  const lastKey = `scratch-last:${Store.mod}`
  const collapsedKey = `scratch-collapsed:${Store.mod}`
  const readNum = k => { const v = Number(LS.get(k)); return v > 0 ? v : 0 }

  const S = {
    open: false, notes: [], id: null, name: '', tag: '', tab: 'draw', html: '', hwDoc: null,
    dirty: false, rev: 0, saving: null, autoSaving: false, busy: null, err: null,
    height: readNum('scratch-h') || Math.round(innerHeight * DEFAULT_H),
    width:  readNum('scratch-w') || Math.round(innerWidth * DEFAULT_W),
    dock: DOCKS.includes(LS.get('scratch-dock')) ? LS.get('scratch-dock') : 'bottom',
    narrow: innerWidth <= SIDE_DOCK_MIN_VW,
    navOpen: LS.get('scratch-nav') !== '0',
    compact: false, compactOpen: false, lastBody: '',
    collapsed: new Set(),
  }
  try { S.collapsed = new Set(JSON.parse(LS.get(collapsedKey) || '[]')) } catch {}

  const isSide = () => !S.narrow && S.dock !== 'bottom'
  const maxH = () => Math.max(MIN_H, innerHeight - 48)
  const maxW = () => Math.max(MIN_W, innerWidth - 48)
  const clampH = h => Math.min(maxH(), Math.max(MIN_H, h))
  const clampW = w => Math.min(maxW(), Math.max(MIN_W, w))
  S.height = clampH(S.height); S.width = clampW(S.width)

  // ── DOM ────────────────────────────────────────────────────────────────────
  const launch = el('button', { type: 'button', className: 'pghub-scratch-launch', innerHTML: ICON })
  launch.setAttribute('aria-label', 'Scratch Pad')
  swatches.before(launch)

  const panel = el('section', { id: 'pghub-scratch', hidden: true })
  panel.setAttribute('aria-label', 'Scratch Pad')

  const grip = el('div', { className: 'sp-grip', title: 'Drag to resize · double-click to maximise' })
  grip.setAttribute('role', 'separator')
  grip.setAttribute('aria-label', 'Resize scratch pad')

  const nameInput = el('input', { className: 'sp-name', title: 'Rename this note' })
  nameInput.setAttribute('aria-label', 'Note name')
  const tagInput = el('input', {
    className: 'sp-tag', placeholder: 'Tag, e.g. Hooks::Effects',
    title: 'Files the note in the list. Use :: to nest.',
  })
  tagInput.setAttribute('aria-label', 'Note tag')
  const tagList = el('datalist', { id: 'pghub-scratch-tags' })
  tagInput.setAttribute('list', tagList.id)
  const navBtn = button('sp-icon-btn', ICONS.sidebar, 'Show or hide the notes', toggleNav)
  const delBtn = button('sp-icon-btn sp-danger-hover', ICONS.trash, 'Move this note to the trash', removeNote)
  const tabsBox = el('div', { className: 'sp-seg' })
  tabsBox.setAttribute('role', 'group')
  tabsBox.setAttribute('aria-label', 'Editing mode')
  const stateText = el('span', { className: 'sp-state-text' })
  const stateEl = el('span', { className: 'sp-state' }, stateText)
  stateEl.setAttribute('role', 'status')
  const saveBtn = button('sp-text-btn sp-primary sp-save', ICONS.save + '', 'Save (⌘S)', () => { void persist(false) })
  saveBtn.append(el('span', { textContent: 'Save' }))
  const dockBtn = button('sp-icon-btn', ICONS.dockBottom, 'Dock', cycleDock)
  const maxBtn  = button('sp-icon-btn', ICONS.expand, 'Maximise', toggleMax)
  const tagIcon = el('span', { innerHTML: ICONS.tag })
  const header = el('header', { className: 'sp-hd' },
    navBtn,
    el('div', { className: 'sp-title' }, nameInput, el('div', { className: 'sp-tag-row' }, tagIcon, tagInput), tagList),
    tabsBox,
    el('div', { className: 'sp-actions' }, stateEl, saveBtn, delBtn, dockBtn, maxBtn,
      button('sp-icon-btn sp-danger-hover', ICONS.close, 'Close Scratch Pad', () => toggle(false))))

  const tree = el('div', { className: 'sp-tree' })
  const newBtn = button('sp-new', ICONS.plus, 'New note', () => { void newNote() })
  newBtn.append(el('span', { textContent: 'New note' }))
  const nav = el('nav', { className: 'sp-nav' },
    newBtn, tree)
  nav.setAttribute('aria-label', 'Scratch notes')

  const body = el('div', { className: 'sp-body' })
  const scrollBox = el('div', { className: 'sp-scroll', hidden: true },
    button('', ICONS.up, 'Scroll up', () => scrollBody(-1)),
    button('', ICONS.down, 'Scroll down', () => scrollBody(1)))
  const main = el('div', { className: 'sp-main' }, nav, body, scrollBox)
  panel.append(grip, header, main)
  document.body.append(panel)

  for (const [id, text, title, icon] of TABS) {
    const b = button('', icon, title, () => setTab(id))
    b.append(el('span', { textContent: text }))
    b.dataset.tab = id
    tabsBox.append(b)
  }

  // ── header state ───────────────────────────────────────────────────────────
  function paintState() {
    const kind = S.err ? 'err' : S.busy || S.autoSaving ? 'busy' : S.dirty ? 'dirty' : S.id ? 'saved' : 'new'
    stateEl.dataset.kind = kind
    stateEl.title = S.err ?? ''
    stateText.textContent = S.err ? S.err : S.busy ?? (S.autoSaving ? 'Saving…'
      : S.dirty ? 'Unsaved'
      // A blank note has never been saved; "Saved" would claim a file exists.
      : S.id ? 'Saved' : 'New')
    saveBtn.disabled = !!S.busy || (!S.id && !S.dirty)
    delBtn.disabled = !S.id
    for (const b of tabsBox.children) b.classList.toggle('active', b.dataset.tab === S.tab)
  }
  function paintFrame() {
    const side = isSide()
    panel.className = `dock-${side ? S.dock : 'bottom'}` +
      (S.compact ? ' compact' : '') +
      ((S.compact ? S.compactOpen : S.navOpen) ? '' : ' nav-hidden')
    panel.style.height = side ? '' : `${S.height}px`
    panel.style.width  = side ? `${S.width}px` : ''
    const top = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0
    panel.style.setProperty('--sp-top', `${Math.max(0, top)}px`)
    const meta = DOCK_META[S.dock]
    const next = DOCK_META[DOCKS[(DOCKS.indexOf(S.dock) + 1) % DOCKS.length]]
    dockBtn.innerHTML = DOCK_META[side ? S.dock : 'bottom'].icon
    dockBtn.disabled = S.narrow
    dockBtn.title = S.narrow
      ? 'Side docks need a wider window: the pad stays at the bottom here'
      : `Dock: ${meta.label} — click for ${next.label}`
    const isMax = side ? S.width >= maxW() - 2 : S.height >= maxH() - 2
    maxBtn.innerHTML = isMax ? ICONS.shrink : ICONS.expand
    maxBtn.title = isMax ? 'Restore' : 'Maximise'
    navBtn.classList.toggle('active', S.compact ? S.compactOpen : S.navOpen)
    grip.setAttribute('aria-orientation', side ? 'vertical' : 'horizontal')
  }

  // ── the note tree ──────────────────────────────────────────────────────────
  function shownNotes() {
    if (S.id) return S.notes
    const blank = !S.dirty && !S.tag && !S.html
    return blank ? S.notes : [{ id: null, name: S.name, tag: S.tag }, ...S.notes]
  }
  function paintTree() {
    const notes = shownNotes()
    const paths = new Set()
    for (const n of S.notes) {
      const parts = normalizeTag(n.tag).split(TAG_SEP).filter(Boolean)
      parts.forEach((_, i) => paths.add(parts.slice(0, i + 1).join(TAG_SEP)))
    }
    tagList.replaceChildren(...[...paths].sort().map(p => el('option', { value: p })))
    tree.replaceChildren()
    if (!notes.length) {
      tree.append(el('div', { className: 'sp-tree-empty', textContent: 'No notes yet. Write something and it is saved here.' }))
      return
    }
    const walk = (node, depth) => {
      const pad = `${6 + depth * 12}px`
      const groups = [...node.groups.values()].sort((a, b) => a.name.localeCompare(b.name))
      for (const g of groups) {
        const open = !S.collapsed.has(g.path)
        const row = el('button', { type: 'button', className: 'sp-row sp-group', title: g.path },
          el('span', { className: 'sp-caret', innerHTML: open ? ICONS.down : ICONS.next }),
          el('span', { className: 'sp-label', textContent: g.name }),
          el('span', { className: 'sp-count', textContent: String(g.count) }))
        row.style.paddingLeft = pad
        row.setAttribute('aria-expanded', String(open))
        row.addEventListener('click', () => toggleGroup(g.path))
        tree.append(row)
        if (open) walk(g, depth + 1)
      }
      for (const n of node.notes) {
        const current = n.id === S.id
        const row = el('button', {
          type: 'button', className: `sp-row sp-note${n.id ? '' : ' draft'}`,
          title: n.tag ? `${n.tag} › ${n.name}` : n.name,
        },
          el('span', { className: 'sp-caret' }),
          el('span', { className: 'sp-note-text' },
            el('span', { className: 'sp-label', textContent: n.name || 'Untitled' }),
            el('span', { className: 'sp-when', textContent: n.id ? timeAgo(n.modifiedTime) : 'Not saved yet' })))
        row.style.paddingLeft = pad
        if (current) row.setAttribute('aria-current', 'true')
        if (n.id) row.addEventListener('click', () => { void switchNote(n.id) })
        tree.append(row)
      }
    }
    walk(buildTree(notes), 0)
  }
  function saveCollapsed() { LS.set(collapsedKey, JSON.stringify([...S.collapsed])) }
  function toggleGroup(path) {
    if (S.collapsed.has(path)) S.collapsed.delete(path)
    else S.collapsed.add(path)
    saveCollapsed(); paintTree()
  }
  /** Opens every group above a tag, so the current note is never hidden. */
  function revealTag(tag) {
    const parts = normalizeTag(tag).split(TAG_SEP).filter(Boolean)
    let changed = false
    parts.forEach((_, i) => {
      if (S.collapsed.delete(parts.slice(0, i + 1).join(TAG_SEP))) changed = true
    })
    if (changed) saveCollapsed()
  }
  function toggleNav() {
    if (S.compact) S.compactOpen = !S.compactOpen
    else {
      S.navOpen = !S.navOpen
      LS.set('scratch-nav', S.navOpen ? '1' : '0')
    }
    paintFrame()
  }

  // ── the writing surface ────────────────────────────────────────────────────
  let surface = null      // { destroy, getDoc? } for the mode on screen
  function markEdited() {
    S.dirty = true; S.rev++
    schedule(); paintState()
    if (!S.id) paintTree()
  }
  function keepDrawing() {
    if (surface?.getDoc) S.hwDoc = surface.getDoc()
  }
  function paintBody() {
    surface?.destroy?.()
    surface = null
    body.className = `sp-body${S.tab === 'draw' ? ' is-draw' : ''}`
    body.replaceChildren()
    if (S.tab === 'rich') {
      const ed = createRichEditor({
        value: S.html, dialogHost: main,
        onChange: v => { S.html = v; markEdited() },
      })
      surface = ed
      body.append(ed.el)
    } else if (S.tab === 'html') {
      const t = el('textarea', { className: 'sp-html', value: S.html, spellcheck: false, placeholder: '<p>Paste or write raw HTML…</p>' })
      t.addEventListener('input', () => { S.html = t.value; markEdited() })
      body.append(t)
    } else if (S.tab === 'preview') {
      const preview = el('div', { className: 'sp-preview rich', innerHTML: sanitize(S.html) })
      // A link in a note must not navigate the page out from under the pad.
      preview.addEventListener('click', e => {
        const a = e.target.closest?.('a[href]')
        if (!a) return
        e.preventDefault()
        if (/^https?:/i.test(a.getAttribute('href'))) open(a.href, '_blank', 'noopener')
      })
      body.append(preview)
    } else {
      const pad = createDrawPad({ doc: S.hwDoc, onChange: markEdited, onView: measure })
      surface = pad
      body.append(pad.el)
    }
    paintState()
    measure()
    setTimeout(measure, 120)   // layout settles a tick after a mode switch
  }
  function setTab(tab) {
    if (tab === S.tab) return
    keepDrawing()
    S.tab = tab
    paintBody()
  }

  // ── floating scroll buttons ────────────────────────────────────────────────
  // In Draw the overflow lives in the pad's own pane, whose touch-action stops a
  // finger scrolling it, so these are how a phone moves down the page.
  function scroller() {
    if (body.scrollHeight > body.clientHeight + 4) return body
    const inner = body.querySelector('.hw-canvas-wrap')
    return inner && inner.scrollHeight > inner.clientHeight + 4 ? inner : null
  }
  function measure() { scrollBox.hidden = !scroller() }
  function scrollBody(dir) {
    const t = scroller()
    if (t) t.scrollBy({ top: dir * Math.max(80, t.clientHeight * 0.45), behavior: 'smooth' })
  }

  // ── loading ────────────────────────────────────────────────────────────────
  function applyBody(id, text) {
    const note = S.notes.find(n => n.id === id)
    S.id = id
    S.name = note?.name ?? S.name
    S.tag = note?.tag ?? ''
    S.hwDoc = parseHwDoc(text)
    S.html = textOf(text)
    S.tab = S.hwDoc && !S.html ? 'draw' : 'rich'
    S.dirty = false
    S.lastBody = text
    nameInput.value = S.name; tagInput.value = S.tag
    revealTag(S.tag)
    paintBody(); paintTree()
  }

  // Cache first, then Drive. A reply only replaces what is on screen if it still
  // applies and nothing has been typed since it was requested.
  let openSeq = 0
  async function openNote(id, knownMod) {
    const seq = ++openSeq
    const hit = await cacheGet(bodyKey(id))
    if (seq !== openSeq) return
    const usable = typeof hit?.data === 'string'
    if (usable) applyBody(id, hit.data)
    else { S.busy = 'Loading…'; paintState() }
    S.err = null
    LS.set(lastKey, id)
    if (usable && knownMod && hit.modifiedTime === knownMod) { paintState(); return }
    const revAtStart = S.rev
    try {
      const text = await readTextById(id)
      void cachePut(bodyKey(id), { data: text, modifiedTime: knownMod ?? new Date().toISOString() })
      if (seq === openSeq && S.rev === revAtStart && !S.dirty && (S.id !== id || text !== S.lastBody)) {
        applyBody(id, text)
      }
    } catch (e) {
      // A cached note on screen is still usable, so only say so if there is none.
      if (!usable && seq === openSeq) S.err = e.message
    } finally {
      if (seq === openSeq) { S.busy = null; paintState() }
    }
  }
  function blankNote() {
    openSeq++
    S.id = null; S.name = defaultName(); S.tag = ''
    S.html = ''; S.hwDoc = null; S.tab = 'draw'; S.dirty = false; S.lastBody = ''
    nameInput.value = S.name; tagInput.value = ''
    LS.del(lastKey)
    paintBody(); paintTree()
  }
  async function switchNote(id) {
    if (id === S.id) { closeCompactNav(); return }
    if (!await settle()) return
    closeCompactNav()
    await openNote(id, S.notes.find(n => n.id === id)?.modifiedTime)
  }
  async function newNote() {
    if (!await settle()) return
    closeCompactNav()
    blankNote()
    nameInput.focus(); nameInput.select()
  }
  function closeCompactNav() {
    if (S.compact && S.compactOpen) { S.compactOpen = false; paintFrame() }
  }

  let loadedOnce = false
  async function load() {
    const last = LS.get(lastKey)
    if (!loadedOnce) {
      if (last) void openNote(last)
      else blankNote()
    }
    const cached = await cacheGet(LIST_KEY)
    if (Array.isArray(cached?.data) && !S.notes.length) { S.notes = cached.data; syncCurrentMeta(); paintTree() }
    try {
      const list = await listNotes()
      S.notes = list
      void cachePut(LIST_KEY, { data: list })
      const stillThere = !!last && list.some(n => n.id === last)
      if (last && !stillThere && S.id === last) { LS.del(lastKey); blankNote() }
      else if (last && !stillThere && !loadedOnce) LS.del(lastKey)
      // Nothing remembered: resume the newest note rather than a blank page.
      if (!loadedOnce && !stillThere && !S.id && !S.dirty && list[0]) void openNote(list[0].id, list[0].modifiedTime)
      syncCurrentMeta()
      paintTree()
    } catch (e) {
      S.err = e.message
    } finally {
      loadedOnce = true
      paintState()
    }
  }
  /** A note opened before the list arrived has no name or tag yet. */
  function syncCurrentMeta() {
    const n = S.notes.find(x => x.id === S.id)
    if (!n) return
    if (document.activeElement !== nameInput) { S.name = n.name; nameInput.value = n.name }
    if (document.activeElement !== tagInput) { S.tag = n.tag; tagInput.value = n.tag }
    revealTag(n.tag)
  }

  // ── saving ─────────────────────────────────────────────────────────────────
  function composeBody() {
    keepDrawing()
    const doc = S.hwDoc
    const drawing = doc?.pages?.some(p => p.strokes.length) ? hwDocToBlockHtml(doc) : ''
    return [S.html, drawing].filter(Boolean).join('\n')
  }
  let timer = null
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => { void persist(true) }, AUTOSAVE_MS)
  }
  // One write at a time. A caller arriving mid-write shares it, and an edit made
  // during the write gets a pass of its own afterwards.
  function persist(silent) {
    clearTimeout(timer)
    if (S.saving) return S.saving
    S.saving = write(silent).finally(() => { S.saving = null })
    return S.saving
  }
  async function write(silent) {
    const startedAt = S.rev
    const text = composeBody()
    // Never conjure a file out of an untouched note.
    if (!S.id && !text.trim() && !normalizeTag(S.tag)) { S.dirty = false; paintState(); return }
    if (silent) S.autoSaving = true; else S.busy = 'Saving…'
    S.err = null
    paintState()
    try {
      let id = S.id
      if (id) {
        await updateFile(id, bodyBlob(text))
        const at = new Date().toISOString()
        S.notes = S.notes.map(n => n.id === id ? { ...n, modifiedTime: at } : n)
      } else {
        const name = nameInput.value.trim() || defaultName()
        const tag = normalizeTag(tagInput.value)
        id = await createFile(await folder(), name + EXT, bodyBlob(text), tag ? { description: tag } : {})
        S.id = id
        S.name = name; S.tag = tag
        nameInput.value = name; tagInput.value = tag
        LS.set(lastKey, id)
        S.notes = [{ id, name, tag, modifiedTime: new Date().toISOString() }, ...S.notes]
        revealTag(tag)
        paintTree()
      }
      S.lastBody = text
      void cachePut(bodyKey(id), { data: text, modifiedTime: new Date().toISOString() })
      void cachePut(LIST_KEY, { data: S.notes })
      if (S.rev === startedAt) S.dirty = false
    } catch (e) {
      S.err = e.message
    } finally {
      if (silent) S.autoSaving = false; else S.busy = null
      paintState()
      if (S.rev !== startedAt) schedule()
    }
  }
  /** Waits for the note on screen to be safely in Drive. False if it could not be. */
  async function settle() {
    clearTimeout(timer)
    while (S.saving) await S.saving
    if (S.dirty) await persist(true)
    while (S.saving) await S.saving
    return !S.dirty
  }

  // ── rename, tag, delete ────────────────────────────────────────────────────
  function replaceMeta(id, patch) {
    S.notes = S.notes.map(n => n.id === id ? { ...n, ...patch } : n)
    void cachePut(LIST_KEY, { data: S.notes })
    paintTree()
  }
  async function commitName() {
    const next = nameInput.value.trim()
    if (!S.id) {
      if (!next) nameInput.value = defaultName()
      S.name = nameInput.value
      paintTree()
      return
    }
    const current = S.notes.find(n => n.id === S.id)
    if (!next || !current || next === current.name) { nameInput.value = current?.name ?? S.name; return }
    const id = S.id
    try {
      await patchFile(id, { name: next + EXT })
      S.name = next
      replaceMeta(id, { name: next })
    } catch (e) {
      S.err = e.message; nameInput.value = current.name; paintState()
    }
  }
  async function commitTag() {
    const next = normalizeTag(tagInput.value)
    tagInput.value = next
    if (!S.id) {
      S.tag = next
      revealTag(next)
      paintTree()
      if (next) { S.dirty = true; S.rev++; schedule(); paintState() }
      return
    }
    const current = S.notes.find(n => n.id === S.id)
    if (!current || next === normalizeTag(current.tag)) return
    const id = S.id
    try {
      await patchFile(id, { description: next })
      S.tag = next
      revealTag(next)
      replaceMeta(id, { tag: next })
    } catch (e) {
      S.err = e.message; tagInput.value = current.tag; paintState()
    }
  }
  async function removeNote() {
    const note = S.notes.find(n => n.id === S.id)
    if (!S.id || !note) return
    if (!confirm(`Move “${note.name}” to the trash?`)) return
    clearTimeout(timer)
    while (S.saving) await S.saving
    const id = S.id
    S.busy = 'Deleting…'; S.err = null; paintState()
    try {
      await patchFile(id, { trashed: true })
      void cachePut(bodyKey(id), { data: null })
      S.notes = S.notes.filter(n => n.id !== id)
      void cachePut(LIST_KEY, { data: S.notes })
      S.dirty = false
      LS.del(lastKey)
      if (S.notes[0]) await openNote(S.notes[0].id, S.notes[0].modifiedTime)
      else blankNote()
    } catch (e) { S.err = e.message } finally { S.busy = null; paintState(); paintTree() }
  }
  nameInput.addEventListener('blur', () => { void commitName() })
  tagInput.addEventListener('blur', () => { void commitTag() })
  for (const input of [nameInput, tagInput]) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur() }
    })
  }

  // ── placement ──────────────────────────────────────────────────────────────
  function cycleDock() {
    S.dock = DOCKS[(DOCKS.indexOf(S.dock) + 1) % DOCKS.length]
    LS.set('scratch-dock', S.dock)
    paintFrame()
    measure()
  }
  function saveSize() {
    LS.set('scratch-h', String(Math.round(S.height)))
    LS.set('scratch-w', String(Math.round(S.width)))
  }
  function toggleMax() {
    if (isSide()) S.width = S.width >= maxW() - 2 ? Math.round(innerWidth * DEFAULT_W) : maxW()
    else S.height = S.height >= maxH() - 2 ? Math.round(innerHeight * DEFAULT_H) : maxH()
    saveSize(); paintFrame(); measure()
  }
  let dragging = false
  grip.addEventListener('pointerdown', e => {
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    dragging = true
    document.body.classList.add(isSide() ? 'sp-resizing-h' : 'sp-resizing-v')
  })
  grip.addEventListener('pointermove', e => {
    if (!dragging) return
    const gap = S.narrow ? 0 : SHEET_GAP
    if (!isSide()) S.height = clampH(innerHeight - e.clientY - gap)
    else if (S.dock === 'left') S.width = clampW(e.clientX - gap)
    else S.width = clampW(innerWidth - e.clientX - gap)
    paintFrame()
  })
  const gripUp = e => {
    if (!dragging) return
    dragging = false
    try { grip.releasePointerCapture(e.pointerId) } catch {}
    document.body.classList.remove('sp-resizing-h', 'sp-resizing-v')
    saveSize(); measure()
  }
  grip.addEventListener('pointerup', gripUp)
  grip.addEventListener('pointercancel', gripUp)
  grip.addEventListener('dblclick', toggleMax)

  addEventListener('resize', () => {
    S.height = clampH(S.height); S.width = clampW(S.width)
    S.narrow = innerWidth <= SIDE_DOCK_MIN_VW
    if (S.open) { paintFrame(); measure() }
  })
  // Whether the list fits beside the page depends on the pad's own width, which
  // docking and dragging change as well as the window.
  new ResizeObserver(() => {
    const compact = panel.clientWidth > 0 && panel.clientWidth < COMPACT_W
    if (compact !== S.compact) {
      S.compact = compact
      S.compactOpen = false
      paintFrame()
    }
    measure()
  }).observe(panel)
  body.addEventListener('scroll', measure, { capture: true, passive: true })

  // ── open and close ─────────────────────────────────────────────────────────
  function toggle(open) {
    if (open === S.open) return
    S.open = open
    panel.hidden = !open
    panel.style.display = open ? '' : 'none'
    launch.classList.toggle('active', open)
    document.body.classList.toggle('sp-open', open)
    launch.title = open ? 'Close Scratch Pad' : 'Scratch Pad'
    if (open) {
      paintFrame()
      if (loadedOnce) { paintBody(); paintTree() }
      void load()
    } else if (S.dirty) {
      keepDrawing()
      void persist(true)
    }
  }
  launch.title = 'Scratch Pad'
  panel.style.display = 'none'
  launch.addEventListener('click', () => toggle(!S.open))

  document.addEventListener('keydown', e => {
    if (!S.open) return
    if (e.key === 'Escape' && !e.target.closest?.('.sp-dialog, #pghub-ai')) toggle(false)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void persist(false)
    }
  })
  // On a phone, going to the background is how a session usually ends.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && S.dirty) void persist(true)
  })
  addEventListener('beforeunload', e => {
    if (S.dirty || S.saving) { e.preventDefault(); e.returnValue = '' }
  })
}
