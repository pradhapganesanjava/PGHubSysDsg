/* The Scratch Pad's drawing mode, without React.
 *
 * A port of the portal's HandwritingPad (pghubtech: portal/src/components/
 * HandwritingPad.tsx). It keeps the same document shape and the same baked
 * `.hw-doc` block, so a body written by either app opens in the other. Only the
 * portal's recommended engine is here — every stroke an SVG <path> — because
 * the other four exist to compare engines, and a picker for them is a
 * diagnostic rather than a drawing tool.
 *
 * Strokes live in a 1000x1400 logical page. Zoom only changes how large that
 * page is rendered, so what gets saved does not depend on the zoom it was
 * written at.
 */
import { getStroke } from '../vendor/perfect-freehand.js'
import { ICONS } from './scratch-icons.js'

const PAGE_W = 1000
const PAGE_H = 1400
const COLORS = ['#1a1a2e', '#e94545', '#2563eb', '#16a34a', '#f59e0b', '#9333ea']
const SIZES  = [2, 4, 7]
const ERASE_R = 18
const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4]
const MIN_ZOOM = ZOOM_STEPS[0]
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]
const clampZoom = z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
const BAR_KEY = 'pghub.hw.bar'
const SVG_NS = 'http://www.w3.org/2000/svg'

const pfOptions = size => ({
  size, thinning: 0.55, smoothing: 0.55, streamline: 0.45,
  easing: t => t, simulatePressure: false, last: true,
})

function strokeToSvgD(s) {
  const outline = getStroke(s.points, pfOptions(s.size))
  if (!outline.length) return ''
  let d = `M${outline[0][0].toFixed(2)},${outline[0][1].toFixed(2)}`
  for (let i = 1; i < outline.length; i++) d += `L${outline[i][0].toFixed(2)},${outline[i][1].toFixed(2)}`
  return d + 'Z'
}

function hwDocToSvg(doc) {
  return (doc.pages ?? []).map(p => {
    const paths = (p.strokes ?? []).map(s => {
      const d = strokeToSvgD(s)
      return d ? `<path d="${d}" fill="${s.color}"/>` : ''
    }).join('')
    return `<svg class="hw-page-svg" viewBox="0 0 ${PAGE_W} ${PAGE_H}" ` +
      `preserveAspectRatio="xMidYMid meet" xmlns="${SVG_NS}" ` +
      `style="display:block;width:100%;max-width:420px;height:auto;margin:6px 0;` +
      `border:1px solid #e2e2ea;border-radius:8px;background:#fff">${paths}</svg>`
  }).join('')
}

export function hwDocToBlockHtml(doc) {
  const wrap = document.createElement('div')
  wrap.className = 'hw-doc'
  wrap.setAttribute('data-doc', JSON.stringify(doc))   // outerHTML escapes the attribute
  wrap.innerHTML = hwDocToSvg(doc)
  return wrap.outerHTML
}

export function parseHwDoc(html) {
  try {
    const el = new DOMParser().parseFromString(html, 'text/html').querySelector('.hw-doc')
    return el ? JSON.parse(el.getAttribute('data-doc') ?? '') : null
  } catch { return null }
}

const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  return n
}

/** Returns { el, getDoc(), destroy() }. onChange fires on every edit, never on open. */
export function createDrawPad({ doc, onChange, onView }) {
  let pages = doc?.pages?.length
    ? doc.pages.map(p => ({ strokes: p.strokes ?? [] }))
    : [{ strokes: [] }]
  let pageIdx = 0
  let tool = 'pen', color = COLORS[0], size = SIZES[1], zoom = 1
  let barOpen = true
  try { barOpen = localStorage.getItem(BAR_KEY) !== '0' } catch {}
  let advOpen = false
  let active = null, activePath = null, raf = null

  const root  = document.createElement('div')
  root.className = 'hw-wrap hw-wrap-float'
  const fab   = document.createElement('div')
  const wrap  = document.createElement('div')
  wrap.className = 'hw-canvas-wrap'
  const stack = document.createElement('div')
  stack.className = 'hw-canvas-stack'
  const svg   = svgEl('svg', { class: 'hw-canvas', viewBox: `0 0 ${PAGE_W} ${PAGE_H}`, preserveAspectRatio: 'xMidYMid meet' })
  const lens  = document.createElement('div')
  lens.className = 'hw-lens'
  lens.title = 'Where you are on the page — tap or drag to move'
  const lensPage = svgEl('svg', { class: 'hw-lens-page', viewBox: `0 0 ${PAGE_W} ${PAGE_H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' })
  const lensView = document.createElement('div')
  lensView.className = 'hw-lens-view'
  lens.append(lensPage, lensView)
  stack.append(svg); wrap.append(stack); root.append(fab, lens, wrap)

  const page = () => pages[pageIdx] ?? { strokes: [] }
  const changed = () => onChange?.({ pages })

  function committedPath(s) {
    return svgEl('path', { d: strokeToSvgD(s), fill: s.color, 'pointer-events': 'none' })
  }
  function paint() {
    svg.replaceChildren(...page().strokes.map(committedPath))
    paintLens()
  }
  function paintLens() {
    lens.style.display = zoom > 1 ? '' : 'none'
    if (zoom <= 1) return
    // Raw points at low detail: this is a position map about 70px wide.
    lensPage.replaceChildren(...page().strokes.map(st => svgEl('polyline', {
      fill: 'none', stroke: st.color, 'stroke-width': Math.max(6, st.size * 2),
      points: st.points.filter((_, k) => k % 4 === 0).map(pt => `${pt[0]},${pt[1]}`).join(' '),
    })))
    paintLensView()
  }
  function paintLensView() {
    const sw = Math.max(1, wrap.scrollWidth), sh = Math.max(1, wrap.scrollHeight)
    lensView.style.left   = `${(wrap.scrollLeft / sw) * 100}%`
    lensView.style.top    = `${(wrap.scrollTop / sh) * 100}%`
    lensView.style.width  = `${Math.min(100, (wrap.clientWidth / sw) * 100)}%`
    lensView.style.height = `${Math.min(100, (wrap.clientHeight / sh) * 100)}%`
  }

  // ── the floating tool cluster ──────────────────────────────────────────────
  const btn = (cls, label, title, on, opts = {}) => {
    const b = document.createElement('button')
    b.type = 'button'; b.className = cls; b.title = title
    b.setAttribute('aria-label', title)
    if (label.startsWith('<svg')) b.innerHTML = label
    else b.textContent = label
    if (opts.disabled) b.disabled = true
    b.addEventListener('click', on)
    return b
  }
  const row = (...kids) => {
    const r = document.createElement('div')
    r.className = 'hw-fab-row'; r.append(...kids)
    return r
  }
  const label = (text, title) => {
    const s = document.createElement('span')
    s.className = 'hw-pageno'; s.textContent = text
    if (title) s.title = title
    return s
  }
  const toolBtn = (id, glyph, title) =>
    btn(`hw-tool${tool === id ? ' active' : ''}`, glyph, title, () => { setTool(id); paintFab() })

  function setTool(id) {
    tool = id
    // A finger can only scroll the page when nothing up the tree forbids it.
    wrap.classList.toggle('hw-panning', id === 'pan')
  }
  function paintFab() {
    fab.className = `hw-fab${barOpen ? ' open' : ''}`
    const kids = []
    if (barOpen) {
      const panel = document.createElement('div')
      panel.className = 'hw-fab-panel'
      panel.setAttribute('role', 'toolbar')
      panel.setAttribute('aria-label', 'Drawing tools')
      const swatches = COLORS.map(c => {
        const b = btn(`hw-swatch${color === c && tool === 'pen' ? ' active' : ''}`, '', c,
          () => { color = c; setTool('pen'); paintFab() })
        b.style.background = c
        return b
      })
      const sizes = SIZES.map(s => {
        const b = btn(`hw-size${size === s ? ' active' : ''}`, '', `${s}px`, () => { size = s; paintFab() })
        const dot = document.createElement('span')
        dot.style.width = dot.style.height = `${s + 2}px`
        b.append(dot)
        return b
      })
      const atFit = zoom === MIN_ZOOM && !wrap.scrollTop && !wrap.scrollLeft
      panel.append(
        row(toolBtn('pen', ICONS.pen, 'Pen'), toolBtn('eraser', ICONS.eraser, 'Eraser'), toolBtn('pan', ICONS.hand, 'Pan / scroll (no drawing)')),
        row(...swatches),
        row(...sizes),
        row(btn('hw-tool', ICONS.undo, 'Undo last stroke', undo), btn('hw-tool', ICONS.close, 'Clear page', clearPage)),
        row(
          btn('hw-tool', '−', 'Zoom out', () => stepZoom(-1), { disabled: zoom <= MIN_ZOOM + 1e-3 }),
          label(`${Math.round(zoom * 100)}%`, 'Zoom — the page and what you save are unchanged'),
          btn('hw-tool', '+', 'Zoom in', () => stepZoom(1), { disabled: zoom >= MAX_ZOOM - 1e-3 }),
          btn('hw-tool', ICONS.fit, 'Fit the whole page again', resetView, { disabled: atFit })),
        row(
          btn('hw-tool', ICONS.prev, 'Previous page', () => goPage(pageIdx - 1), { disabled: pageIdx === 0 }),
          label(`${pageIdx + 1}/${pages.length}`),
          btn('hw-tool', ICONS.next, 'Next page', () => goPage(pageIdx + 1), { disabled: pageIdx >= pages.length - 1 }),
          btn('hw-tool', ICONS.plus, 'Add page', addPage),
          btn('hw-tool', ICONS.trash, 'Delete page', deletePage)),
        row(
          btn(`hw-tool${advOpen ? ' active' : ''}`, ICONS.more, 'Stroke count', () => { advOpen = !advOpen; paintFab() }),
          ...(advOpen ? [label(`${page().strokes.length} strokes`, 'Strokes committed on this page')] : [])),
      )
      kids.push(panel)
    }
    const toggle = btn('hw-fab-btn',
      barOpen ? ICONS.close : tool === 'pen' ? ICONS.pen : tool === 'eraser' ? ICONS.eraser : ICONS.hand,
      barOpen ? 'Hide tools' : 'Show tools',
      () => {
        barOpen = !barOpen
        try { localStorage.setItem(BAR_KEY, barOpen ? '1' : '0') } catch {}
        paintFab()
      })
    toggle.setAttribute('aria-expanded', String(barOpen))
    toggle.setAttribute('aria-label', barOpen ? 'Hide drawing tools' : 'Show drawing tools')
    // The ring carries the live colour, so a closed cluster still answers
    // "what am I about to draw with?".
    if (tool === 'pen') toggle.style.borderColor = color
    kids.push(toggle)
    fab.replaceChildren(...kids)
  }

  // ── editing ────────────────────────────────────────────────────────────────
  function setPage(strokes) {
    pages = pages.map((p, i) => i === pageIdx ? { strokes } : p)
  }
  function undo() {
    if (!page().strokes.length) return
    setPage(page().strokes.slice(0, -1)); paint(); paintFab(); changed()
  }
  function clearPage() {
    setPage([]); paint(); paintFab(); changed()
  }
  function goPage(i) {
    pageIdx = Math.min(pages.length - 1, Math.max(0, i)); paint(); paintFab()
  }
  function addPage() {
    pages = [...pages, { strokes: [] }]; pageIdx = pages.length - 1
    paint(); paintFab(); changed()
  }
  function deletePage() {
    if (pages.length <= 1) return clearPage()
    pages = pages.filter((_, k) => k !== pageIdx)
    pageIdx = Math.max(0, pageIdx - 1)
    paint(); paintFab(); changed()
  }
  function erase(x, y) {
    const r2 = ERASE_R * ERASE_R
    const kept = page().strokes.filter(s => !s.points.some(p => (p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2))
    if (kept.length === page().strokes.length) return
    setPage(kept); paint(); changed()
  }
  function commit(stroke) {
    setPage([...page().strokes, stroke])
    svg.append(committedPath(stroke))     // old paths stay; only the new one is drawn
    if (zoom > 1) paintLens()
    if (advOpen) paintFab()
    changed()
  }

  // ── zoom ───────────────────────────────────────────────────────────────────
  // The fraction is measured before the width changes and spent after, or the
  // two scrollWidth reads cancel out and the anchor does nothing.
  function setZoom(next, anchor) {
    const r  = wrap.getBoundingClientRect()
    const ax = anchor ? anchor.x - r.left : wrap.clientWidth / 2
    const ay = anchor ? anchor.y - r.top  : wrap.clientHeight / 2
    const fx = (wrap.scrollLeft + ax) / Math.max(1, wrap.scrollWidth)
    const fy = (wrap.scrollTop + ay) / Math.max(1, wrap.scrollHeight)
    zoom = next
    wrap.style.setProperty('--hw-zoom', String(zoom))
    wrap.scrollLeft = fx * wrap.scrollWidth - ax
    wrap.scrollTop  = fy * wrap.scrollHeight - ay
    paintLens(); paintFab(); onView?.()
  }
  function stepZoom(dir) {
    const next = dir === 1
      ? ZOOM_STEPS.find(z => z > zoom + 1e-3) ?? MAX_ZOOM
      : [...ZOOM_STEPS].reverse().find(z => z < zoom - 1e-3) ?? MIN_ZOOM
    if (next !== zoom) setZoom(next)
  }
  function resetView() {
    zoom = MIN_ZOOM
    wrap.style.setProperty('--hw-zoom', '1')
    wrap.scrollTo({ left: 0, top: 0 })
    paintLens(); paintFab(); onView?.()
  }

  // ── pointer input ──────────────────────────────────────────────────────────
  // Native capture-phase listeners, as in the portal: iPadOS can swallow
  // alternate Pencil strokes before later handlers see them. A finger never
  // draws, so a palm resting on the page cannot leave a mark.
  const logical = e => {
    const r = svg.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width * PAGE_W, (e.clientY - r.top) / r.height * PAGE_H]
  }
  const endRaf = () => { if (raf != null) { cancelAnimationFrame(raf); raf = null } }
  const paintActive = () => {
    raf = null
    if (active && activePath) activePath.setAttribute('d', strokeToSvgD(active))
  }
  function finish() {
    const s = active
    active = null; endRaf()
    activePath?.remove(); activePath = null
    if (s?.points.length) commit(s)
  }
  const opts = { passive: false, capture: true }
  svg.addEventListener('pointerdown', e => {
    if (tool === 'pan' || e.pointerType === 'touch') return
    e.preventDefault(); e.stopPropagation()
    finish()                              // keep a stroke whose pointerup got lost
    try { svg.setPointerCapture(e.pointerId) } catch {}
    const [x, y] = logical(e)
    if (tool === 'eraser') return erase(x, y)
    active = { tool: 'pen', color, size, points: [[x, y, e.pressure || 0.5]] }
    activePath = svgEl('path', { fill: color, 'pointer-events': 'none' })
    svg.append(activePath)
    paintActive()
  }, opts)
  svg.addEventListener('pointermove', e => {
    if (tool === 'pan' || e.pointerType === 'touch') return
    e.preventDefault()
    if (tool === 'eraser') {
      if (e.buttons) { const [x, y] = logical(e); erase(x, y) }
      return
    }
    if (!active) return
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const [x, y] = logical(ev)
      active.points.push([x, y, ev.pressure || 0.5])
    }
    if (raf == null) raf = requestAnimationFrame(paintActive)
  }, opts)
  const up = () => { if (tool === 'pen') finish() }
  svg.addEventListener('pointerup', up, opts)
  svg.addEventListener('pointercancel', up, opts)
  svg.addEventListener('lostpointercapture', up, opts)
  // Palm contact and two-finger gestures must not cancel the active pen.
  const block = e => { if (tool !== 'pan') e.preventDefault() }
  for (const n of ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange', 'gestureend', 'contextmenu']) {
    svg.addEventListener(n, block, opts)
  }

  // ── pinch ──────────────────────────────────────────────────────────────────
  let pinch = null
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  const mid  = t => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 })
  wrap.addEventListener('touchstart', e => {
    if (e.touches.length < 2) return
    pinch = { d: dist(e.touches), zoom, mid: mid(e.touches) }
    e.preventDefault(); e.stopPropagation()
  }, opts)
  wrap.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length < 2) return
    e.preventDefault(); e.stopPropagation()
    const m = mid(e.touches)
    wrap.scrollLeft -= m.x - pinch.mid.x
    wrap.scrollTop  -= m.y - pinch.mid.y
    pinch.mid = m
    const next = clampZoom(pinch.zoom * (dist(e.touches) / Math.max(1, pinch.d)))
    if (Math.abs(next - zoom) > 0.005) setZoom(next, m)
  }, opts)
  const pinchEnd = e => { if (e.touches.length < 2) pinch = null }
  wrap.addEventListener('touchend', pinchEnd, opts)
  wrap.addEventListener('touchcancel', pinchEnd, opts)

  // ── the lens ───────────────────────────────────────────────────────────────
  function lensSeek(e) {
    const r  = lens.getBoundingClientRect()
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    wrap.scrollTo({
      left: fx * wrap.scrollWidth - wrap.clientWidth / 2,
      top:  fy * wrap.scrollHeight - wrap.clientHeight / 2,
    })
  }
  lens.addEventListener('pointerdown', e => { lens.setPointerCapture(e.pointerId); lensSeek(e) })
  lens.addEventListener('pointermove', e => { if (e.buttons) lensSeek(e) })
  let viewRaf = null
  const onScroll = () => {
    if (viewRaf != null) return
    viewRaf = requestAnimationFrame(() => { viewRaf = null; if (zoom > 1) paintLensView() })
  }
  wrap.addEventListener('scroll', onScroll, { passive: true })

  setTool('pen')
  paint(); paintFab()

  return {
    el: root,
    getDoc: () => {
      if (active) finish()
      return { pages }
    },
    destroy() {
      endRaf()
      if (viewRaf != null) cancelAnimationFrame(viewRaf)
    },
  }
}
