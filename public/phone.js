// Phone simulator: the customer's WhatsApp on the left, the barber's on the right.
// Talks to /sim/* (only exists when the server runs in simulator mode).
// CSP: scripts from 'self' only, no inline handlers. Every piece of text from the
// server goes in with textContent / createElement, never innerHTML.
'use strict'

const SPRITE = 'icons/sprite.svg#'
const TZ = 'Europe/Dublin'
const POLL_MS = 1200
const PAGE = 200 // the server returns at most 200 messages per call
const SEEDED = ['353000000201', '353000000202', '353000000203', '353000000204', '353000000205', '353000000206']
const TEMPLATE_BUTTONS = { rem_ok: "I'll be there", rem_cxl: 'I need to cancel' }
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

// ───────── small helpers ─────────
const $ = (sel, root = document) => root.querySelector(sel)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', ('icon ' + cls).trim())
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', SPRITE + name)
  svg.appendChild(use)
  return svg
}

// WhatsApp *bold* → <strong>, everything else as plain text nodes
function richText(parent, text) {
  const s = String(text ?? '')
  const re = /\*([^*\n]+)\*/g
  let last = 0
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)))
    parent.appendChild(el('strong', null, m[1]))
    last = m.index + m[0].length
  }
  if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)))
  return parent
}
const plain = (text) => String(text ?? '').replace(/\*([^*\n]+)\*/g, '$1')

const fmtTime = new Intl.DateTimeFormat('en-IE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const fmtDay = new Intl.DateTimeFormat('en-IE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })
const timeOf = (isoStr) => fmtTime.format(new Date(isoStr))
const dayKey = (d) => fmtKey.format(d)

function dayLabel(isoStr, nowIso) {
  const d = new Date(isoStr), now = nowIso ? new Date(nowIso) : new Date()
  const k = dayKey(d)
  if (k === dayKey(now)) return 'Today'
  if (k === dayKey(new Date(now.getTime() - 864e5))) return 'Yesterday'
  return fmtDay.format(d)
}

// 353000000201 → +353 000 000 201
function prettyPhone(p) {
  const s = String(p)
  if (s.length < 6) return '+' + s
  return '+' + s.slice(0, 3) + ' ' + s.slice(3).replace(/(\d{3})(?=\d)/g, '$1 ')
}

const store = {
  get(k, fallback) { try { const v = localStorage.getItem('sim.' + k); return v == null ? fallback : JSON.parse(v) } catch { return fallback } },
  set(k, v) { try { localStorage.setItem('sim.' + k, JSON.stringify(v)) } catch { /* private mode: fine */ } },
}

async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}
  const r = await fetch(path, { ...opts, cache: 'no-store' })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status })
  return data
}

// ───────── connection state (top bar + alert) ─────────
const live = {
  set(state, text) {
    const n = $('#sim-live')
    if (n.dataset.state === state && $('.sim-live-text', n).textContent === text) return
    n.dataset.state = state
    $('.sim-live-text', n).textContent = text
  },
  alert(text) {
    $('#sim-alert-text').textContent = text || ''
    $('#sim-alert').hidden = !text
  },
}

// ───────── one phone ─────────
// role 'customer' (can type and tap) or 'barber' (read-only)
function createPhone(root, role) {
  const interactive = role === 'customer'
  const chat = $('[data-chat]', root)
  const sub = $('[data-sub]', root)
  const subDefault = sub.textContent
  const s = {
    phone: null, lastId: 0, gen: 0, timer: null, busy: false, loaded: false,
    lastDay: null, serverNow: null, typing: null, holdUntil: 0, onNew: null, sheetFrom: null,
  }

  const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120
  const toBottom = () => { chat.scrollTop = chat.scrollHeight }

  function skeleton() {
    chat.replaceChildren()
    const sk = el('div', 'chat-skel')
    sk.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 3; i++) sk.appendChild(el('div', 'skel'))
    chat.appendChild(sk)
    chat.setAttribute('aria-busy', 'true')
  }

  function emptyState() {
    const box = el('div', 'chat-empty')
    const art = el('div', 'empty-art')
    art.setAttribute('aria-hidden', 'true')
    const b1 = el('span', 'eb eb-1'), b2 = el('span', 'eb eb-2')
    b1.appendChild(icon(interactive ? 'scissors' : 'bell'))
    b2.appendChild(icon(interactive ? 'message-circle' : 'calendar-clock'))
    art.append(b1, b2)
    box.appendChild(art)
    if (interactive) {
      box.appendChild(el('p', 'chat-empty-title', 'Say hi to start'))
      box.appendChild(el('p', 'chat-empty-text', 'Type anything, or tap below. The shop answers with buttons and lists, just like on WhatsApp.'))
      const hi = el('button', 'say-hi')
      hi.type = 'button'
      hi.append(icon('send'), el('span', null, 'Say "hi"'))
      hi.addEventListener('click', () => sendText('hi'))
      box.appendChild(hi)
    } else {
      box.appendChild(el('p', 'chat-empty-title', 'Nothing yet'))
      box.appendChild(el('p', 'chat-empty-text', 'New bookings, cancellations, the morning summary and 30-minute pings for this barber land here.'))
    }
    return box
  }

  function clearEmpty() { $('.chat-empty', chat)?.remove() }

  function showTyping(on) {
    if (on && !s.typing) {
      s.typing = el('div', 'typing')
      s.typing.setAttribute('aria-label', 'The shop is typing')
      s.typing.append(el('span'), el('span'), el('span'))
      chat.appendChild(s.typing)
      sub.textContent = 'typing…'
      sub.dataset.typing = ''
      toBottom()
    } else if (!on && s.typing) {
      s.typing.remove()
      s.typing = null
      sub.textContent = subDefault
      delete sub.dataset.typing
    }
  }

  // ── one message ──
  function render(m, animate) {
    const created = m.created_at
    const k = dayKey(new Date(created))
    if (k !== s.lastDay) {
      s.lastDay = k
      chat.appendChild(el('p', 'day-sep', dayLabel(created, s.serverNow)))
    }
    const mine = m.direction === 'in'
    const failed = m.status === 'failed'
    const body = m.body || {}
    const row = el('div', 'msg-row' + (mine ? ' is-mine' : '') + (failed ? ' is-failed' : '') + (animate ? ' is-enter' : ''))
    row.dataset.id = m.id
    const bubble = el('div', 'bubble')

    if (m.kind === 'template') {
      const tag = el('span', 'bubble-tag')
      tag.append(icon('badge-check'), el('span', null, 'Template'))
      tag.title = `Meta-approved template "${body.name || ''}": the 24-hour window was closed`
      bubble.appendChild(tag)
    }
    if (m.kind === 'reply' && mine) {
      const r = el('span', 'bubble-reply')
      r.append(icon('reply'), el('span', null, 'Tapped'))
      bubble.appendChild(r)
    }

    let text = body.text
    if (m.kind === 'template' && !text) text = `${body.name || 'template'}: ${(body.params || []).join(' · ')}`
    bubble.appendChild(richText(el('div', 'bubble-text'), text ?? ''))

    if (m.kind === 'list' && Array.isArray(body.rows)) {
      const open = el('button', 'quick-btn quick-list')
      open.type = 'button'
      open.append(icon('list'), el('span', null, body.button || 'Choose'))
      if (!interactive || failed) open.disabled = true
      else open.addEventListener('click', () => openSheet(body, open))
      bubble.appendChild(open)
    }

    const meta = el('div', 'bubble-meta')
    meta.appendChild(el('time', null, timeOf(created)))
    meta.lastChild.dateTime = created
    if (mine && !failed) meta.appendChild(icon('check-check'))
    bubble.appendChild(meta)
    if (failed) {
      const f = el('p', 'bubble-fail')
      f.append(icon('circle-alert'), el('span', null, 'Not delivered · outside the 24 h window, no template'))
      bubble.appendChild(f)
    }
    row.appendChild(bubble)

    const buttons = m.kind === 'buttons' ? (body.buttons || [])
      : m.kind === 'template' ? (body.buttons || []).map((b) => ({ id: b.id, title: b.title || TEMPLATE_BUTTONS[String(b.id).split(':')[0]] || b.id }))
        : []
    if (!mine && buttons.length) {
      const q = el('div', 'quick')
      q.setAttribute('role', 'group')
      q.setAttribute('aria-label', 'Reply options')
      for (const b of buttons) {
        const btn = el('button', 'quick-btn' + (/cxl|:no$|cancel/i.test(b.id) ? ' quick-btn-danger' : ''))
        btn.type = 'button'
        btn.appendChild(icon('reply'))
        btn.appendChild(el('span', null, b.title))
        if (!interactive || failed) btn.disabled = true
        else btn.addEventListener('click', () => tap(q, btn, b.id, b.title))
        q.appendChild(btn)
      }
      row.appendChild(q)
    }
    chat.appendChild(row)
  }

  // ── polling ──
  function schedule(ms = POLL_MS) {
    clearTimeout(s.timer)
    s.timer = setTimeout(poll, ms)
  }

  async function poll() {
    clearTimeout(s.timer)
    if (!s.phone) return
    if (s.busy) return schedule(200)
    if (document.hidden && s.loaded) return schedule(POLL_MS * 2)
    const gen = s.gen
    s.busy = true
    let again = false
    try {
      const data = await api(`/sim/messages?phone=${encodeURIComponent(s.phone)}&after=${s.lastId}`)
      if (gen !== s.gen) return
      live.set('on', 'Live')
      s.serverNow = data.now
      setClock(root, data.now)
      const fresh = (data.messages || []).filter((m) => m.id > s.lastId)
      if (!s.loaded) {
        chat.replaceChildren()
        chat.removeAttribute('aria-busy')
      }
      if (fresh.length) {
        clearEmpty()
        const stick = !s.loaded || nearBottom() || fresh.some((m) => m.direction === 'in')
        // let the typing dots breathe a moment before the shop's answer pops in
        const wait = s.holdUntil - Date.now()
        if (s.loaded && wait > 0 && !reducedMotion.matches && fresh.some((m) => m.direction === 'out')) {
          // show the customer's own message right away, then the answer after the dots
          for (const m of fresh.filter((x) => x.direction === 'in')) { render(m, true); s.lastId = Math.max(s.lastId, m.id) }
          if (s.typing) chat.appendChild(s.typing)
          toBottom()
          await sleep(wait)
          if (gen !== s.gen) return
        }
        showTyping(false)
        let newOut = 0
        for (const m of fresh) {
          if (m.id <= s.lastId) continue
          render(m, s.loaded)
          s.lastId = m.id
          if (m.direction === 'out') newOut++
        }
        if (stick) toBottom()
        if (s.loaded && newOut && s.onNew) s.onNew(fresh.filter((m) => m.direction === 'out'))
        again = (data.messages || []).length >= PAGE
      } else if (!s.loaded) {
        chat.appendChild(emptyState())
      }
      s.loaded = true
    } catch (err) {
      if (gen !== s.gen) return
      if (err.status === 404) live.alert('The simulator is off: this server is not in simulator mode (it is connected to real WhatsApp, or the route is disabled).')
      live.set('err', 'Offline, retrying')
    } finally {
      if (gen === s.gen) s.busy = false
    }
    if (gen === s.gen) schedule(again ? 0 : POLL_MS)
  }

  function load(phone) {
    s.gen++
    clearTimeout(s.timer)
    closeSheet(true)
    Object.assign(s, { phone, lastId: 0, busy: false, loaded: false, lastDay: null, typing: null, holdUntil: 0 })
    sub.textContent = subDefault
    delete sub.dataset.typing
    root.querySelectorAll('[data-number]').forEach((n) => { n.textContent = phone ? '…' + phone.slice(-4) : '' })
    if (interactive) setComposer()
    skeleton()
    if (phone) poll()
  }

  // ── sending (customer only) ──
  async function post(payload) {
    s.holdUntil = Date.now() + 650
    const gen = s.gen
    const typingTimer = setTimeout(() => { if (gen === s.gen) showTyping(true) }, reducedMotion.matches ? 0 : 280)
    try {
      await api('/sim/send', { phone: s.phone, ...payload })
      if (gen !== s.gen) return false
      // the server answers synchronously, so the reply is already waiting: fetch it now
      await sleep(30)
      poll()
      return true
    } catch (err) {
      clearTimeout(typingTimer)
      if (gen === s.gen) showTyping(false)
      live.alert(err.status ? `Could not send: ${err.message}` : 'Could not reach the server. Is it still running?')
      setTimeout(() => live.alert(''), 5000)
      return false
    }
  }

  function sendText(text) {
    const t = String(text || '').trim()
    if (!t || !s.phone) return
    clearEmpty()
    post({ text: t.slice(0, 1000) })
  }

  async function tap(group, btn, id, title) {
    const all = [...group.querySelectorAll('button')]
    all.forEach((b) => { b.disabled = true; b.classList.remove('is-picked') })
    btn.classList.add('is-picked')
    btn.firstChild.replaceWith(icon('check'))
    await post({ replyId: id, text: title })
    // old buttons keep working (the server reads the value from the id), so re-enable them
    all.forEach((b) => { b.disabled = false })
  }

  // ── composer ──
  const form = interactive ? $('#composer') : null
  const input = interactive ? $('#composer-input') : null
  const sendBtn = interactive ? $('#composer-send') : null
  function setComposer() { sendBtn.disabled = !s.phone || !input.value.trim() }
  if (interactive) {
    input.addEventListener('input', setComposer)
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const t = input.value
      if (!t.trim()) return
      input.value = ''
      setComposer()
      sendText(t)
      input.focus()
    })
  }

  // ── list sheet ──
  const sheet = $('[data-sheet]', root)
  const backdrop = $('[data-sheet-backdrop]', root)
  function openSheet(body, from) {
    if (!sheet) return
    s.sheetFrom = from
    $('.sheet-title', sheet).textContent = body.button || 'Choose'
    $('[data-sheet-lead]', sheet).textContent = plain(body.text)
    const list = $('[data-sheet-rows]', sheet)
    list.replaceChildren()
    ;(body.rows || []).forEach((r, i) => {
      const li = el('li')
      const b = el('button', 'sheet-row')
      b.type = 'button'
      b.style.setProperty('--i', i)
      const txt = el('span')
      txt.appendChild(el('span', 'sheet-row-title', r.title))
      if (r.description) txt.appendChild(el('span', 'sheet-row-desc', r.description))
      const radio = el('span', 'sheet-radio')
      radio.setAttribute('aria-hidden', 'true')
      b.append(txt, radio)
      b.addEventListener('click', async () => {
        b.classList.add('is-picked')
        list.querySelectorAll('button').forEach((x) => { x.disabled = true })
        await sleep(reducedMotion.matches ? 0 : 180)
        closeSheet()
        post({ replyId: r.id, text: r.title })
      })
      li.appendChild(b)
      list.appendChild(li)
    })
    sheet.classList.remove('is-closing'); backdrop.classList.remove('is-closing')
    sheet.hidden = false; backdrop.hidden = false
    $('.sheet-row', sheet)?.focus({ preventScroll: true })
  }
  function closeSheet(instant = false) {
    if (!sheet || sheet.hidden) return
    const done = () => { sheet.hidden = true; backdrop.hidden = true; sheet.classList.remove('is-closing'); backdrop.classList.remove('is-closing') }
    const from = s.sheetFrom
    s.sheetFrom = null
    if (from && document.contains(from) && !instant) from.focus({ preventScroll: true })
    if (instant || reducedMotion.matches) return done()
    sheet.classList.add('is-closing'); backdrop.classList.add('is-closing')
    setTimeout(done, 200)
  }
  if (sheet) {
    backdrop.addEventListener('click', () => closeSheet())
    $('[data-sheet-close]', sheet).addEventListener('click', () => closeSheet())
    sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSheet() }
      if (e.key === 'Tab') { // keep focus inside the sheet while it is open
        const f = [...sheet.querySelectorAll('button:not([disabled])')]
        if (!f.length) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    })
  }

  return {
    load,
    get phone() { return s.phone },
    set onNew(fn) { s.onNew = fn },
    scrollEnd: toBottom,
  }
}

function setClock(root, nowIso) {
  if (!nowIso) return
  const t = timeOf(nowIso)
  root.querySelectorAll('[data-clock]').forEach((n) => { if (n.textContent !== t) n.textContent = t })
}

// ───────── page ─────────
const customer = createPhone($('#phone-customer'), 'customer')
const barber = createPhone($('#phone-barber'), 'barber')

// tabs (only visible ≤ 760px; on desktop both phones show side by side)
const narrow = window.matchMedia('(max-width: 760px)')
const tabs = { customer: $('#tab-customer'), barber: $('#tab-barber') }
const unread = { customer: 0, barber: 0 }
function badge(which) {
  const b = $('#badge-' + which)
  b.textContent = String(unread[which])
  b.hidden = unread[which] === 0
}
function activate(which, focus = false) {
  $('#stage').dataset.active = which
  for (const [k, t] of Object.entries(tabs)) {
    t.setAttribute('aria-selected', String(k === which))
    t.tabIndex = k === which ? 0 : -1
  }
  unread[which] = 0
  badge(which)
  if (focus) tabs[which].focus()
  ;(which === 'customer' ? customer : barber).scrollEnd()
}
for (const [k, t] of Object.entries(tabs)) {
  t.addEventListener('click', () => activate(k))
  t.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); activate(k === 'customer' ? 'barber' : 'customer', true) }
  })
}
const isVisible = (which) => !narrow.matches || $('#stage').dataset.active === which
function countUnread(which, n) {
  if (isVisible(which)) return
  unread[which] += n
  badge(which)
}

// barber notification banner: what would pop up on the barber's lock screen
let bannerTimer = null
function banner(text) {
  const b = $('#phone-barber [data-banner]')
  clearTimeout(bannerTimer)
  $('[data-banner-text]', b).textContent = plain(text).replace(/\s+/g, ' ').trim()
  b.classList.remove('is-leaving')
  b.hidden = false
  // restart the entrance animation for back-to-back alerts
  b.style.animation = 'none'; void b.offsetWidth; b.style.animation = ''
  bannerTimer = setTimeout(() => {
    if (reducedMotion.matches) { b.hidden = true; return }
    b.classList.add('is-leaving')
    setTimeout(() => { b.hidden = true; b.classList.remove('is-leaving') }, 260)
  }, 4200)
}

customer.onNew = (msgs) => countUnread('customer', msgs.length)
barber.onNew = (msgs) => {
  countUnread('barber', msgs.length)
  const last = msgs[msgs.length - 1]
  banner(last.body?.text || last.body?.name || 'New message')
}

// ── customer picker: the seeded regulars plus any "new customer" numbers made here ──
const pickC = $('#pick-customer')
let extra = store.get('newNumbers', []).filter((p) => /^353000000[3]\d\d$/.test(p)).slice(-10)
function fillCustomers(selected) {
  pickC.replaceChildren()
  const g1 = el('optgroup'); g1.label = 'Regulars (have booked before)'
  SEEDED.forEach((p, i) => { const o = el('option', null, `${prettyPhone(p)} · regular ${i + 1}`); o.value = p; g1.appendChild(o) })
  pickC.appendChild(g1)
  if (extra.length) {
    const g2 = el('optgroup'); g2.label = 'New customers'
    extra.forEach((p) => { const o = el('option', null, `${prettyPhone(p)} · new`); o.value = p; g2.appendChild(o) })
    pickC.appendChild(g2)
  }
  pickC.value = selected
}
function pickCustomer(p) {
  store.set('customer', p)
  fillCustomers(p)
  customer.load(p)
}
pickC.addEventListener('change', () => pickCustomer(pickC.value))
$('#new-customer').addEventListener('click', () => {
  const taken = new Set(extra)
  let p
  for (let i = 0; i < 50; i++) {
    p = '353000000' + (300 + Math.floor(Math.random() * 100))
    if (!taken.has(p)) break
  }
  extra = [...extra.filter((x) => x !== p), p].slice(-10)
  store.set('newNumbers', extra)
  pickCustomer(p)
  if (!narrow.matches) $('#composer-input').focus()
})
const savedC = store.get('customer', SEEDED[0])
pickCustomer(SEEDED.includes(savedC) || extra.includes(savedC) ? savedC : SEEDED[0])

// ── barber picker, from the server ──
const pickB = $('#pick-barber')
async function loadBarbers() {
  try {
    const data = await api('/sim/phones')
    if (data.shop) document.querySelectorAll('[data-shop], #shop-name').forEach((n) => { n.textContent = data.shop })
    pickB.replaceChildren()
    for (const b of data.barbers || []) {
      const o = el('option', null, `${b.name} · ${prettyPhone(b.phone)}`)
      o.value = b.phone
      pickB.appendChild(o)
    }
    if (!pickB.options.length) {
      pickB.appendChild(el('option', null, 'No barbers yet'))
      barber.load(null)
      return
    }
    pickB.disabled = false
    const saved = store.get('barber', null)
    pickB.value = [...pickB.options].some((o) => o.value === saved) ? saved : pickB.options[0].value
    barber.load(pickB.value)
  } catch (err) {
    if (err.status === 404) {
      live.set('err', 'Simulator off')
      live.alert('The simulator is off: this server is not in simulator mode (it is connected to real WhatsApp, or the route is disabled).')
    } else {
      live.set('err', 'Offline, retrying')
      setTimeout(loadBarbers, 3000)
    }
  }
}
pickB.addEventListener('change', () => { store.set('barber', pickB.value); barber.load(pickB.value) })
loadBarbers()
