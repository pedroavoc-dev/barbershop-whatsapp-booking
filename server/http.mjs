// Web server: dashboard files + JSON API, live updates (SSE), login,
// the Meta webhook and, in simulator mode, the fake-phone endpoints.
// Rule: nothing that changes data happens on GET.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { ROOT } from './config.mjs'
import { iso, addDays } from './time.mjs'
import { validSignature, parseWebhook } from './whatsapp.mjs'

const scrypt = promisify(scryptCb)
const PUBLIC = join(ROOT, 'public')
const SESSION_HOURS = 24 * 7
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
}
const PHONE = /^\d{8,15}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const h = await scrypt(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`
}
async function checkPassword(password, stored) {
  const [, saltHex, hHex] = stored.split('$')
  const h = await scrypt(password, Buffer.from(saltHex, 'hex'), 64)
  return timingSafeEqual(h, Buffer.from(hHex, 'hex'))
}

export function createHttp({ db, clock, config, bookings, wa, conversation, reminders, bus }) {
  const streams = new Set() // { res, barberId }
  const attempts = new Map()

  function push(event, data, barberId = null) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const s of streams) if (!barberId || !s.barberId || s.barberId === barberId) s.res.write(line)
  }
  for (const ev of ['booking:created', 'booking:cancelled', 'booking:updated']) {
    bus.on(ev, (b) => push('booking', { type: ev.split(':')[1], booking: b }, b.barber_id))
  }
  bus.on('reminder', (r) => push('reminder', r))
  setInterval(() => push('ping', { now: iso(clock.now()) }), 20000).unref()

  // ───────── session ─────────
  function readSession(req) {
    const token = /(?:^|;\s*)session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1]
    if (!token) return null
    const s = db.prepare(`SELECT s.token, s.csrf, s.expires_at, u.login, u.barber_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token)
    return s && s.expires_at > new Date().toISOString() ? s : null
  }
  const locked = (k) => { const t = attempts.get(k); return !!t && Date.now() - t.since < 15 * 60e3 && t.n >= 5 }
  const failed = (k) => { const t = attempts.get(k); if (!t || Date.now() - t.since > 15 * 60e3) attempts.set(k, { n: 1, since: Date.now() }); else t.n++ }

  // a barber only sees and changes their own bookings; the owner (barber_id NULL) sees all
  const mine = (session, b) => b && (!session.barber_id || session.barber_id === b.barber_id)

  // ───────── API ─────────
  const routes = {
    'GET /api/session': ({ session }) => (session
      ? { loggedIn: true, login: session.login, barberId: session.barber_id, csrf: session.csrf }
      : { loggedIn: false, demo: config.demo }),

    'POST /api/login': async ({ body, ip, res }) => {
      const key = `${ip}|${String(body.login || '').slice(0, 30)}`
      if (locked(key)) return fail(429, 'too many attempts, wait 15 minutes')
      const u = db.prepare('SELECT * FROM users WHERE login = ?').get(String(body.login || ''))
      // check even without a user, so response time doesn't reveal which logins exist
      const ok = await checkPassword(String(body.password || ''), u?.password_hash || 'scrypt$00$' + '00'.repeat(64)).catch(() => false)
      if (!u || !ok) { failed(key); return fail(401, 'wrong login or password') }
      attempts.delete(key)
      const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex')
      db.prepare('INSERT INTO sessions (token, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)')
        .run(token, u.id, csrf, new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString())
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString())
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${config.secureCookie ? '; Secure' : ''}`)
      return { ok: true, csrf }
    },

    'POST /api/logout': ({ session, res }) => {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(session.token)
      res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
      return { ok: true }
    },

    'GET /api/meta': ({ session }) => ({
      shop: config.shopName, timeZone: config.timeZone, now: iso(clock.now()), today: bookings.today(),
      clockOffsetMin: clock.offsetMin(), demo: config.demo, whatsappMode: config.whatsappMode,
      services: bookings.services(), barbers: bookings.barbers(), barberId: session.barber_id,
      reminders: { dailySummaryAt: config.dailySummaryAt, customerMin: config.customerReminderMin, barberMin: config.barberReminderMin },
    }),

    'GET /api/bookings': ({ url, session }) => {
      const from = url.searchParams.get('from') || bookings.today()
      const days = Math.min(31, Math.max(1, Number(url.searchParams.get('days')) || 1))
      if (!DATE.test(from)) return fail(400, 'from must be YYYY-MM-DD')
      const barber = session.barber_id || (Number(url.searchParams.get('barber')) || null)
      return { bookings: bookings.between(from, addDays(from, days), barber) }
    },

    'GET /api/slots': ({ url, session }) => {
      const date = url.searchParams.get('date'), service = Number(url.searchParams.get('service'))
      if (!DATE.test(date || '') || !service) return fail(400, 'date and service are required')
      const barber = session.barber_id || (Number(url.searchParams.get('barber')) || null)
      return { slots: bookings.slots(date, service, barber) }
    },

    // phone / walk-in booking made by staff
    'POST /api/bookings': ({ body, session }) => {
      const phone = String(body.phone || '').replace(/\D/g, '')
      const name = String(body.name || '').replace(/[^\p{L}\p{M}' .-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40)
      if (!PHONE.test(phone)) return fail(400, 'phone must be 8–15 digits with country code')
      if (name.length < 2) return fail(400, 'name is required')
      const barberId = session.barber_id || (Number(body.barberId) || null)
      const r = bookings.book({ phone, name, serviceId: Number(body.serviceId), barberId, start: String(body.start || ''), source: 'dashboard' })
      return r.error ? fail(409, r.error) : { ok: true, booking: r.booking }
    },

    'GET /api/messages': ({ url, session }) => {
      if (session.barber_id) return fail(403, 'owner only')
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
      const rows = db.prepare('SELECT id, direction, phone, kind, body, status, error, created_at FROM messages ORDER BY id DESC LIMIT ?').all(limit)
      return { messages: rows.map((m) => ({ ...m, phone: '…' + m.phone.slice(-4), body: JSON.parse(m.body) })) }
    },

    'POST /api/demo/clock': async ({ body }) => {
      if (!config.demo) return fail(404, 'route does not exist')
      if (body.reset) clock.reset()
      else {
        const min = Number(body.advanceMin)
        if (!Number.isInteger(min) || min < 1 || min > 24 * 60) return fail(400, 'advanceMin must be 1–1440')
        clock.advance(min)
      }
      await reminders.tick()
      push('clock', { now: iso(clock.now()), clockOffsetMin: clock.offsetMin() })
      return { ok: true, now: iso(clock.now()), clockOffsetMin: clock.offsetMin() }
    },
  }

  const paramRoutes = [
    [/^POST \/api\/bookings\/(\d+)\/cancel$/, ({ session }, id) => {
      if (!mine(session, bookings.get(Number(id)))) return fail(404, 'booking not found')
      const r = bookings.cancel(Number(id), { by: session.login })
      return r.error ? fail(409, r.error) : { ok: true, booking: r.booking }
    }],
    [/^POST \/api\/bookings\/(\d+)\/status$/, ({ session, body }, id) => {
      if (!mine(session, bookings.get(Number(id)))) return fail(404, 'booking not found')
      const r = bookings.setStatus(Number(id), String(body.status || ''))
      return r.error ? fail(409, r.error) : { ok: true, booking: r.booking }
    }],
  ]

  // ───────── simulator (fake phones, only when not connected to Meta) ─────────
  const sim = {
    'GET /sim/phones': () => ({ shop: config.shopName, barbers: db.prepare('SELECT id, name, phone FROM barbers WHERE active = 1').all() }),
    'GET /sim/messages': ({ url }) => {
      const phone = url.searchParams.get('phone') || ''
      if (!PHONE.test(phone)) return fail(400, 'bad phone')
      const after = Number(url.searchParams.get('after')) || 0
      const rows = db.prepare('SELECT id, direction, kind, body, status, created_at FROM messages WHERE phone = ? AND id > ? ORDER BY id LIMIT 200').all(phone, after)
      return { messages: rows.map((m) => ({ ...m, body: JSON.parse(m.body) })), now: iso(clock.now()) }
    },
    'POST /sim/send': async ({ body }) => {
      const phone = String(body.phone || '')
      if (!PHONE.test(phone)) return fail(400, 'bad phone')
      const text = String(body.text || '').slice(0, 1000), replyId = body.replyId ? String(body.replyId).slice(0, 100) : null
      if (!text && !replyId) return fail(400, 'empty message')
      wa.receive({ phone, text, replyId, replyTitle: replyId ? text : null })
      await conversation.handle({ phone, text, replyId })
      return { ok: true }
    },
  }

  // ───────── Meta webhook ─────────
  async function webhook(req, res, url) {
    if (config.whatsappMode !== 'cloud') return send(res, 404, { error: 'route does not exist' })
    if (req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && same(url.searchParams.get('hub.verify_token'), config.wa.verifyToken)
      res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/plain' })
      return res.end(ok ? String(url.searchParams.get('hub.challenge') || '') : 'forbidden')
    }
    const raw = await readRaw(req, 256_000)
    if (!validSignature(raw, req.headers['x-hub-signature-256'], config.wa.appSecret)) {
      console.error('[webhook] invalid signature, ignored')
      return send(res, 401, { error: 'invalid signature' })
    }
    send(res, 200, { ok: true }) // answer Meta fast; process after
    let payload
    try { payload = JSON.parse(raw.toString()) } catch { return }
    for (const m of parseWebhook(payload)) {
      if (!wa.receive(m)) continue // Meta re-delivery
      await conversation.handle(m).catch((err) => console.error(`[webhook] ${err.stack || err.message}`))
    }
  }

  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v)
    const url = new URL(req.url, 'http://local')
    const ip = (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress
    try {
      if (url.pathname === '/webhook') return await webhook(req, res, url)

      const key = `${req.method} ${url.pathname}`
      if (url.pathname.startsWith('/sim/')) {
        const action = config.whatsappMode === 'simulator' && sim[key]
        if (!action) return send(res, 404, { error: 'route does not exist' })
        if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'origin not allowed' })
        const body = req.method === 'POST' ? await readJson(req) : {}
        return reply(res, await action({ url, body }))
      }
      if (!url.pathname.startsWith('/api/')) return await serveFile(url.pathname, res)

      const session = readSession(req)
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!session) return send(res, 401, { error: 'log in first' })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        res.write(`event: hello\ndata: ${JSON.stringify({ now: iso(clock.now()) })}\n\n`)
        const s = { res, barberId: session.barber_id }
        streams.add(s)
        req.on('close', () => streams.delete(s))
        return
      }

      let action = routes[key], param
      if (!action) {
        for (const [re, fn] of paramRoutes) {
          const m = re.exec(key)
          if (m) { action = fn; param = m[1]; break }
        }
      }
      if (!action) return send(res, 404, { error: 'route does not exist' })
      const open = key === 'GET /api/session' || key === 'POST /api/login'
      if (!open && !session) return send(res, 401, { error: 'log in first' })

      let body = {}
      if (req.method === 'POST') {
        if (!sameOrigin(req)) return send(res, 403, { error: 'origin not allowed' })
        if (session && !same(req.headers['x-csrf'], session.csrf)) return send(res, 403, { error: 'missing or invalid CSRF token' })
        body = await readJson(req)
      }
      return reply(res, await action({ req, res, url, session, body, ip }, param))
    } catch (err) {
      console.error(`[http] ${req.method} ${url.pathname}: ${err.stack || err.message}`)
      if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'internal error' })
    }
  })

  return { server, push }
}

function fail(status, message) { return { __error: true, status, message } }
function reply(res, r) { return r?.__error ? send(res, r.status, { error: r.message }) : send(res, 200, r) }

function same(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''))
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

async function readRaw(req, max) {
  let size = 0
  const parts = []
  for await (const p of req) {
    size += p.length
    if (size > max) throw Object.assign(new Error('body too large'), { status: 413 })
    parts.push(p)
  }
  return Buffer.concat(parts)
}
async function readJson(req) {
  const raw = await readRaw(req, 10_000)
  if (!raw.length) return {}
  try { return JSON.parse(raw.toString()) } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }) }
}

async function serveFile(path, res) {
  const rel = normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^(\.\.[/\\])+/, '')
  const file = join(PUBLIC, rel)
  if (!file.startsWith(PUBLIC + '/')) return send(res, 403, { error: 'forbidden' })
  try {
    const content = await readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
    res.end(content)
  } catch {
    send(res, 404, { error: 'file not found' })
  }
}
