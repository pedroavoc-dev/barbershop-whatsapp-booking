// Smoke test: builds the whole app on a throwaway database with a fake clock and
// drives it through HTTP like a real phone and a real dashboard would.
// Every rule is checked both ways: it fires when it should (positive case) and
// stays quiet when it shouldn't (canary), so a test that can't fail fails loudly.
// Usage: npm run smoke
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { config as baseConfig } from '../server/config.mjs'
import { createClock, toUtc, local, addDays, iso } from '../server/time.mjs'
import { createApp } from '../server/app.mjs'
import { hashPassword } from '../server/http.mjs'

const dir = mkdtempSync(join(tmpdir(), 'agenda-smoke-'))
let passed = 0, failed = 0
function check(name, cond, extra = '') {
  if (cond) passed++
  else failed++
  console.log(`${cond ? '  ok ' : 'FAIL '} ${name}${!cond && extra ? `  →  ${extra}` : ''}`)
}
const section = (t) => console.log(`\n── ${t}`)

const TZ = 'Europe/Dublin'
const cfg = { ...baseConfig, whatsappMode: 'simulator', demo: false, timeZone: TZ, shopName: 'Test Shop', minNoticeMin: 30,
  bookingDaysAhead: 14, slotStepMin: 15, dailySummaryAt: '09:30', customerReminderMin: 60, barberReminderMin: 30, maxActivePerCustomer: 3 }

// Wed 21 Oct 2026, 08:00 in Dublin (IST, UTC+1)
const clock = createClock({ start: toUtc('2026-10-21', '08:00', TZ) })
const app = createApp({ config: cfg, clock, dbFile: join(dir, 'smoke.db') })
const { db, bookings, reminders } = app

// ───────── fixtures (fictional) ─────────
const BARBER_A = '353000000901', BARBER_B = '353000000902', CUST_1 = '353000000911', CUST_2 = '353000000912', CUST_3 = '353000000913'
db.prepare('INSERT INTO barbers (id, name, phone) VALUES (1, ?, ?), (2, ?, ?)').run('Alex', BARBER_A, 'Blake', BARBER_B)
db.prepare('INSERT INTO services (id, name, duration_min, price_cents) VALUES (1, ?, 30, 1800), (2, ?, 45, 2200)').run('Classic cut', 'Skin fade')
for (let wd = 1; wd <= 6; wd++) db.prepare('INSERT INTO working_hours VALUES (1, ?, ?, ?)').run(wd, '09:00', '17:00')
for (const wd of [1, 2, 4, 5, 6]) db.prepare('INSERT INTO working_hours VALUES (2, ?, ?, ?)').run(wd, '09:00', '17:00') // Blake is off on Wednesdays
db.prepare('INSERT INTO users (login, password_hash, barber_id) VALUES (?, ?, NULL), (?, ?, 2)').run('owner', await hashPassword('owner-pass'), 'blake', await hashPassword('blake-pass'))

await new Promise((r) => app.http.server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${app.http.server.address().port}`

async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }
}
const out = (phone) => db.prepare(`SELECT * FROM messages WHERE phone = ? AND direction = 'out' ORDER BY id`).all(phone).map((m) => ({ ...m, body: JSON.parse(m.body) }))
const last = (phone) => out(phone).at(-1)
const tap = (phone, replyId, text = '') => call('POST', '/sim/send', { phone, replyId, text: text || replyId })
const say = (phone, text) => call('POST', '/sim/send', { phone, text })
const rowsOf = (m) => m?.body?.rows?.map((r) => r.id) || []
const count = (sql, ...a) => db.prepare(sql).get(...a).n

try {
  // ═════════ 1. time zone ═════════
  section('time zone (Dublin summer time ends Sun 25 Oct 2026)')
  check('10:00 local on 24 Oct = 09:00 UTC', iso(toUtc('2026-10-24', '10:00', TZ)) === '2026-10-24T09:00:00.000Z', iso(toUtc('2026-10-24', '10:00', TZ)))
  check('10:00 local on 26 Oct = 10:00 UTC', iso(toUtc('2026-10-26', '10:00', TZ)) === '2026-10-26T10:00:00.000Z', iso(toUtc('2026-10-26', '10:00', TZ)))
  check('round trip local(toUtc()) keeps the wall time', local(toUtc('2026-10-25', '09:15', TZ), TZ).time === '09:15')

  // ═════════ 2. booking over WhatsApp ═════════
  section('customer books over WhatsApp (simulator → HTTP → conversation)')
  await say(CUST_1, 'hi')
  check('greeting shows the menu buttons', last(CUST_1)?.body?.buttons?.some((b) => b.id === 'menu:book'), JSON.stringify(last(CUST_1)?.body))
  await tap(CUST_1, 'menu:book')
  check('service list offered', rowsOf(last(CUST_1)).includes('svc:1'))
  await tap(CUST_1, 'svc:1')
  check('barber list has "no preference"', rowsOf(last(CUST_1)).includes('brb:any'))
  await tap(CUST_1, 'brb:1')
  check('day list starts today', rowsOf(last(CUST_1))[0] === 'day:2026-10-21', rowsOf(last(CUST_1))[0])
  await tap(CUST_1, 'day:2026-10-21')
  const times = rowsOf(last(CUST_1))
  const first = toUtc('2026-10-21', '09:00', TZ)
  check('first free time respects opening (09:00) and 30-min notice', times[0] === `time:${iso(first)}`, times[0])
  check('long day is paged with "Later times…"', times.includes('more:9'), times.join(','))
  const SLOT = iso(toUtc('2026-10-21', '11:00', TZ))
  await tap(CUST_1, 'more:9')
  check('page 2 continues where page 1 stopped', rowsOf(last(CUST_1))[0] === `time:${iso(toUtc('2026-10-21', '11:15', TZ))}`, rowsOf(last(CUST_1))[0])
  await tap(CUST_1, `time:${SLOT}`)
  check('new customer is asked for a name', /name/i.test(last(CUST_1)?.body?.text || ''))
  await say(CUST_1, 'Liam <script>alert(1)</script>')
  check('confirmation shows sanitised name', /Liam scriptalert/.test(last(CUST_1)?.body?.text || '') && !/</.test(last(CUST_1)?.body?.text), last(CUST_1)?.body?.text)
  check('no booking before confirming', count('SELECT COUNT(*) AS n FROM bookings') === 0)
  await tap(CUST_1, 'ok:yes')
  const b1 = db.prepare('SELECT * FROM bookings WHERE starts_at = ?').get(SLOT)
  check('booking created after Confirm', b1?.status === 'confirmed' && b1.barber_id === 1)
  check('customer gets "You\'re booked"', /booked/i.test(last(CUST_1)?.body?.text || ''))
  await new Promise((r) => setTimeout(r, 30))
  const toBarber = out(BARBER_A)
  check('barber notified instantly of the new booking', toBarber.some((m) => /New booking/.test(m.body.text)), JSON.stringify(toBarber.map((m) => m.body.text)))
  check('barber never wrote to us → notification goes as a template (24h rule)', toBarber.at(-1)?.kind === 'template' && toBarber.at(-1).body.name === 'barber_new_booking')
  check('canary: the other barber got nothing', out(BARBER_B).length === 0)

  // ═════════ 3. double booking ═════════
  section('the same slot can never be sold twice')
  await say(CUST_2, 'book')
  await tap(CUST_2, 'svc:1'); await tap(CUST_2, 'brb:1'); await tap(CUST_2, 'day:2026-10-21'); await tap(CUST_2, 'more:9')
  check('taken slot no longer offered to the next customer', !rowsOf(last(CUST_2)).includes(`time:${SLOT}`))
  await tap(CUST_2, `time:${SLOT}`) // an old list / forged tap
  check('tapping the taken slot anyway is refused', /taken/i.test(last(CUST_2)?.body?.text || ''), last(CUST_2)?.body?.text)
  const direct = bookings.book({ phone: CUST_2, name: 'Sophie', serviceId: 1, barberId: 1, start: iso(toUtc('2026-10-21', '11:15', TZ)), source: 'whatsapp' })
  check('overlapping start (11:15 inside 11:00–11:30) refused', direct.error === 'slot_taken', JSON.stringify(direct))
  const ok2 = bookings.book({ phone: CUST_2, name: 'Sophie', serviceId: 1, barberId: 1, start: iso(toUtc('2026-10-21', '11:30', TZ)), source: 'whatsapp' })
  check('canary: back-to-back 11:30 accepted', !!ok2.booking, JSON.stringify(ok2))
  check('exactly 2 bookings for Alex', count(`SELECT COUNT(*) AS n FROM bookings WHERE barber_id = 1 AND status = 'confirmed'`) === 2)

  // ═════════ 4. availability rules ═════════
  section('availability')
  check('Blake is off on Wednesday: no slots', bookings.slots('2026-10-21', 1, 2).length === 0)
  check('canary: Blake has slots on Thursday', bookings.slots('2026-10-22', 1, 2).length > 0)
  db.prepare('INSERT INTO time_off (barber_id, starts_at, ends_at, reason) VALUES (1, ?, ?, ?)').run(iso(toUtc('2026-10-22', '13:00', TZ)), iso(toUtc('2026-10-22', '14:00', TZ)), 'lunch')
  const thu = bookings.slots('2026-10-22', 1, 1).map((s) => s.time)
  check('lunch block hides 12:45–13:45 starts', !thu.includes('13:00') && !thu.includes('12:45') && !thu.includes('13:45'), thu.join(' '))
  check('canary: 12:30 and 14:00 still offered', thu.includes('12:30') && thu.includes('14:00'))
  check('last slot ends at closing (16:30 for 30 min)', thu.at(-1) === '16:30', thu.at(-1))
  check('nothing beyond 14 days ahead', bookings.book({ phone: CUST_3, name: 'Jack', serviceId: 1, barberId: 1, start: iso(toUtc(addDays('2026-10-21', 15), '10:00', TZ)), source: 'whatsapp' }).error === 'too_far')
  const anyone = bookings.slots('2026-10-22', 1, null).find((s) => s.time === '10:00')
  check('"no preference" merges both barbers', anyone?.barberIds?.length === 2)

  // ═════════ 5. cancelling: only your own booking ═════════
  section('cancelling')
  await say(CUST_2, 'menu')
  await tap(CUST_2, `cxlyes:${b1.id}`) // Sophie forges a cancel for Liam's booking
  check("another customer can't cancel Liam's booking (IDOR)", bookings.get(b1.id).status === 'confirmed')
  await tap(CUST_2, `cxl:${b1.id}`)
  check('…nor even see its details', !/Liam|Classic cut with/.test(last(CUST_2)?.body?.text || ''), last(CUST_2)?.body?.text)
  await tap(CUST_2, 'menu:mine')
  const mine = rowsOf(last(CUST_2))
  check('"My bookings" lists only her own', mine.length === 1 && mine[0] === `cxl:${ok2.booking.id}`, mine.join(','))
  const beforeBarber = out(BARBER_A).length
  await tap(CUST_2, `cxl:${ok2.booking.id}`)
  await tap(CUST_2, `cxlyes:${ok2.booking.id}`)
  await new Promise((r) => setTimeout(r, 30))
  check('canary: she cancels her own', bookings.get(ok2.booking.id).status === 'cancelled')
  check('barber told about the cancellation', out(BARBER_A).length === beforeBarber + 1 && /Cancelled/.test(last(BARBER_A).body.text))

  // ═════════ 6. reminders ═════════
  section('reminders (Liam 11:00 with Alex)')
  clock.set(toUtc('2026-10-21', '09:59', TZ)); await reminders.tick()
  check('09:59: no customer reminder yet (61 min before)', !out(CUST_1).some((m) => /reminder/i.test(m.body.text)))
  clock.set(toUtc('2026-10-21', '10:00', TZ)); await reminders.tick()
  const rem = out(CUST_1).filter((m) => /reminder/i.test(m.body.text))
  check('10:00: customer reminder sent (60 min before)', rem.length === 1)
  check('customer wrote <24h ago → reminder is interactive, not a template', rem[0]?.kind === 'buttons', rem[0]?.kind)
  check('reminder has "I need to cancel" button for THIS booking', rem[0]?.body?.buttons?.some((b) => b.id === `rem_cxl:${b1.id}`))
  await reminders.tick(); await reminders.tick()
  check('repeated ticks never send it twice', out(CUST_1).filter((m) => /reminder/i.test(m.body.text)).length === 1)
  check('canary: barber 30-min reminder not yet at 10:00', !out(BARBER_A).some((m) => /In 30 min/.test(m.body.text || m.body.params?.join(' '))))
  clock.set(toUtc('2026-10-21', '10:30', TZ)); await reminders.tick(); await reminders.tick()
  const b30 = out(BARBER_A).filter((m) => m.body.name === 'barber_upcoming')
  check('10:30: barber gets the 30-min reminder, once', b30.length === 1, JSON.stringify(b30.map((m) => m.body)))
  check('template parameters have no line breaks (Meta rejects them)', out(BARBER_A).filter((m) => m.kind === 'template').every((m) => m.body.params.every((p) => !/[\n\t]/.test(p))))
  check('cancelled 11:30 booking: no reminders at all', !db.prepare(`SELECT 1 FROM reminders WHERE booking_id = ?`).get(ok2.booking.id))

  // booking made inside the hour: confirmation only, no extra reminder
  const late = bookings.book({ phone: CUST_3, name: 'Jack', serviceId: 1, barberId: 1, start: iso(toUtc('2026-10-21', '11:45', TZ)), source: 'dashboard' })
  check('dashboard booking 75 min ahead accepted', !!late.booking, JSON.stringify(late))
  clock.set(toUtc('2026-10-21', '11:00', TZ)); await reminders.tick()
  check('booked 75 min before → reminder still due 60 min before', out(CUST_3).some((m) => m.body.name === 'booking_reminder'))
  clock.set(toUtc('2026-10-23', '14:00', TZ))
  const soon = bookings.book({ phone: CUST_2, name: 'Sophie', serviceId: 1, barberId: 1, start: iso(toUtc('2026-10-23', '14:45', TZ)), source: 'whatsapp' })
  await reminders.tick()
  check('booked 45 min ahead → no "1 hour" reminder (she just got the confirmation)', !!soon.booking && !db.prepare(`SELECT 1 FROM reminders WHERE key = ?`).get(`customer_1h:${soon.booking.id}`))
  clock.set(toUtc('2026-10-23', '14:15', TZ)); await reminders.tick()
  check('…but the barber still gets the 30-min reminder', !!db.prepare(`SELECT 1 FROM reminders WHERE key = ? AND ok = 1`).get(`barber_30m:${soon.booking.id}`))

  section('daily summary (before 10:00)')
  clock.set(toUtc('2026-10-22', '09:29', TZ)); await reminders.tick()
  const thuSummary = (phone) => out(phone).filter((m) => m.body.name === 'barber_daily_summary' && m.body.params[1] === 'Thu 22 Oct')
  check('Wednesday summary went out late (10:00) because the server only "woke up" then', !!db.prepare(`SELECT 1 FROM reminders WHERE key = 'barber_day:1:2026-10-21' AND ok = 1`).get())
  check('09:29: no Thursday summary yet', thuSummary(BARBER_A).length === 0)
  bookings.book({ phone: CUST_1, name: 'Liam', serviceId: 2, barberId: 2, start: iso(toUtc('2026-10-22', '15:00', TZ)), source: 'whatsapp' })
  clock.set(toUtc('2026-10-22', '09:30', TZ)); await reminders.tick(); await reminders.tick()
  const sumA = thuSummary(BARBER_A), sumB = thuSummary(BARBER_B)
  check('09:30: Alex gets exactly one summary', sumA.length === 1)
  check('Blake gets exactly one, listing his 15:00 booking', sumB.length === 1 && /15:00 Skin fade/.test(sumB[0].body.params[3]), JSON.stringify(sumB[0]?.body))
  check('canary: summary is per day — none on Wednesday for Blake (day off)', !db.prepare(`SELECT 1 FROM reminders WHERE key = 'barber_day:2:2026-10-21'`).get())

  // ═════════ 7. dashboard API ═════════
  section('dashboard API: login, CSRF, who sees what')
  check('no session → 401', (await call('GET', '/api/bookings?from=2026-10-22')).status === 401)
  const bad = await call('POST', '/api/login', { login: 'owner', password: 'nope' })
  check('wrong password → 401', bad.status === 401)
  const login = async (l, p) => {
    const r = await call('POST', '/api/login', { login: l, password: p })
    return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.body.csrf }
  }
  const owner = await login('owner', 'owner-pass'), blake = await login('blake', 'blake-pass')
  const ownerList = await call('GET', '/api/bookings?from=2026-10-21&days=2', undefined, { cookie: owner.cookie })
  const blakeList = await call('GET', '/api/bookings?from=2026-10-21&days=2', undefined, { cookie: blake.cookie })
  check('owner sees both barbers', new Set(ownerList.body.bookings.map((b) => b.barber_id)).size === 2)
  check('barber sees only his own', blakeList.body.bookings.length > 0 && blakeList.body.bookings.every((b) => b.barber_id === 2))
  const alexBooking = ownerList.body.bookings.find((b) => b.barber_id === 1 && b.status === 'confirmed' && b.starts_at > iso(clock.now()))
    || bookings.book({ phone: CUST_2, name: 'Sophie', serviceId: 1, barberId: 1, start: iso(toUtc('2026-10-22', '10:00', TZ)), source: 'whatsapp' }).booking
  const noCsrf = await call('POST', `/api/bookings/${alexBooking.id}/cancel`, {}, { cookie: owner.cookie })
  check('POST without CSRF token → 403', noCsrf.status === 403)
  const cross = await call('POST', `/api/bookings/${alexBooking.id}/cancel`, {}, { cookie: owner.cookie, 'x-csrf': owner.csrf, origin: 'https://evil.example' })
  check('POST from another site → 403', cross.status === 403)
  const blakeTries = await call('POST', `/api/bookings/${alexBooking.id}/cancel`, {}, { cookie: blake.cookie, 'x-csrf': blake.csrf })
  check("barber can't cancel a colleague's booking", blakeTries.status === 404 && bookings.get(alexBooking.id).status === 'confirmed')
  const custMsgs = out(alexBooking.customer_phone).length
  const ownerCancels = await call('POST', `/api/bookings/${alexBooking.id}/cancel`, {}, { cookie: owner.cookie, 'x-csrf': owner.csrf })
  await new Promise((r) => setTimeout(r, 30))
  check('canary: owner can cancel it', ownerCancels.status === 200 && bookings.get(alexBooking.id).status === 'cancelled')
  check('customer told the shop cancelled', out(alexBooking.customer_phone).length === custMsgs + 1 && /cancel/i.test(JSON.stringify(last(alexBooking.customer_phone).body)))
  const walkIn = await call('POST', '/api/bookings', { phone: '+353 000 000 914', name: 'Emma', serviceId: 1, barberId: 1, start: iso(toUtc('2026-10-22', '16:00', TZ)) }, { cookie: owner.cookie, 'x-csrf': owner.csrf })
  check('dashboard booking (phone call) created', walkIn.status === 200 && walkIn.body.booking.source === 'dashboard', JSON.stringify(walkIn.body))
  check('…and the customer gets a WhatsApp confirmation (template, never messaged us)', last('353000000914')?.body?.name === 'booking_confirmed')
  const early = await call('POST', `/api/bookings/${walkIn.body.booking?.id}/status`, { status: 'done' }, { cookie: owner.cookie, 'x-csrf': owner.csrf })
  check("can't mark a future booking as done", early.status === 409)
  const msgs = await call('GET', '/api/messages', undefined, { cookie: owner.cookie })
  check('message log masks phone numbers', msgs.body.messages.every((m) => /^…\d{4}$/.test(m.phone)))
  check('barber cannot read the message log', (await call('GET', '/api/messages', undefined, { cookie: blake.cookie })).status === 403)
  check('demo clock route is off outside demo mode', (await call('POST', '/api/demo/clock', { advanceMin: 60 }, { cookie: owner.cookie, 'x-csrf': owner.csrf })).status === 404)
  check('webhook is off in simulator mode', (await call('POST', '/webhook', {})).status === 404)

  // ═════════ 8. Meta webhook (cloud mode, fake Graph API) ═════════
  section('Meta webhook: signature, retries, Cloud API payloads')
  const sent = []
  const fakeFetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' + sent.length }] }), { status: 200 }) }
  const cloudCfg = { ...cfg, whatsappMode: 'cloud', wa: { token: 't', phoneNumberId: '123', appSecret: 'shh-secret', verifyToken: 'verify-me', apiVersion: 'v21.0', templateLang: 'en' } }
  const cloud = createApp({ config: cloudCfg, clock, dbFile: join(dir, 'cloud.db'), fetchImpl: fakeFetch })
  cloud.db.prepare('INSERT INTO barbers (id, name, phone) VALUES (1, ?, ?)').run('Alex', BARBER_A)
  cloud.db.prepare('INSERT INTO services (id, name, duration_min, price_cents) VALUES (1, ?, 30, 1800)').run('Classic cut')
  await new Promise((r) => cloud.http.server.listen(0, '127.0.0.1', r))
  const CB = `http://127.0.0.1:${cloud.http.server.address().port}`
  const hook = (payload, secret = 'shh-secret') => {
    const raw = JSON.stringify(payload)
    return fetch(CB + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') }, body: raw })
  }
  const msg = (id, extra) => ({ entry: [{ changes: [{ value: { messages: [{ from: CUST_1, id, ...extra }] } }] }] })
  const v1 = await fetch(`${CB}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`)
  check('subscription handshake echoes the challenge', v1.status === 200 && (await v1.text()) === '42')
  check('wrong verify token refused', (await fetch(`${CB}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)).status === 403)
  const forged = await hook(msg('wamid.1', { type: 'text', text: { body: 'hi' } }), 'wrong-secret')
  check('forged signature → 401, nothing stored', forged.status === 401 && cloud.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 0)
  const real = await hook(msg('wamid.1', { type: 'text', text: { body: 'hi' } }))
  await new Promise((r) => setTimeout(r, 50))
  check('valid signature → 200 and the bot answers via Graph API', real.status === 200 && sent.length === 1 && sent[0].body.type === 'interactive', JSON.stringify(sent[0]?.body))
  check('Graph API URL uses the phone number id', sent[0]?.url === 'https://graph.facebook.com/v21.0/123/messages')
  await hook(msg('wamid.1', { type: 'text', text: { body: 'hi' } }))
  await new Promise((r) => setTimeout(r, 50))
  check('Meta re-delivering the same message is ignored', sent.length === 1)
  await hook(msg('wamid.2', { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'menu:book', title: 'Book a cut' } } }))
  await new Promise((r) => setTimeout(r, 50))
  check('button replies are understood (service list sent)', sent.at(-1)?.body?.interactive?.type === 'list' && sent.at(-1).body.interactive.action.sections[0].rows[0].id === 'svc:1')
  await cloud.wa.send(BARBER_A, { kind: 'text', text: 'x' }, { name: 'barber_upcoming', params: ['30', '11:00', 'Classic cut', 'Liam'] })
  const tpl = sent.at(-1)?.body
  check('outside the 24h window a real template payload is sent', tpl?.type === 'template' && tpl.template.name === 'barber_upcoming' && tpl.template.components[0].parameters.length === 4, JSON.stringify(tpl))
  const noTpl = await cloud.wa.send(BARBER_A, { kind: 'text', text: 'free text' })
  check('canary: free text outside the window is refused, not sent', !noTpl.ok && sent.filter((s) => s.body.text?.body === 'free text').length === 0)
  cloud.http.server.close(); cloud.db.close()
} catch (err) {
  failed++
  console.error('\nCRASH', err)
} finally {
  app.http.server.close()
  app.db.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
