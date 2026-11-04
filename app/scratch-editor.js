/* The Scratch Pad's rich-text mode, without React: a port of the portal's
 * RichEditor (pghubtech: portal/src/components/RichEditor.tsx), with the same
 * toolbar. Pasted images are embedded in the note, because a note is a single
 * Drive file and the page's own image uploads belong to terms and Q&As.
 */

import { ICONS } from './scratch-icons.js'

const DROP = 'script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,foreignObject'

/** A note body is set as innerHTML, including what was pasted into it. */
export function sanitize(html) {
  const t = document.createElement('template')
  t.innerHTML = html
  t.content.querySelectorAll(DROP).forEach(n => n.remove())
  for (const el of t.content.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase()
      const pastedImage = n === 'src' && el.tagName === 'IMG' && /^\s*data:image\//i.test(a.value)
      if (n.startsWith('on') || n === 'srcdoc' ||
          (/^(href|src|xlink:href|action|formaction)$/.test(n) && !pastedImage &&
           /^\s*(javascript|data|vbscript):/i.test(a.value))) {
        el.removeAttribute(a.name)
      }
    }
  }
  return t.innerHTML
}

const SAFE_URL = /^(https?:|mailto:|tel:|\/|\.\/|\.\.\/|#)/i

const TOOLBAR = [
  { cmd: 'bold',          label: 'B',  title: 'Bold (Ctrl+B)',       style: 'font-weight:700' },
  { cmd: 'italic',        label: 'I',  title: 'Italic (Ctrl+I)',     style: 'font-style:italic' },
  { cmd: 'underline',     label: 'U',  title: 'Underline (Ctrl+U)',  style: 'text-decoration:underline' },
  { cmd: 'strikeThrough', label: 'S',  title: 'Strikethrough',       style: 'text-decoration:line-through' },
  'sep',
  { cmd: 'formatBlock', arg: 'h2',         label: 'H2', title: 'Heading 2', style: 'font-weight:700' },
  { cmd: 'formatBlock', arg: 'h3',         label: 'H3', title: 'Heading 3', style: 'font-weight:700' },
  { cmd: 'formatBlock', arg: 'blockquote', label: '❝',  title: 'Blockquote' },
  { act: 'code',        label: '{ }', title: 'Code block (Enter twice on a blank line to exit)', style: 'font-family:monospace;font-size:11px' },
  'sep',
  { cmd: 'insertUnorderedList', label: '•≡',  title: 'Bullet list' },
  { cmd: 'insertOrderedList',   label: '1.≡', title: 'Numbered list' },
  { cmd: 'outdent',             label: '⇤',   title: 'Outdent' },
  { cmd: 'indent',              label: '⇥',   title: 'Indent' },
  'sep',
  { cmd: 'justifyLeft',   label: '⟸', title: 'Align left' },
  { cmd: 'justifyCenter', label: '↔', title: 'Align center' },
  { cmd: 'justifyRight',  label: '⟹', title: 'Align right' },
  { cmd: 'justifyFull',   label: '≡', title: 'Justify' },
  'sep',
  { act: 'inline', label: '</>', title: 'Inline code', style: 'font-family:monospace;font-size:11px' },
  { color: 'foreColor',   label: 'A',  title: 'Text colour', style: 'font-weight:700' },
  { color: 'hiliteColor', label: ICONS.marker, title: 'Highlight' },
  { act: 'table', label: ICONS.table, title: 'Insert table' },
  { act: 'hr',    label: '―', title: 'Horizontal line' },
  { act: 'link',  label: ICONS.link, title: 'Insert link' },
  { act: 'image', label: ICONS.image, title: 'Insert image by URL' },
  { act: 'embed', label: '⧉', title: 'Insert HTML section' },
  { act: 'para',  label: '¶', title: 'New line below this block (Ctrl/⌘+Enter)' },
  { cmd: 'removeFormat', label: '⌫', title: 'Clear formatting' },
]

const escapeText = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

/** Returns { el, destroy() }. onChange receives the editor's HTML on every edit. */
export function createRichEditor({ value, onChange, dialogHost }) {
  const wrap = document.createElement('div')
  wrap.className = 'rf-rich-wrap'
  const bar = document.createElement('div')
  bar.className = 'rf-rich-toolbar'
  const ed = document.createElement('div')
  ed.className = 'rf-rich-editor'
  ed.contentEditable = 'true'
  ed.dataset.placeholder = 'Write here…'
  ed.innerHTML = sanitize(value)
  wrap.append(bar, ed)

  let savedRange = null
  let afterEnterInCode = false

  const harden = () => ed.querySelectorAll('.rf-html-embed').forEach(n => n.setAttribute('contenteditable', 'false'))
  harden()
  const emit = () => onChange(ed.innerHTML)

  function exec(cmd, arg) {
    ed.focus()
    document.execCommand(cmd, false, arg)
    emit()
  }
  function insertHtml(html) {
    ed.focus()
    document.execCommand('insertHTML', false, sanitize(html))
    emit()
  }
  function saveSelection() {
    const sel = getSelection()
    if (sel?.rangeCount && ed.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange()
  }
  function restoreSelection() {
    const sel = getSelection()
    if (sel && savedRange) { sel.removeAllRanges(); sel.addRange(savedRange) }
  }
  function currentPre() {
    let n = getSelection()?.anchorNode
    while (n && n !== ed) {
      if (n.nodeType === 1 && n.tagName === 'PRE') return n
      n = n.parentNode
    }
    return null
  }
  function paragraphBelow() {
    ed.focus()
    const sel = getSelection()
    let block = sel?.anchorNode
    while (block && block !== ed && block.parentNode !== ed) block = block.parentNode
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    if (block && block !== ed) ed.insertBefore(p, block.nextSibling)
    else ed.append(p)
    const r = document.createRange()
    r.setStart(p, 0); r.collapse(true)
    sel?.removeAllRanges(); sel?.addRange(r)
    emit()
  }

  // ── HTML sections ──────────────────────────────────────────────────────────
  // The raw markup is kept verbatim in data-html; what shows is a cleaned copy,
  // so the editor never runs it.
  function embedNode(raw) {
    const n = document.createElement('div')
    n.className = 'rf-html-embed'
    n.setAttribute('contenteditable', 'false')
    n.setAttribute('data-html', raw)
    const lab = document.createElement('div')
    lab.className = 'rf-html-embed-label'
    lab.textContent = '⧉ HTML section — click to edit'
    const prev = document.createElement('div')
    prev.className = 'rf-html-embed-preview'
    prev.innerHTML = sanitize(raw) || '<em>empty</em>'
    n.append(lab, prev)
    return n
  }
  function openEmbed(existing) {
    saveSelection()
    const box = document.createElement('div')
    box.className = 'sp-dialog'
    const text = document.createElement('textarea')
    text.spellcheck = false
    text.placeholder = '<div>Paste HTML…</div>'
    text.value = existing?.getAttribute('data-html') ?? ''
    const ok = document.createElement('button')
    ok.type = 'button'; ok.className = 'sp-text-btn sp-primary'; ok.textContent = 'Apply'
    const no = document.createElement('button')
    no.type = 'button'; no.className = 'sp-text-btn'; no.textContent = 'Cancel'
    const row = document.createElement('div')
    row.className = 'sp-dialog-row'
    row.append(no, ok)
    box.append(text, row)
    const close = () => box.remove()
    no.addEventListener('click', close)
    ok.addEventListener('click', () => {
      const raw = text.value
      if (existing) {
        existing.setAttribute('data-html', raw)
        existing.querySelector('.rf-html-embed-preview').innerHTML = sanitize(raw) || '<em>empty</em>'
        emit()
      } else {
        ed.focus(); restoreSelection()
        // Inserted as a node: the sanitizer would rewrite a pasted string, and
        // data-html has to stay exactly what was typed.
        const node = embedNode(raw)
        const after = document.createElement('p')
        after.innerHTML = '<br>'
        const sel = getSelection()
        if (sel?.rangeCount && ed.contains(sel.anchorNode)) {
          const r = sel.getRangeAt(0)
          r.deleteContents()
          r.insertNode(after); r.insertNode(node)
        } else ed.append(node, after)
        emit()
      }
      close()
    })
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    })
    dialogHost.append(box)
    text.focus()
  }

  // ── toolbar ────────────────────────────────────────────────────────────────
  const ACT = {
    code() {
      exec('formatBlock', 'pre')
      const pre = currentPre()
      if (pre && !pre.nextElementSibling) {
        const p = document.createElement('p')
        p.innerHTML = '<br>'
        pre.after(p)
        emit()
      }
    },
    inline() {
      const text = getSelection()?.toString() ?? ''
      insertHtml(`<code>${text ? escapeText(text) : '&#8203;'}</code>`)
    },
    table() {
      const cell = '<td style="border:1px solid #c8c8c8;padding:6px;min-width:60px">&nbsp;</td>'
      const tr = `<tr>${cell}${cell}${cell}</tr>`
      insertHtml(`<table style="border-collapse:collapse;margin:6px 0">${tr}${tr}</table><p><br></p>`)
    },
    hr() { exec('insertHorizontalRule') },
    link() {
      saveSelection()
      const url = prompt('Link URL:', 'https://')?.trim()
      if (!url) return
      if (!SAFE_URL.test(url)) return alert('Only http(s), mailto, tel and relative links are allowed.')
      ed.focus(); restoreSelection()
      exec('createLink', url)
    },
    image() {
      saveSelection()
      const url = prompt('Image URL:', 'https://')?.trim()
      if (!url) return
      if (!/^https?:/i.test(url)) return alert('Only http(s) image URLs are allowed.')
      const img = document.createElement('img')
      img.src = url; img.alt = ''; img.style.maxWidth = '100%'
      ed.focus(); restoreSelection()
      insertHtml(img.outerHTML)
    },
    embed() { openEmbed(null) },
    para() { paragraphBelow() },
  }

  for (const b of TOOLBAR) {
    if (b === 'sep') {
      const s = document.createElement('span')
      s.className = 'rf-tb-divider'
      bar.append(s)
      continue
    }
    if (b.color) {
      const lab = document.createElement('label')
      lab.className = 'rf-tb-btn rf-tb-color'
      lab.title = b.title
      if (b.style) lab.style.cssText = b.style
      if (b.label.startsWith('<svg')) lab.innerHTML = b.label
      else lab.textContent = b.label
      const input = document.createElement('input')
      input.type = 'color'
      // The picker takes focus and collapses the selection, so it is kept first.
      lab.addEventListener('pointerdown', saveSelection)
      input.addEventListener('input', () => {
        ed.focus(); restoreSelection()
        document.execCommand(b.color, false, input.value)
        emit()
      })
      lab.append(input)
      bar.append(lab)
      continue
    }
    const btn = document.createElement('button')
    btn.type = 'button'; btn.className = 'rf-tb-btn'
    btn.title = b.title
    btn.setAttribute('aria-label', b.title)
    if (b.label.startsWith('<svg')) btn.innerHTML = b.label
    else btn.textContent = b.label
    if (b.style) btn.style.cssText = b.style
    btn.addEventListener('click', () => b.act ? ACT[b.act]() : exec(b.cmd, b.arg))
    bar.append(btn)
  }
  // Keeps the editor's selection when a toolbar button is pressed. The colour
  // inputs are left alone or they would never open.
  bar.addEventListener('mousedown', e => {
    if (!e.target.closest('.rf-tb-color')) e.preventDefault()
  })

  // ── the editing surface ────────────────────────────────────────────────────
  ed.addEventListener('input', emit)
  ed.addEventListener('click', e => {
    const n = e.target.closest?.('.rf-html-embed')
    if (n) { e.preventDefault(); openEmbed(n) }
  })
  ed.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); paragraphBelow(); afterEnterInCode = false
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && currentPre()) {
      if (afterEnterInCode) {
        e.preventDefault()
        document.execCommand('delete')    // the blank line the first Enter made
        paragraphBelow()
        afterEnterInCode = false
      } else afterEnterInCode = true
      return
    }
    afterEnterInCode = false
  })
  ed.addEventListener('paste', e => {
    const data = e.clipboardData
    if (!data) return
    const images = [...data.items].filter(i => i.kind === 'file' && i.type.startsWith('image/'))
    if (images.length) {
      e.preventDefault()
      for (const it of images) {
        const file = it.getAsFile()
        if (!file) continue
        const r = new FileReader()
        r.onload = () => {
          const img = document.createElement('img')
          img.src = r.result; img.alt = ''; img.style.maxWidth = '100%'
          insertHtml(img.outerHTML)
        }
        r.readAsDataURL(file)
      }
      return
    }
    const html = data.getData('text/html')
    if (html) {
      e.preventDefault()
      insertHtml(html)
    }
  })

  return { el: wrap, destroy() {} }
}
