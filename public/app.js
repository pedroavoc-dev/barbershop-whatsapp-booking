// Magic Scissors dashboard. No framework, no build. CSP: this file is the only script.
// Rule: server data (customer names come from WhatsApp users) only ever goes through
// textContent / createElement, never innerHTML.
'use strict'

// ───────── tiny DOM helpers ─────────
const $ = (id) => document.getElementById(id)
const SVGNS = 'http://www.w3.org/2000/svg'
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn)
      else el.setAttribute(k, v === true ? '' : v)
    }
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k)
  return el
}
function icon(name, cls = '') {
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('class', `icon ${cls}`.trim())
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(SVGNS, 'use')
  use.setAttribute('href', `icons/sprite.svg#${name}`)
  svg.append(use)
  return svg
}
const clear = (el) => { while (el.firstChild) el.firstChild.remove() }
// restart a one-shot CSS animation class
function replay(el, cls) {
  if (!el) return
  el.classList.remove(cls)
  void el.offsetWidth
  el.classList.add(cls)
}

// ───────── state ─────────
const S = {
  csrf: null,
  login: null,
  meta: null,
  isOwner: false,
  day: null,            // YYYY-MM-DD being viewed (shop time)
  bookings: [],
  loading: false,
  messages: [],
  seenMsgIds: new Set(),
  freshIds: new Map(),  // booking id -> 'new' | 'changed', consumed by the next render
  mine: new Set(),      // bookings created from this tab (no "new booking" toast for them)
  creating: false,      // a POST /api/bookings from this tab is in flight (its live event can arrive first)
  clockAt: 0,           // server "now" (ms) ...
  clockPerf: 0,         // ... observed at this performance.now()
  es: null,
  jump: null,           // { reminders } while a time-machine request is in flight
  fetchGen: 0,
}

// shop "now", following the server clock (which the demo time machine can move)
const nowMs = () => S.clockAt + (performance.now() - S.clockPerf)
function setServerNow(iso) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return
  S.clockAt = t
  S.clockPerf = performance.now()
}

// ───────── time in the shop's zone ─────────
const fmtCache = new Map()
function fmt(opts) {
  const key = JSON.stringify(opts)
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('en-GB', { timeZone: S.meta?.timeZone || 'Europe/Dublin', ...opts }))
  return fmtCache.get(key)
}
// { date: 'YYYY-MM-DD', time: 'HH:MM', min: minutes since local midnight }
function local(ms) {
  const p = {}
  for (const x of fmt({ hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, min: Number(p.hour) * 60 + Number(p.minute) }
}
const todayLocal = () => local(nowMs()).date
// date-only labels are computed in UTC from noon, so the zone can't shift the day
const dateObj = (date) => new Date(`${date}T12:00:00Z`)
const dayLong = (date) => dateObj(date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
const dayShort = (date) => dateObj(date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const weekdayShort = (date) => dateObj(date).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
function addDays(date, n) {
  const d = dateObj(date)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const daysBetween = (a, b) => Math.round((dateObj(b) - dateObj(a)) / 86400000)
function relDay(date) {
  const n = daysBetween(todayLocal(), date)
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  if (n === -1) return 'Yesterday'
  return n > 0 ? `In ${n} days` : `${-n} days ago`
}
function minutesLabel(min) {
  const m = Math.abs(Math.round(min))
  if (m < 60) return `${m} min`
  const hh = Math.floor(m / 60), mm = m % 60
  return mm ? `${hh} h ${mm} min` : `${hh} h`
}
function offsetLabel(min) {
  if (!min) return 'Real time'
  const days = Math.floor(Math.abs(min) / 1440), rest = Math.abs(min) % 1440
  const parts = []
  if (days) parts.push(`${days} d`)
  if (rest) parts.push(minutesLabel(rest))
  return min > 0 ? `+${parts.join(' ')} ahead` : `${parts.join(' ')} behind`
}

const money = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
const moneyExact = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' })
const euros = (cents) => (cents % 100 ? moneyExact : money).format(cents / 100)

// ───────── API ─────────
const ERRORS = {
  slot_taken: 'Someone just took that time. The list of free times is refreshed: pick another one.',
  too_many: 'This customer already has the maximum number of upcoming bookings.',
  customer_overlap: 'This customer already has a booking at that time.',
  too_far: 'That day is too far ahead. Bookings open 14 days in advance.',
  service_unavailable: 'That service is no longer offered.',
  bad_time: 'That time is not valid. Pick one from the list.',
  not_started: 'Done and no-show can only be marked once the appointment has started.',
  not_active: 'This booking was already changed. The view is refreshed.',
  not_found: 'This booking no longer exists.',
  bad_status: 'That status is not valid.',
  'booking not found': 'This booking no longer exists, or belongs to another barber.',
  'phone must be 8–15 digits with country code': 'Enter the WhatsApp number with the country code: 8 to 15 digits.',
  'name is required': 'Enter the customer\'s name (at least 2 letters).',
  'wrong login or password': 'Wrong login or password.',
  'too many attempts, wait 15 minutes': 'Too many attempts. Wait 15 minutes and try again.',
  'missing or invalid CSRF token': 'Your session expired. Sign in again.',
}
const friendly = (code) => ERRORS[code] || `Something went wrong (${code || 'no answer from the server'}).`

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' }
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    if (S.csrf) headers['X-CSRF'] = S.csrf
  }
  let r
  try {
    r = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ApiError(0, 'network')
  }
  const data = await r.json().catch(() => ({}))
  if (r.status === 401 && path !== '/api/login') {
    sessionLost()
    throw new ApiError(401, data.error || 'log in first')
  }
  if (!r.ok) throw new ApiError(r.status, data.error)
  return data
}
ERRORS.network = 'Can\'t reach the server. Check the connection and try again.'

// ───────── toasts ─────────
function toast(title, text = '', tone = 'ok', iconName = 'circle-check') {
  const el = h('div', { class: `toast is-${tone}` },
    h('span', { class: 'toast-icon' }, icon(iconName)),
    h('div', null, h('p', { class: 'toast-title', text: title }), text ? h('p', { class: 'toast-text', text }) : null))
  const box = $('toasts')
  box.append(el)
  while (box.children.length > 4) box.firstElementChild.remove()
  setTimeout(() => {
    el.classList.add('is-leaving')
    setTimeout(() => el.remove(), 300)
  }, tone === 'red' ? 7000 : 4800)
}

// ───────── boot, login, logout ─────────
function show(which) {
  $('boot').hidden = which !== 'boot'
  $('login').hidden = which !== 'login'
  $('app').hidden = which !== 'app'
}

async function boot() {
  let s
  try {
    s = await api('/api/session')
  } catch {
    show('login')
    showLoginError(friendly('network'))
    return
  }
  if (s.loggedIn) {
    S.csrf = s.csrf
    S.login = s.login
    await startApp()
  } else {
    showLogin(s.demo)
  }
}

function showLogin(demo) {
  show('login')
  $('demo-hint').hidden = !demo
  $('login-user').focus()
}
function showLoginError(msg) {
  const e = $('login-error')
  clear(e)
  if (msg) e.append(icon('circle-alert'), h('span', { text: msg }))
  e.hidden = !msg
}

async function doLogin(login, password) {
  const btn = $('login-btn')
  showLoginError('')
  if (!login || !password) {
    showLoginError('Enter your login and password.')
    ;(!login ? $('login-user') : $('login-pass')).focus()
    return
  }
  btn.disabled = true
  btn.firstElementChild.replaceWith(icon('loader-circle', 'spin'))
  try {
    const r = await api('/api/login', { method: 'POST', body: { login, password } })
    S.csrf = r.csrf
    S.login = login
    $('login-pass').value = ''
    await startApp()
  } catch (err) {
    showLoginError(friendly(err.code))
    $('login-pass').select()
  } finally {
    btn.disabled = false
    btn.firstElementChild.replaceWith(icon('arrow-right'))
  }
}

function sessionLost() {
  if ($('app').hidden) return
  stopLive()
  S.csrf = null
  for (const d of document.querySelectorAll('dialog[open]')) d.close()
  showLogin(S.meta?.demo)
  showLoginError('Your session ended. Sign in again.')
}

async function doLogout() {
  try { await api('/api/logout', { method: 'POST', body: {} }) } catch { /* the cookie dies with the session anyway */ }
  stopLive()
  S.csrf = null
  S.meta = null
  fmtCache.clear()
  showLogin(false)
  api('/api/session').then((s) => { $('demo-hint').hidden = !s.demo }).catch(() => {})
}

// ───────── app start ─────────
async function startApp() {
  show('app')
  renderStatsSkeleton()
  renderSchedule()          // skeleton until meta + bookings arrive
  let meta
  try {
    meta = await api('/api/meta')
  } catch (err) {
    if (err.status !== 401) toast('Could not load the shop', friendly(err.code), 'red', 'circle-alert')
    return
  }
  S.meta = meta
  fmtCache.clear()
  S.isOwner = meta.barberId === null || meta.barberId === undefined
  setServerNow(meta.now)
  S.day = meta.today

  $('shop-name').textContent = meta.shop
  document.title = `${meta.shop} · Bookings`
  const me = S.isOwner ? null : meta.barbers.find((b) => b.id === meta.barberId)
  const displayName = me ? me.name : 'Owner'
  $('who-name').textContent = S.isOwner ? `Owner · ${S.login}` : displayName
  $('who-avatar').textContent = displayName.slice(0, 1).toUpperCase()
  $('sim-link').hidden = meta.whatsappMode !== 'simulator'
  $('machine').hidden = !meta.demo
  $('feed-card').hidden = !S.isOwner
  $('nb-barber-step').hidden = !S.isOwner

  renderReminders()
  if (meta.demo) buildDial()
  updateClock()
  await loadDay(true)
  if (S.isOwner) loadMessages(true)
  startLive()
}

// ───────── day navigation ─────────
async function goDay(date) {
  if (!S.meta || !date) return
  S.day = date
  replay($('day-title'), 'is-changing')
  await loadDay(true)
}

async function loadDay(showSkeleton = false) {
  if (!S.meta) return
  const gen = ++S.fetchGen
  const day = S.day
  renderDayHead()
  if (showSkeleton) {
    S.loading = true
    renderSchedule()
    renderStatsSkeleton()
  }
  try {
    const r = await api(`/api/bookings?from=${day}&days=1`)
    if (gen !== S.fetchGen) return // the user moved on to another day meanwhile
    S.bookings = r.bookings
  } catch (err) {
    if (gen !== S.fetchGen) return
    if (err.status !== 401) toast('Could not load the bookings', friendly(err.code), 'red', 'circle-alert')
    S.bookings = []
  }
  S.loading = false
  renderSchedule()
  renderStats()
}

function renderDayHead() {
  $('day-eyebrow').textContent = relDay(S.day)
  $('day-title').textContent = dayLong(S.day)
  const isToday = S.day === todayLocal()
  $('day-today').disabled = isToday
  $('day-today').setAttribute('aria-pressed', String(isToday))
}

// ───────── barbers: one colour per chair (static class map, by position) ─────────
const CHAIR = ['b1', 'b2', 'b3', 'b4']
function chairClass(barberId) {
  const i = (S.meta?.barbers || []).findIndex((b) => b.id === barberId)
  return CHAIR[(i < 0 ? barberId : i) % CHAIR.length]
}
function columns() {
  const all = S.meta?.barbers || []
  if (!S.meta) return [{ id: 0, name: '' }, { id: -1, name: '' }, { id: -2, name: '' }]
  if (!S.isOwner) return all.filter((b) => b.id === S.meta.barberId).concat(all.some((b) => b.id === S.meta.barberId) ? [] : [{ id: S.meta.barberId, name: 'Me' }])
  const cols = [...all]
  // a booking for a barber who has since left still deserves a column
  for (const b of S.bookings) if (!cols.some((c) => c.id === b.barber_id)) cols.push({ id: b.barber_id, name: b.barber_name })
  return cols
}

// ───────── booking helpers ─────────
const startMs = (b) => Date.parse(b.starts_at)
const endMs = (b) => Date.parse(b.ends_at)
const isActive = (b) => b.status !== 'cancelled'
const timeOf = (iso) => local(Date.parse(iso)).time
const STATUS_TEXT = { confirmed: 'Confirmed', done: 'Done', no_show: 'No-show', cancelled: 'Cancelled' }
const STATUS_TAG = { confirmed: 'tag-navy', done: 'tag-ok', no_show: 'tag-warn', cancelled: 'tag-red' }

function liveState(b, now = nowMs()) {
  if (b.status !== 'confirmed') return b.status
  if (now >= endMs(b)) return 'ended'
  if (now >= startMs(b)) return 'now'
  return 'upcoming'
}

// ───────── schedule ─────────
const PX_PER_MIN = 1.6
const HOUR_PX = PX_PER_MIN * 60
const view = { startMin: 9 * 60, endMin: 18 * 60, cards: new Map(), nowLine: null, cols: new Map() }

function dayRange() {
  let start = 9 * 60, end = 18 * 60
  for (const b of S.bookings) {
    const s = local(startMs(b)), e = local(endMs(b))
    const sMin = s.date === S.day ? s.min : 0
    const eMin = e.date === S.day ? e.min : 24 * 60
    start = Math.min(start, Math.floor(sMin / 60) * 60)
    end = Math.max(end, Math.ceil(eMin / 60) * 60)
  }
  return { start, end }
}

// overlapping bookings in a column sit side by side (lanes); cancelled ones yield lane 0
function layoutLanes(list) {
  const sorted = [...list].sort((a, b) => startMs(a) - startMs(b) || (isActive(b) - isActive(a)) || a.id - b.id)
  const out = new Map()
  let cluster = [], clusterEnd = -Infinity
  const flush = () => {
    const laneEnds = []
    for (const b of cluster) {
      let lane = laneEnds.findIndex((e) => e <= startMs(b))
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0) }
      laneEnds[lane] = endMs(b)
      out.set(b.id, { lane })
    }
    for (const b of cluster) out.get(b.id).lanes = laneEnds.length
    cluster = []
  }
  for (const b of sorted) {
    if (startMs(b) >= clusterEnd) { flush(); clusterEnd = -Infinity }
    cluster.push(b)
    clusterEnd = Math.max(clusterEnd, endMs(b))
  }
  flush()
  return out
}

function renderSchedule() {
  const grid = $('schedule')
  clear(grid)
  view.cards.clear()
  view.cols.clear()
  const cols = columns()
  const { start, end } = S.meta && !S.loading ? dayRange() : { start: 9 * 60, end: 18 * 60 }
  view.startMin = start
  view.endMin = end
  const height = ((end - start) * PX_PER_MIN)
  grid.dataset.cols = String(cols.length)
  grid.style.setProperty('--cols', String(cols.length))
  grid.style.setProperty('--hour-h', `${HOUR_PX}px`)
  grid.setAttribute('aria-busy', String(!S.meta || S.loading))

  const today = todayLocal()
  const pastDay = S.meta && S.day < today

  // header row
  const head = h('div', { class: 'sg-row sg-head' }, h('div', { class: 'sg-corner', 'aria-hidden': 'true' }))
  // body row
  const gutter = h('div', { class: 'gutter', 'aria-hidden': 'true' })
  gutter.style.height = `${height}px`
  for (let m = start; m < end; m += 60) {
    const lab = h('span', { class: 'hour num', text: `${String(m / 60).padStart(2, '0')}:00` })
    lab.style.top = `${(m - start) * PX_PER_MIN}px`
    gutter.append(lab)
  }
  const body = h('div', { class: 'sg-row sg-body' }, gutter)

  for (const c of cols) {
    const cc = chairClass(c.id)
    const mine = S.bookings.filter((b) => b.barber_id === c.id)
    const ch = h('div', { class: `col-head ${cc}` })
    if (!S.meta || S.loading) {
      ch.append(h('div', { class: 'col-who' }, h('span', { class: 'col-avatar skel' }), h('span', { class: 'skel', text: ' '.repeat(14) })),
        h('div', { class: 'col-state' }, h('span', { class: 'skel', text: ' '.repeat(22) })))
    } else {
      const state = h('div', { class: 'col-state' })
      const bar = h('span')
      ch.append(
        h('div', { class: 'col-who' },
          h('span', { class: 'col-avatar', 'aria-hidden': 'true', text: (c.name || '?').slice(0, 1).toUpperCase() }),
          h('div', { class: '' }, h('p', { class: 'col-name', text: c.name }), h('p', { class: 'col-count', text: colCount(mine) }))),
        state,
        h('div', { class: 'col-progress', 'aria-hidden': 'true' }, bar))
      view.cols.set(c.id, { head: ch, state, bar, list: mine })
    }
    head.append(ch)

    const col = h('div', { class: `col ${cc}${pastDay ? ' is-past-day' : ''}`, role: 'group', 'aria-label': c.name ? `${c.name}'s bookings` : 'Loading' })
    col.style.height = `${height}px`
    if (!S.meta || S.loading) {
      for (const [top, len] of [[60, 30], [150, 45], [330, 20], [420, 60]]) {
        const sk = h('div', { class: 'skel skel-bk' })
        sk.style.top = `${top * PX_PER_MIN}px`
        sk.style.height = `${len * PX_PER_MIN - 4}px`
        col.append(sk)
      }
    } else {
      const lanes = layoutLanes(mine)
      for (const b of mine) col.append(bookingCard(b, lanes.get(b.id)))
    }
    body.append(col)
  }

  // the red "now" line (only on today)
  const nowLine = h('div', { class: 'now-line', 'aria-hidden': 'true', hidden: true }, h('span', { class: 'now-label num' }))
  body.append(nowLine)
  view.nowLine = nowLine

  if (S.meta && !S.loading && !S.bookings.length) body.append(emptyState())

  grid.append(head, body)
  S.freshIds.clear()
  refreshLive()
}

function colCount(list) {
  const act = list.filter(isActive)
  const rev = act.filter((b) => b.status !== 'no_show').reduce((s, b) => s + b.price_cents, 0)
  if (!act.length) return list.length ? `${list.length} cancelled` : 'No bookings'
  return `${act.length} booking${act.length > 1 ? 's' : ''} · ${euros(rev)}`
}

function bookingCard(b, lane = { lane: 0, lanes: 1 }) {
  const s = local(startMs(b))
  const sMin = s.date === S.day ? s.min : 0
  const dur = Math.max(10, (endMs(b) - startMs(b)) / 60000)
  const hpx = dur * PX_PER_MIN - 3
  const src = b.source === 'whatsapp'
  const pill = h('span', { class: 'bk-pill', hidden: true })
  const el = h('button', { type: 'button', class: `bk ${chairClass(b.barber_id)} is-${b.status}`, 'data-id': String(b.id) },
    h('span', { class: 'bk-top' },
      h('span', { class: 'bk-time num', text: `${timeOf(b.starts_at)}–${timeOf(b.ends_at)}` }),
      h('span', { class: 'bk-icons' }, pill,
        h('span', { class: `bk-src${src ? ' is-wa' : ''}`, title: src ? 'Booked on WhatsApp' : 'Booked on the dashboard' }, icon(src ? 'message-circle' : 'phone')))),
    h('span', { class: 'bk-svc', text: b.service_name }),
    h('span', { class: 'bk-who' }, icon('user', 'icon-sm'), h('span', { text: b.customer_name || 'Customer' })))
  el.style.top = `${(sMin - view.startMin) * PX_PER_MIN + 1}px`
  el.style.height = `${hpx}px`
  if (lane.lanes > 1) {
    const w = 100 / lane.lanes
    el.style.left = `calc(${w * lane.lane}% + 3px)`
    el.style.right = `calc(${w * (lane.lanes - lane.lane - 1)}% + 3px)`
  }
  // the three-line layout needs ~62px (a 40-min booking); shorter cards go on one line,
  // with the customer's name folded into the service line
  if (hpx < 62) {
    el.classList.add('is-short')
    el.querySelector('.bk-svc').textContent = `${b.service_name} · ${b.customer_name || 'Customer'}`
  }
  if (hpx < 26) el.classList.add('is-tiny')
  const fresh = S.freshIds.get(b.id)
  if (fresh) el.classList.add(fresh === 'new' ? 'is-new' : 'is-changed')
  el.addEventListener('click', () => openBooking(b.id))
  view.cards.set(b.id, { el, pill, b })
  applyCardState(view.cards.get(b.id))
  return el
}

const PILL = { now: 'Now', ended: 'Ended', done: 'Done', no_show: 'No-show', cancelled: 'Cancelled' }
function applyCardState(card, now = nowMs()) {
  const { el, pill, b } = card
  const st = liveState(b, now)
  el.classList.toggle('is-now', st === 'now')
  el.classList.toggle('is-overdue', st === 'ended')
  pill.hidden = !PILL[st]
  pill.textContent = PILL[st] || ''
  if (st === 'ended') pill.title = 'Finished: mark it done or no-show'
  const who = b.customer_name || 'customer'
  el.setAttribute('aria-label', `${timeOf(b.starts_at)} to ${timeOf(b.ends_at)}, ${b.service_name}, ${who}, ${b.source === 'whatsapp' ? 'booked on WhatsApp' : 'booked on the dashboard'}${PILL[st] ? `, ${PILL[st]}` : ''}`)
}

function emptyState() {
  const future = S.day >= todayLocal()
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('class', 'empty-chair')
  svg.setAttribute('viewBox', '0 0 96 80')
  svg.setAttribute('aria-hidden', 'true')
  const add = (parent, tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
    parent.append(n)
    return n
  }
  const st = { fill: 'none', stroke: 'currentColor', 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
  add(svg, 'path', { d: 'M30 76h36M48 76V60', ...st })
  const seat = add(svg, 'g', { class: 'seat' })
  add(seat, 'path', { d: 'M30 20c0-6 4-10 10-10h16c6 0 10 4 10 10v22H30z', ...st, fill: 'var(--navy-bg)' })
  add(seat, 'path', { d: 'M22 42h52v8a6 6 0 0 1-6 6H28a6 6 0 0 1-6-6z', ...st, fill: 'var(--red-bg)' })
  add(seat, 'path', { d: 'M22 34v8M74 34v8', ...st })
  add(seat, 'path', { d: 'M40 22h16', ...st, 'stroke-width': '2', opacity: '.5' })
  const card = h('div', { class: 'empty-card' }, svg,
    h('h3', { text: future ? 'The chairs are free' : 'No bookings that day' }),
    h('p', { text: future ? 'WhatsApp bookings appear here the moment they are made.' : 'Nothing was booked for this day.' }))
  if (future) card.append(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => openNew(S.day) } }, icon('calendar-plus'), 'New booking'))
  return h('div', { class: 'sg-empty' }, card)
}

// called every few seconds: now line, card states, column states, stats "next up"
function refreshLive() {
  if (!S.meta || S.loading) return
  const now = nowMs()
  const l = local(now)
  const isToday = S.day === l.date
  const line = view.nowLine
  if (line) {
    const inside = isToday && l.min >= view.startMin && l.min <= view.endMin
    line.hidden = !inside
    if (inside) {
      line.style.transform = `translateY(${(l.min - view.startMin) * PX_PER_MIN}px)`
      line.firstElementChild.textContent = l.time
    }
  }
  for (const card of view.cards.values()) applyCardState(card, now)
  for (const c of view.cols.values()) colState(c, now, isToday)
  renderNext(now)
}

function colState({ head, state, bar, list }, now, isToday) {
  const act = list.filter(isActive).sort((a, b) => startMs(a) - startMs(b))
  let ic = 'calendar', text = 'No bookings', busy = false, frac = 0
  if (act.length) {
    const ended = act.filter((b) => b.status !== 'confirmed' || endMs(b) <= now).length
    frac = ended / act.length
    const cur = act.find((b) => b.status === 'confirmed' && startMs(b) <= now && now < endMs(b))
    const next = act.find((b) => b.status === 'confirmed' && startMs(b) > now)
    if (cur) { busy = true; ic = 'scissors'; text = `${cur.customer_name || 'Customer'} in the chair · until ${timeOf(cur.ends_at)}` }
    else if (next && isToday) { ic = 'clock'; text = `Free · next at ${timeOf(next.starts_at)}` }
    else if (next) { ic = 'clock'; text = `First at ${timeOf(next.starts_at)}` }
    else {
      const done = act.filter((b) => b.status === 'done').length, ns = act.filter((b) => b.status === 'no_show').length
      const open = act.filter((b) => b.status === 'confirmed').length
      ic = open ? 'circle-alert' : 'check-check'
      text = open ? `${open} to mark done or no-show` : `Day closed · ${done} done${ns ? ` · ${ns} no-show` : ''}`
    }
  }
  head.classList.toggle('is-busy', busy)
  state.classList.toggle('is-busy', busy)
  clear(state)
  state.append(icon(ic, 'icon-sm'), h('span', { text }))
  state.title = text
  bar.style.transform = `scaleX(${frac})`
}

// ───────── stats ─────────
function renderStatsSkeleton() {
  for (const id of ['st-count', 'st-rev', 'st-next', 'st-lost']) {
    const el = $(id)
    el.textContent = ' '
    el.classList.add('is-skel', 'skel')
  }
  for (const id of ['st-count-sub', 'st-rev-sub', 'st-next-sub', 'st-lost-sub']) $(id).textContent = ' '
}

const statPrev = new Map()
function countTo(el, value, format) {
  el.classList.remove('is-skel', 'skel')
  const from = statPrev.get(el.id) ?? 0
  statPrev.set(el.id, value)
  if (reduced.matches || from === value) { el.textContent = format(value); return }
  const t0 = performance.now(), dur = 650
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur)
    const eased = 1 - Math.pow(1 - k, 3)
    el.textContent = format(Math.round(from + (value - from) * eased))
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function renderStats() {
  const list = S.bookings
  const act = list.filter(isActive)
  const done = act.filter((b) => b.status === 'done').length
  const open = act.filter((b) => b.status === 'confirmed').length
  const cancelled = list.length - act.length
  const noShow = act.filter((b) => b.status === 'no_show').length
  const rev = act.filter((b) => b.status !== 'no_show').reduce((s, b) => s + b.price_cents, 0)
  const revDone = act.filter((b) => b.status === 'done').reduce((s, b) => s + b.price_cents, 0)
  const lostCents = list.filter((b) => b.status === 'cancelled' || b.status === 'no_show').reduce((s, b) => s + b.price_cents, 0)
  const wa = act.filter((b) => b.source === 'whatsapp').length

  countTo($('st-count'), act.length, String)
  $('st-count-sub').textContent = act.length ? `${wa} via WhatsApp · ${done} done · ${open} open` : 'Nothing booked'
  countTo($('st-rev'), Math.round(rev / 100), (v) => money.format(v))
  $('st-rev-sub').textContent = rev ? `${euros(revDone)} already done` : 'No paid services'
  countTo($('st-lost'), cancelled + noShow, String)
  $('st-lost-sub').textContent = cancelled + noShow ? `${cancelled} cancelled · ${noShow} no-show · ${euros(lostCents)}` : 'None. Nice.'
  renderNext(nowMs())
}

function renderNext(now) {
  const el = $('st-next'), sub = $('st-next-sub'), label = $('st-next-label')
  if (!S.meta || S.loading) return
  el.classList.remove('is-skel', 'skel')
  const today = local(now).date
  const upcoming = S.bookings.filter((b) => b.status === 'confirmed' && startMs(b) > now).sort((a, b) => startMs(a) - startMs(b))
  const who = (b) => `${b.customer_name || 'Customer'} · ${b.service_name}${S.isOwner ? ` · ${b.barber_name}` : ''}`
  if (S.day < today) {
    label.textContent = 'Next up'
    el.textContent = '–'
    sub.textContent = 'This day is over'
  } else if (S.day > today) {
    label.textContent = 'First up'
    const first = upcoming[0]
    el.textContent = first ? timeOf(first.starts_at) : '–'
    sub.textContent = first ? who(first) : 'Nothing booked yet'
  } else {
    label.textContent = 'Next up'
    const next = upcoming[0]
    el.textContent = next ? timeOf(next.starts_at) : '–'
    sub.textContent = next ? `in ${minutesLabel((startMs(next) - now) / 60000)} · ${who(next)}` : 'Nothing else today'
  }
}

// ───────── booking details dialog ─────────
let openId = null
function findBooking(id) { return S.bookings.find((b) => b.id === id) }

function openBooking(id) {
  const b = findBooking(id)
  if (!b) return
  openId = id
  renderBookingDialog(b)
  const d = $('dlg-booking')
  if (!d.open) d.showModal()
}

function setError(el, msg) {
  clear(el)
  if (msg) el.append(icon('circle-alert'), h('span', { text: msg }))
  el.hidden = !msg
}

function renderBookingDialog(b) {
  const st = liveState(b)
  $('bd-when').textContent = `${dayShort(local(startMs(b)).date)} · ${timeOf(b.starts_at)}–${timeOf(b.ends_at)}`
  $('bd-title').textContent = b.customer_name || 'Customer'
  setError($('bd-error'), '')

  const rows = $('bd-rows')
  clear(rows)
  const row = (ic, label, ...value) => rows.append(h('div', { class: 'bd-row' }, icon(ic), h('dt', { text: label }), h('dd', null, ...value)))
  row('scissors', 'Service', `${b.service_name} · ${b.duration_min} min · ${euros(b.price_cents)}`)
  row('user', 'Barber', b.barber_name)
  const digits = String(b.customer_phone || '').replace(/\D/g, '')
  row('phone', 'WhatsApp', digits ? h('a', { href: `tel:+${digits}`, text: `+${digits}` }) : '–')
  row(b.source === 'whatsapp' ? 'message-circle' : 'store', 'Booked', `${b.source === 'whatsapp' ? 'On WhatsApp' : 'On the dashboard'} · ${dayShort(local(Date.parse(b.created_at)).date)}, ${timeOf(b.created_at)}`)
  const stText = st === 'now' ? 'In the chair now' : st === 'ended' ? 'Finished, not marked yet' : STATUS_TEXT[b.status]
  row('badge-check', 'Status', h('span', { class: `tag ${st === 'ended' ? 'tag-warn' : STATUS_TAG[b.status]}`, text: stText }))
  if (b.status === 'cancelled') row('ban', 'Cancelled by', b.cancelled_by === 'customer' ? 'The customer, on WhatsApp' : (b.cancelled_by ? `The shop (${b.cancelled_by})` : 'The shop'))

  const foot = $('bd-actions')
  clear(foot)
  const started = st === 'now' || st === 'ended'
  if (b.status === 'confirmed') {
    if (started) {
      foot.append(
        h('button', { type: 'button', class: 'btn btn-warn', on: { click: (e) => setStatus(b, 'no_show', e.currentTarget) } }, icon('user-x'), 'No-show'),
        h('button', { type: 'button', class: 'btn btn-ok', on: { click: (e) => setStatus(b, 'done', e.currentTarget) } }, icon('user-check'), 'Done'))
    } else {
      foot.append(h('p', { class: 'bd-hint' }, icon('info', 'icon-sm'), h('span', { text: 'Done and no-show unlock when the appointment starts.' })))
    }
    if (startMs(b) > nowMs()) {
      foot.prepend(h('button', { type: 'button', class: 'btn btn-ghost', 'data-cancel': '', on: { click: () => askCancel(b) } }, icon('circle-x'), 'Cancel booking'))
    }
  } else if (b.status === 'done' || b.status === 'no_show') {
    foot.append(h('button', { type: 'button', class: 'btn btn-ghost', on: { click: (e) => setStatus(b, 'confirmed', e.currentTarget) } }, icon('rotate-ccw'), `Undo ${STATUS_TEXT[b.status].toLowerCase()}`))
  }
  foot.append(h('button', { type: 'button', class: 'btn btn-ghost', 'data-close': '' }, 'Close'))
}

function askCancel(b) {
  const foot = $('bd-actions')
  foot.querySelector('.bd-confirm')?.remove()
  const trigger = foot.querySelector('[data-cancel]')
  if (trigger) trigger.hidden = true
  const yes = h('button', { type: 'button', class: 'btn btn-danger' }, icon('circle-x'), 'Yes, cancel it')
  const keep = () => {
    box.remove()
    if (trigger) { trigger.hidden = false; trigger.focus() }
  }
  const box = h('div', { class: 'bd-confirm', role: 'group', 'aria-label': 'Confirm cancellation' },
    h('p', null, 'Cancel ', h('strong', { text: b.customer_name || 'this customer' }), `'s ${b.service_name} at ${timeOf(b.starts_at)}? They get a WhatsApp message saying the shop had to cancel.`),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn-ghost', on: { click: keep } }, 'Keep it'), yes))
  yes.addEventListener('click', () => doCancel(b, yes))
  foot.prepend(box)
  yes.focus()
}

async function busyButton(btn, fn) {
  const ic = btn?.querySelector('.icon')
  const spinner = icon('loader-circle', 'spin')
  if (btn) { btn.disabled = true; ic?.replaceWith(spinner) }
  try { return await fn() } finally {
    if (btn && btn.isConnected) { btn.disabled = false; spinner.replaceWith(ic || '') }
  }
}

async function doCancel(b, btn) {
  try {
    const r = await busyButton(btn, () => api(`/api/bookings/${b.id}/cancel`, { method: 'POST', body: {} }))
    upsertBooking(r.booking, 'changed')
    $('dlg-booking').close()
    toast('Booking cancelled', `${b.customer_name || 'The customer'} gets a WhatsApp message. ${timeOf(b.starts_at)} is free again.`, 'red', 'circle-x')
  } catch (err) {
    setError($('bd-error'), friendly(err.code))
    if (err.code === 'not_active') loadDay()
  }
}

async function setStatus(b, status, btn) {
  try {
    const r = await busyButton(btn, () => api(`/api/bookings/${b.id}/status`, { method: 'POST', body: { status } }))
    upsertBooking(r.booking, 'changed')
    const words = { done: ['Marked done', 'ok', 'user-check'], no_show: ['Marked no-show', 'warn', 'user-x'], confirmed: ['Back to confirmed', 'ok', 'rotate-ccw'] }[status]
    toast(words[0], `${b.customer_name || 'Customer'} · ${b.service_name} · ${timeOf(b.starts_at)}`, words[1], words[2])
  } catch (err) {
    setError($('bd-error'), friendly(err.code))
    if (err.code === 'not_active') loadDay()
  }
}

// merge one booking (from an API answer or the live stream) into the view
function upsertBooking(b, flash) {
  if (!b) return
  const onDay = local(startMs(b)).date === S.day
  const i = S.bookings.findIndex((x) => x.id === b.id)
  if (i >= 0 && onDay) S.bookings[i] = b
  else if (i >= 0) S.bookings.splice(i, 1)
  else if (onDay) S.bookings.push(b)
  else return
  if (flash && !reduced.matches) S.freshIds.set(b.id, flash)
  S.bookings.sort((a, c) => startMs(a) - startMs(c))
  renderSchedule()
  renderStats()
  if (openId === b.id && $('dlg-booking').open) renderBookingDialog(b)
}

// ───────── new booking sheet ─────────
const NB = { service: null, barber: null, date: null, slot: null, gen: 0, built: false }
const DAYS_AHEAD = 14

function radio(name, value, checked, face, extra = {}) {
  const input = h('input', { type: 'radio', name, value: String(value), ...extra })
  input.checked = !!checked
  return h('label', { class: 'opt' }, input, face)
}

function buildNewForm() {
  const m = S.meta
  const sv = $('nb-services')
  clear(sv)
  for (const s of m.services) {
    sv.append(radio('nb-service', s.id, false, h('span', { class: 'opt-face' },
      h('span', { class: 'opt-title', text: s.name }),
      h('span', { class: 'opt-sub num', text: `${s.duration_min} min · ${euros(s.price_cents)}` }))))
  }
  const br = $('nb-barbers')
  clear(br)
  if (S.isOwner) {
    br.append(radio('nb-barber', '', true, h('span', { class: 'opt-face' }, h('span', { class: 'opt-dot' }, icon('users', 'icon-sm')), h('span', { class: 'opt-title', text: 'Anyone free' }))))
    for (const b of m.barbers) {
      br.append(radio('nb-barber', b.id, false, h('span', { class: `opt-face ${chairClass(b.id)}` },
        h('span', { class: 'opt-dot', text: b.name.slice(0, 1).toUpperCase() }), h('span', { class: 'opt-title', text: b.name }))))
    }
  }
  NB.built = true
}

function buildDays(selected) {
  const box = $('nb-days')
  clear(box)
  const today = todayLocal()
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const d = addDays(today, i)
    box.append(radio('nb-day', d, d === selected, h('span', { class: 'opt-face' },
      h('span', { class: 'opt-sub', text: i === 0 ? 'Today' : weekdayShort(d) }),
      h('span', { class: 'opt-title num', text: String(Number(d.slice(8))) })), { 'aria-label': dayLong(d) }))
  }
  box.querySelector('input:checked')?.closest('.opt')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' })
}

function openNew(date) {
  if (!S.meta) return
  if (!NB.built) buildNewForm()
  const today = todayLocal()
  const last = addDays(today, DAYS_AHEAD)
  const d = !date || date < today ? today : date > last ? last : date
  NB.date = d
  NB.slot = null
  NB.service = null
  for (const r of document.querySelectorAll('input[name="nb-service"]')) r.checked = false
  NB.barber = S.isOwner ? null : S.meta.barberId
  if (S.isOwner) for (const r of document.querySelectorAll('input[name="nb-barber"]')) r.checked = r.value === ''
  $('nb-name').value = ''
  $('nb-phone').value = ''
  for (const id of ['nb-name', 'nb-phone']) $(id).removeAttribute('aria-invalid')
  setError($('nb-error'), '')
  $('dlg-new').showModal()
  buildDays(d)
  renderSlotsHint('Pick a service to see the free times.')
  updateSummary()
  document.querySelector('input[name="nb-service"]')?.focus()
}

function renderSlotsHint(text, ic = 'info') {
  const box = $('nb-slots')
  clear(box)
  box.append(h('p', { class: 'slots-empty' }, icon(ic), h('span', { text })))
}

async function loadSlots() {
  NB.slot = null
  updateSummary()
  if (!NB.service || !NB.date) return renderSlotsHint('Pick a service to see the free times.')
  const gen = ++NB.gen
  const box = $('nb-slots')
  clear(box)
  const sk = h('div', { class: 'slot-grid', 'aria-label': 'Loading free times' })
  for (let i = 0; i < 8; i++) sk.append(h('span', { class: 'skel skel-slot' }))
  box.append(sk)
  let slots
  try {
    const q = new URLSearchParams({ date: NB.date, service: String(NB.service) })
    if (NB.barber) q.set('barber', String(NB.barber))
    slots = (await api(`/api/slots?${q}`)).slots
  } catch (err) {
    if (gen === NB.gen) renderSlotsHint(friendly(err.code), 'circle-alert')
    return
  }
  if (gen !== NB.gen) return
  clear(box)
  if (!slots.length) {
    return renderSlotsHint(NB.date === todayLocal() ? 'No free times left today. Try another day.' : 'No free times on this day (closed or fully booked). Try another day.', 'calendar')
  }
  const names = new Map(S.meta.barbers.map((b) => [b.id, b.name]))
  const groups = [['Morning', 'sun', (t) => t < '12:00'], ['Afternoon', 'clock', (t) => t >= '12:00' && t < '17:00'], ['Evening', 'moon', (t) => t >= '17:00']]
  let i = 0
  for (const [label, ic, test] of groups) {
    const list = slots.filter((s) => test(s.time))
    if (!list.length) continue
    const grid = h('div', { class: 'slot-grid', role: 'radiogroup', 'aria-label': `${label} times` })
    for (const s of list) {
      const who = s.barberIds.map((id) => names.get(id)).filter(Boolean).join(', ')
      const opt = radio('nb-slot', s.start, false, h('span', { class: 'opt-face num', text: s.time }),
        { 'aria-label': `${s.time}${S.isOwner && !NB.barber ? `, free: ${who}` : ''}`, 'data-time': s.time })
      if (S.isOwner && !NB.barber) opt.title = `Free: ${who}`
      if (!reduced.matches) opt.style.animationDelay = `${Math.min(i++, 20) * 18}ms`
      grid.append(opt)
    }
    box.append(h('div', { class: 'slot-group' }, h('p', { class: 'slot-group-label' }, icon(ic, 'icon-sm'), label), grid))
  }
}

const phoneDigits = () => $('nb-phone').value.replace(/\D/g, '').replace(/^00/, '')
const nameValue = () => $('nb-name').value.replace(/\s+/g, ' ').trim()

function updateSummary() {
  const sum = $('nb-summary')
  clear(sum)
  const svc = S.meta?.services.find((s) => s.id === NB.service)
  if (!svc) { sum.textContent = 'Pick a service, a day and a time.'; $('nb-submit').disabled = true; return }
  const barber = NB.barber ? S.meta.barbers.find((b) => b.id === NB.barber)?.name : 'anyone free'
  const slotInput = document.querySelector('input[name="nb-slot"]:checked')
  sum.append(h('strong', { text: svc.name }), ` · ${dayShort(NB.date)}${slotInput ? `, ${slotInput.dataset.time}` : ''} · ${barber}`)
  const ready = !!NB.slot && nameValue().length >= 2 && /^\d{8,15}$/.test(phoneDigits())
  $('nb-submit').disabled = !ready
}

async function submitNew(e) {
  e.preventDefault()
  const name = nameValue(), phone = phoneDigits()
  let bad = null
  if (!NB.slot) bad = ['Pick a free time.', null]
  else if (name.length < 2) bad = [friendly('name is required'), 'nb-name']
  else if (/^0/.test($('nb-phone').value.trim()) && !/^00/.test($('nb-phone').value.trim())) bad = ['Start with the country code (353 for Ireland) instead of the leading 0.', 'nb-phone']
  else if (!/^\d{8,15}$/.test(phone)) bad = [friendly('phone must be 8–15 digits with country code'), 'nb-phone']
  $('nb-name').toggleAttribute('aria-invalid', bad?.[1] === 'nb-name')
  $('nb-phone').toggleAttribute('aria-invalid', bad?.[1] === 'nb-phone')
  if (bad?.[1]) $(bad[1]).setAttribute('aria-invalid', 'true')
  if (bad) { setError($('nb-error'), bad[0]); if (bad[1]) $(bad[1]).focus(); return }
  setError($('nb-error'), '')
  const btn = $('nb-submit')
  try {
    S.creating = true
    const r = await busyButton(btn, () => api('/api/bookings', { method: 'POST', body: { phone, name, serviceId: NB.service, barberId: NB.barber, start: NB.slot } }))
      .finally(() => { S.creating = false })
    const b = r.booking
    S.mine.add(b.id)
    $('dlg-new').close()
    toast('Booked', `${b.customer_name}, ${b.service_name} with ${b.barber_name}, ${dayShort(local(startMs(b)).date)} ${timeOf(b.starts_at)}. WhatsApp confirmation sent to …${phone.slice(-4)}.`, 'ok', 'calendar-plus')
    const date = local(startMs(b)).date
    if (date !== S.day) { S.day = date; replay($('day-title'), 'is-changing'); await loadDay(false) }
    upsertBooking(b, 'new')
  } catch (err) {
    setError($('nb-error'), friendly(err.code))
    if (err.code === 'slot_taken') loadSlots()
  } finally {
    updateSummary()
  }
}

// ───────── reminders explainer ─────────
function renderReminders() {
  const r = S.meta.reminders
  const list = $('rem-list')
  clear(list)
  const items = [
    ['day', 'sun', `Daily summary · ${r.dailySummaryAt}`, 'Barber', 'Each barber gets the day\'s list on WhatsApp before opening.'],
    ['barber', 'alarm-clock', `${minutesLabel(r.barberMin)} before`, 'Barber', 'A heads-up with the service and the customer\'s name.'],
    ['customer', 'bell', `${minutesLabel(r.customerMin)} before`, 'Customer', 'Reminder with two buttons: "I\'ll be there" or "I need to cancel".'],
    ['live', 'message-circle', 'Instantly', 'Both', 'New or cancelled booking: the barber is told; a booking made here sends the customer a confirmation.'],
  ]
  for (const [kind, ic, when, who, what] of items) {
    list.append(h('li', { class: 'rem', 'data-kind': kind },
      h('span', { class: 'rem-icon' }, icon(ic)),
      h('div', null,
        h('p', { class: 'rem-when' }, h('span', { text: when }), h('span', { class: `tag ${who === 'Customer' ? 'tag-ok' : 'tag-navy'}`, text: who }), h('span', { class: 'tag tag-red rem-sent', hidden: true })),
        h('p', { class: 'rem-what', text: what }))))
  }
}
const REM_KIND = { barber_day: 'day', barber_30m: 'barber', customer_1h: 'customer' }
function pulseReminder(key, ok) {
  const kind = REM_KIND[String(key).split(':')[0]] || 'live'
  const li = document.querySelector(`.rem[data-kind="${kind}"]`)
  if (!li) return
  replay(li, 'is-fired')
  const tag = li.querySelector('.rem-sent')
  tag.hidden = false
  tag.className = `tag ${ok ? 'tag-red' : 'tag-warn'} rem-sent`
  // no clock time here: during a time-machine jump this event arrives before the new time does
  tag.textContent = ok ? 'Just sent' : 'Failed'
}

// ───────── WhatsApp activity feed (owner) ─────────
let feedTimer = null
function refreshFeedSoon() {
  if (!S.isOwner) return
  clearTimeout(feedTimer)
  feedTimer = setTimeout(() => loadMessages(false), 350)
}

async function loadMessages(first) {
  if (!S.isOwner) return
  const box = $('feed')
  if (first) {
    clear(box)
    for (let i = 0; i < 4; i++) box.append(h('li', { class: 'skel skel-msg', 'aria-hidden': 'true' }))
  }
  let msgs
  try {
    msgs = (await api('/api/messages?limit=50')).messages
  } catch (err) {
    if (first) { clear(box); box.append(h('li', { class: 'feed-empty', text: friendly(err.code) })) }
    return
  }
  const isFirst = !S.seenMsgIds.size
  clear(box)
  $('feed-count').textContent = msgs.length ? `last ${msgs.length}` : ''
  if (!msgs.length) {
    box.append(h('li', { class: 'feed-empty', text: 'No WhatsApp messages yet. They show up here as they are sent.' }))
    return
  }
  const today = todayLocal()
  for (const m of msgs) {
    const isNew = !isFirst && !S.seenMsgIds.has(m.id)
    S.seenMsgIds.add(m.id)
    box.append(messageItem(m, isNew && !reduced.matches, today))
  }
}

const KIND_TEXT = { buttons: 'Buttons', list: 'List', reply: 'Tapped a button' }
function messageItem(m, isNew, today) {
  const out = m.direction === 'out'
  const failed = m.status === 'failed'
  const body = m.body || {}
  const text = body.text || body.replyTitle || (Array.isArray(body.params) ? body.params.join(' · ') : '')
  const t = local(Date.parse(m.created_at))
  const meta = h('p', { class: 'msg-meta' },
    h('span', { class: 'msg-who', text: `${out ? 'To' : 'From'} ${m.phone}` }))
  if (m.kind === 'template') {
    // native title, not the CSS data-tip: that invisible 260px bubble widened the page at 375px
    meta.append(h('span', { class: 'tag tag-warn badge-tpl', title: 'Sent as a Meta-approved template: the person had not written in the last 24 h, so free text was not allowed.' }, 'Template'))
  } else if (KIND_TEXT[m.kind]) {
    meta.append(h('span', { class: 'tag', text: KIND_TEXT[m.kind] }))
  }
  meta.append(h('span', { class: 'msg-time', text: t.date === today ? t.time : `${dayShort(t.date)}, ${t.time}` }))
  const content = h('div', null, meta, h('p', { class: 'msg-body', text }))
  if (m.kind === 'template' && body.name) content.append(h('p', { class: 'msg-tpl-name', text: `template: ${body.name}` }))
  if (failed) content.append(h('p', { class: 'msg-fail' }, icon('triangle-alert', 'icon-sm'), h('span', { text: m.error || 'Not delivered' })))
  return h('li', { class: `msg${isNew ? ' is-new' : ''}` },
    h('span', { class: `msg-dir${out ? '' : ' is-in'}${failed ? ' is-failed' : ''}`, 'aria-hidden': 'true' }, icon(failed ? 'triangle-alert' : out ? 'arrow-up-right' : 'arrow-down-left')),
    content)
}

// ───────── shop clock + time machine dial ─────────
let lastMinute = ''
function buildDial() {
  const g = $('dial-ticks')
  clear(g)
  for (let i = 0; i < 12; i++) {
    const a = (i * 30 * Math.PI) / 180, major = i % 3 === 0
    const r1 = major ? 44 : 47, r2 = 52
    const line = document.createElementNS(SVGNS, 'line')
    line.setAttribute('x1', String(60 + r1 * Math.sin(a)))
    line.setAttribute('y1', String(60 - r1 * Math.cos(a)))
    line.setAttribute('x2', String(60 + r2 * Math.sin(a)))
    line.setAttribute('y2', String(60 - r2 * Math.cos(a)))
    if (major) line.setAttribute('class', 'major')
    g.append(line)
  }
}

function updateClock() {
  if (!S.meta) return
  const now = nowMs()
  const l = local(now)
  const off = S.meta.clockOffsetMin || 0
  $('clock-time').textContent = l.time
  $('clock-date').textContent = dayShort(l.date)
  const shift = $('clock-shift')
  shift.hidden = !off
  shift.textContent = off ? `+${minutesLabel(off).replace(' min', 'm').replace(' h', 'h')}` : ''
  $('shop-clock').title = off ? `Shop time (demo clock ${offsetLabel(off)})` : `Shop time (${S.meta.timeZone})`
  if (S.meta.demo) {
    $('mc-time').textContent = l.time
    $('mc-date').textContent = dayLong(l.date)
    const o = $('mc-offset')
    o.textContent = offsetLabel(off)
    o.classList.toggle('is-shifted', !!off)
    // hands keep turning forwards across midnight: angle from an absolute minute count
    const total = daysBetween('2020-01-01', l.date) * 1440 + l.min
    const svg = $('hand-m').ownerSVGElement
    svg.style.setProperty('--rot-m', `${total * 6}deg`)
    svg.style.setProperty('--rot-h', `${total * 0.5}deg`)
  }
  const minuteKey = `${l.date} ${l.time}`
  if (minuteKey !== lastMinute) {
    const prevDate = lastMinute.slice(0, 10)
    lastMinute = minuteKey
    // the shop rolled into a new day while "today" was on screen: follow it
    if (prevDate && prevDate !== l.date && S.day === prevDate) goDay(l.date)
    else { renderDayHead(); refreshLive() }
  }
}

async function moveClock(btn, body) {
  if (S.jump) return
  S.jump = { reminders: 0 }
  const buttons = document.querySelectorAll('#machine .machine-btns .btn')
  for (const b of buttons) b.disabled = true
  try {
    const r = await busyButton(btn, () => api('/api/demo/clock', { method: 'POST', body }))
    applyClock(r.now, r.clockOffsetMin)
    await new Promise((res) => setTimeout(res, 450)) // let the reminder events arrive
    const n = S.jump.reminders
    toast(body.reset ? 'Back to real time' : `Clock moved to ${local(nowMs()).time}`,
      n ? `${n} reminder${n > 1 ? 's' : ''} sent on WhatsApp. See the activity feed.` : 'No reminder was due in that time.', n ? 'ok' : 'warn', n ? 'bell' : 'clock')
  } catch (err) {
    toast('The clock did not move', friendly(err.code), 'red', 'circle-alert')
  } finally {
    S.jump = null
    for (const b of buttons) b.disabled = false
  }
}

// a new server time from the time machine (this tab or another one)
let lastClockApplied = ''
function applyClock(nowIso, offsetMin) {
  if (!S.meta) return
  const before = todayLocal()
  setServerNow(nowIso)
  S.meta.clockOffsetMin = offsetMin
  if (lastClockApplied === `${nowIso}|${offsetMin}`) return
  lastClockApplied = `${nowIso}|${offsetMin}`
  replay($('shop-clock'), 'is-jump')
  const after = todayLocal()
  lastMinute = `${after} ${local(nowMs()).time}`
  if (S.day === before && before !== after) S.day = after
  updateClock()
  loadDay(false)
  refreshFeedSoon()
}

// ───────── live updates (Server-Sent Events) ─────────
let bandTimer = null
function activity() {
  const band = $('band')
  band.setAttribute('data-moving', '')
  clearTimeout(bandTimer)
  bandTimer = setTimeout(() => band.removeAttribute('data-moving'), 2400)
}

function setLive(on) {
  const el = $('live')
  el.dataset.state = on ? 'on' : 'off'
  el.querySelector('.live-text').textContent = on ? 'Live' : 'Offline'
  el.title = on ? 'Updates arrive by themselves' : 'Reconnecting… changes may be missing'
  $('top-pole').toggleAttribute('data-still', !on)
}

let retryTimer = null
function startLive() {
  stopLive()
  const es = new EventSource('/api/events')
  S.es = es
  let dropped = false
  es.addEventListener('open', () => {
    setLive(true)
    if (dropped) { dropped = false; loadDay(false); refreshFeedSoon() } // catch up on what we missed
  })
  es.addEventListener('error', () => {
    setLive(false)
    dropped = true
    if (es.readyState === EventSource.CLOSED) {
      // the browser gave up (e.g. the session ended): check, then try again
      clearTimeout(retryTimer)
      retryTimer = setTimeout(async () => {
        try {
          const s = await api('/api/session')
          if (!s.loggedIn) return sessionLost()
          startLive()
        } catch { retryTimer = setTimeout(startLive, 5000) }
      }, 3000)
    }
  })
  const data = (e) => { try { return JSON.parse(e.data) } catch { return {} } }
  es.addEventListener('hello', (e) => { const d = data(e); if (d.now) setServerNow(d.now) })
  es.addEventListener('ping', (e) => { const d = data(e); if (d.now) setServerNow(d.now) })
  es.addEventListener('clock', (e) => { const d = data(e); if (d.now) applyClock(d.now, d.clockOffsetMin) })
  es.addEventListener('booking', (e) => {
    const { type, booking: b } = data(e)
    if (!b) return
    activity()
    upsertBooking(b, type === 'created' ? 'new' : 'changed')
    if (type === 'created' && S.creating && b.source === 'dashboard') S.mine.add(b.id)
    if (type === 'created' && !S.mine.has(b.id)) {
      toast(b.source === 'whatsapp' ? 'New WhatsApp booking' : 'New booking',
        `${b.customer_name || 'Customer'}, ${b.service_name}${S.isOwner ? ` with ${b.barber_name}` : ''}, ${dayShort(local(startMs(b)).date)} ${timeOf(b.starts_at)}.`, 'ok', 'calendar-plus')
    } else if (type === 'cancelled' && b.cancelled_by === 'customer') {
      toast('Cancelled on WhatsApp', `${b.customer_name || 'Customer'}, ${b.service_name}, ${dayShort(local(startMs(b)).date)} ${timeOf(b.starts_at)}. The slot is free again.`, 'red', 'circle-x')
    }
    refreshFeedSoon()
  })
  es.addEventListener('reminder', (e) => {
    const { key, ok } = data(e)
    activity()
    pulseReminder(key, ok)
    if (S.jump) S.jump.reminders++
    else if (!ok) toast('A reminder failed', 'It will be retried automatically.', 'red', 'triangle-alert')
    refreshFeedSoon()
  })
}
function stopLive() {
  clearTimeout(retryTimer)
  if (S.es) { S.es.close(); S.es = null }
  setLive(false)
}

// ───────── wiring ─────────
function wire() {
  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault()
    doLogin($('login-user').value.trim(), $('login-pass').value)
  })
  for (const chip of document.querySelectorAll('[data-login]')) {
    chip.addEventListener('click', () => {
      $('login-user').value = chip.dataset.login
      $('login-pass').value = 'demo1234'
      doLogin(chip.dataset.login, 'demo1234')
    })
  }
  $('logout').addEventListener('click', doLogout)

  $('day-prev').addEventListener('click', () => goDay(addDays(S.day, -1)))
  $('day-next').addEventListener('click', () => goDay(addDays(S.day, 1)))
  $('day-today').addEventListener('click', () => goDay(todayLocal()))
  $('new-booking').addEventListener('click', () => openNew(S.day))
  $('fab').addEventListener('click', () => openNew(S.day))

  // dialogs: [data-close] buttons and a click on the backdrop close them
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => {
      if (e.target === d || e.target.closest('[data-close]')) d.close()
    })
  }
  $('dlg-booking').addEventListener('close', () => { openId = null })

  $('nb-form').addEventListener('change', (e) => {
    const t = e.target
    if (t.name === 'nb-service') { NB.service = Number(t.value); loadSlots() }
    else if (t.name === 'nb-barber') { NB.barber = Number(t.value) || null; loadSlots() }
    else if (t.name === 'nb-day') { NB.date = t.value; loadSlots() }
    else if (t.name === 'nb-slot') { NB.slot = t.value; updateSummary() }
  })
  $('nb-form').addEventListener('input', (e) => {
    if (e.target.id === 'nb-name' || e.target.id === 'nb-phone') { e.target.removeAttribute('aria-invalid'); updateSummary() }
  })
  $('nb-form').addEventListener('submit', submitNew)

  for (const b of document.querySelectorAll('#machine [data-advance]')) {
    b.addEventListener('click', () => moveClock(b, { advanceMin: Number(b.dataset.advance) }))
  }
  $('machine').querySelector('[data-reset]').addEventListener('click', (e) => moveClock(e.currentTarget, { reset: true }))

  // arrow keys move between days when nothing else wants them
  document.addEventListener('keydown', (e) => {
    if ($('app').hidden || document.querySelector('dialog[open]') || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.target.closest('input, textarea, select, [contenteditable]')) return
    if (e.key === 'ArrowLeft' && S.day) goDay(addDays(S.day, -1))
    else if (e.key === 'ArrowRight' && S.day) goDay(addDays(S.day, 1))
  })

  setInterval(updateClock, 1000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.meta) { updateClock(); loadDay(false); refreshFeedSoon() }
  })
}

wire()
boot()
