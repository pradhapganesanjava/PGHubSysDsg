/* The theme control, shared by the hub and every module.
 *
 * Theme is picked rarely, so it does not deserve seven permanent dots in the
 * header, and it certainly does not deserve the wide labelled dropdown it
 * started as. This is one dot — the theme in use — with a caret; the rest
 * appear only when asked for. The colours are the label, so there is no text.
 *
 * It ships its own CSS for the same reason it exists at all: the hub and the
 * modules are separate documents with separate stylesheets, and a control
 * defined twice drifts.
 *
 * Selection calls the page's own applyTheme, which is the function that already
 * owns persistence. The current dot follows document.documentElement's
 * data-theme rather than the click, so it stays right no matter what changed
 * the theme — this page, another tab, or Drive.
 */
export const THEMES = [
  { id: 'dark',      label: 'Dark',      bg: '#0f1117', accent: '#6ea8fe' },
  { id: 'moonlight', label: 'Moonlight', bg: '#0b1023', accent: '#8b9dff' },
  { id: 'gray',      label: 'Gray',      bg: '#2b2f36', accent: '#9fb0c0' },
  { id: 'soft',      label: 'Soft',      bg: '#f6f4f1', accent: '#9d8ec2' },
  { id: 'white',     label: 'White',     bg: '#ffffff', accent: '#2563eb' },
  { id: 'colorful',  label: 'Colorful',  bg: '#fef6ff', accent: '#e0179d' },
  { id: 'cartoon',   label: 'Cartoon',   bg: '#fffbe7', accent: '#ff5c8a' },
]

const CSS = `
.tp{position:relative;flex:0 0 auto}
.tp-cur{display:flex;align-items:center;gap:3px;padding:3px 4px 3px 3px;
  background:var(--panel-2);border:1px solid var(--border);border-radius:999px;
  cursor:pointer;line-height:0}
.tp-cur:hover{border-color:var(--accent)}
.tp-cur:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tp-caret{font-size:9px;line-height:1;color:var(--muted);transition:transform .15s}
.tp[data-open="1"] .tp-caret{transform:rotate(180deg)}
.tp-dot{width:15px;height:15px;border-radius:50%;border:1px solid var(--border);
  position:relative;background:var(--sw-bg);flex:0 0 auto}
.tp-dot::after{content:"";position:absolute;inset:3.5px;border-radius:50%;background:var(--sw-accent)}
.tp-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:120;display:none;
  gap:6px;padding:7px;background:var(--panel);border:1px solid var(--border);
  border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.tp[data-open="1"] .tp-menu{display:flex}
.tp-opt{width:19px;height:19px;padding:0;border-radius:50%;cursor:pointer;
  border:1px solid var(--border);position:relative;background:var(--sw-bg)}
.tp-opt::after{content:"";position:absolute;inset:4.5px;border-radius:50%;background:var(--sw-accent)}
.tp-opt:hover{transform:scale(1.15)}
.tp-opt[aria-pressed="true"]{box-shadow:0 0 0 2px var(--panel),0 0 0 3.5px var(--accent)}
.tp-opt:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
`

let cssInjected = false
function injectCss() {
  if (cssInjected) return
  cssInjected = true
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }))
}

const styleFor = t => `--sw-bg:${t.bg};--sw-accent:${t.accent}`
const themeOf  = () => document.documentElement.getAttribute('data-theme') || 'dark'

/**
 * Replace `mount` with the control.
 * @param mount element to build into (its contents are replaced)
 */
export function mountThemePicker(mount) {
  if (!mount) return
  injectCss()

  mount.classList.add('tp')
  mount.dataset.open = '0'
  mount.innerHTML =
    `<button type="button" class="tp-cur" aria-haspopup="true" aria-expanded="false" aria-label="Theme">` +
      `<span class="tp-dot"></span><span class="tp-caret">▾</span>` +
    `</button>` +
    `<div class="tp-menu" role="menu">` +
      THEMES.map(t =>
        `<button type="button" class="tp-opt" role="menuitemradio" data-theme="${t.id}"` +
        ` aria-pressed="false" title="${t.label}" aria-label="${t.label} theme"` +
        ` style="${styleFor(t)}"></button>`).join('') +
    `</div>`

  const cur  = mount.querySelector('.tp-cur')
  const dot  = mount.querySelector('.tp-dot')
  const menu = mount.querySelector('.tp-menu')

  const open = on => {
    mount.dataset.open = on ? '1' : '0'
    cur.setAttribute('aria-expanded', String(!!on))
  }

  /** Paint the current dot and tick the matching option. */
  function sync() {
    const id = themeOf()
    const t = THEMES.find(x => x.id === id) ?? THEMES[0]
    dot.setAttribute('style', styleFor(t))
    cur.title = `Theme — ${t.label}`
    menu.querySelectorAll('.tp-opt').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.theme === id)))
  }

  cur.addEventListener('click', e => { e.stopPropagation(); open(mount.dataset.open !== '1') })
  menu.addEventListener('click', e => {
    const b = e.target.closest('.tp-opt')
    if (!b) return
    // applyTheme belongs to the page's own script and owns persistence; this
    // control only decides which theme to ask for.
    window.applyTheme?.(b.dataset.theme)
    open(false)
    cur.focus()
  })
  document.addEventListener('click', e => { if (!mount.contains(e.target)) open(false) })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') open(false) })

  // Follow the document rather than the click, so a change made in another tab
  // or pulled from Drive updates the dot too.
  new MutationObserver(sync).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] })
  sync()
}
