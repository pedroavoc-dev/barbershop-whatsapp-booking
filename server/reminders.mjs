// Reminders and live notifications.
//  - barber: daily summary before 10:00, and 30 min before each booking
//  - customer: 1 hour before the booking
//  - barber: instantly on every new or cancelled booking
// Each reminder has a unique key in the `reminders` table: overlapping ticks, restarts
// and a fast-forwarded demo clock don't repeat a reminder that was sent. Delivery is
// at-least-once: if the process dies between Meta accepting a message and us recording
// it, that one reminder can go out twice. A failed send is retried with backoff.
import { iso, local, addMin, addDays, whenLabel, dayLabel } from './time.mjs'

const RETRY_AFTER_MIN = [1, 2, 4, 8] // wait after attempt 1, 2, 3, 4; then give up (≈15 min of Meta outage)
const MAX_ATTEMPTS = RETRY_AFTER_MIN.length + 1
const TEMPLATE_PARAM_MAX = 1000 // Meta's limit per parameter is 1024 characters

export function createReminders({ db, clock, config, bookings, wa, bus }) {
  const tz = config.timeZone
  const q = {
    due: db.prepare(`SELECT id, created_at, starts_at FROM bookings WHERE status = 'confirmed' AND starts_at > ? AND starts_at <= ? ORDER BY starts_at`),
    reminder: db.prepare('SELECT * FROM reminders WHERE key = ?'),
    claim: db.prepare(`INSERT INTO reminders (key, booking_id, sent_at, ok, attempts) VALUES (?, ?, ?, 0, 1)
                       ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1, sent_at = excluded.sent_at`),
    result: db.prepare('UPDATE reminders SET ok = ? WHERE key = ?'),
    workingBarbers: db.prepare(`SELECT DISTINCT b.id, b.name, b.phone FROM barbers b JOIN working_hours h ON h.barber_id = b.id
                                WHERE b.active = 1 AND h.weekday = ? ORDER BY b.id`),
  }

  // send once per key; a failed send is retried on later ticks with growing waits
  async function once(key, bookingId, sendFn) {
    const prev = q.reminder.get(key)
    if (prev && (prev.ok || prev.attempts >= MAX_ATTEMPTS)) return null
    if (prev && clock.now() - new Date(prev.sent_at) < RETRY_AFTER_MIN[prev.attempts - 1] * 60000) return null
    q.claim.run(key, bookingId, iso(clock.now()))
    const r = await sendFn()
    q.result.run(r.ok ? 1 : 0, key)
    bus.emit('reminder', { key, ok: r.ok })
    return r
  }

  async function customerReminders(now) {
    const lead = config.customerReminderMin
    for (const row of q.due.all(iso(now), iso(addMin(now, lead)))) {
      // booked inside the reminder window? They just got the confirmation; don't nag.
      if (row.created_at > iso(addMin(row.starts_at, -lead))) continue
      const b = bookings.get(row.id)
      await once(`customer_1h:${b.id}`, b.id, () => wa.send(b.customer_phone, {
        kind: 'buttons',
        text: `Hi ${b.customer_name || 'there'}, a reminder: ${b.service_name} with ${b.barber_name} today at ${local(b.starts_at, tz).time} at ${config.shopName}.`,
        buttons: [{ id: `rem_ok:${b.id}`, title: "I'll be there" }, { id: `rem_cxl:${b.id}`, title: 'I need to cancel' }],
      }, {
        name: 'booking_reminder',
        params: [b.customer_name || 'there', b.service_name, b.barber_name, local(b.starts_at, tz).time],
        buttons: [{ id: `rem_ok:${b.id}` }, { id: `rem_cxl:${b.id}` }],
      }))
    }
  }

  async function barberReminders(now) {
    const lead = config.barberReminderMin
    for (const row of q.due.all(iso(now), iso(addMin(now, lead)))) {
      if (row.created_at > iso(addMin(row.starts_at, -lead))) continue // the "new booking" alert already covered it
      const b = bookings.get(row.id)
      await once(`barber_30m:${b.id}`, b.id, () => wa.send(b.barber_phone, {
        kind: 'text',
        text: `⏰ In ${lead} min (${local(b.starts_at, tz).time}): ${b.service_name} for ${b.customer_name || 'a customer'}.`,
      }, { name: 'barber_upcoming', params: [String(lead), local(b.starts_at, tz).time, b.service_name, b.customer_name || 'a customer'] }))
    }
  }

  async function dailySummaries(now) {
    const l = local(now, tz)
    // from the configured time (before 10:00) until noon: a server that was down at 09:30
    // still delivers the summary late rather than never
    if (l.time < config.dailySummaryAt || l.time >= '12:00') return
    for (const barber of q.workingBarbers.all(l.weekday)) {
      const list = bookings.between(l.date, addDays(l.date, 1), barber.id).filter((b) => b.status === 'confirmed')
      const lines = list.map((b) => `${local(b.starts_at, tz).time} ${b.service_name} · ${b.customer_name || 'customer'}`)
      const text = list.length
        ? `☀️ Good morning ${barber.name}! ${dayLabel(l.date)}: ${list.length} booking${list.length > 1 ? 's' : ''}.\n\n${lines.join('\n')}`
        : `☀️ Good morning ${barber.name}! ${dayLabel(l.date)}: no bookings yet. New ones will come straight to you.`
      // template parameters can't contain line breaks, so the list is joined with " | "
      await once(`barber_day:${barber.id}:${l.date}`, null, () => wa.send(barber.phone, { kind: 'text', text },
        { name: 'barber_daily_summary', params: [barber.name, dayLabel(l.date), String(list.length), fitParam(lines)] }))
    }
  }

  // a busy day can exceed Meta's parameter limit: keep whole lines and point to the dashboard
  function fitParam(lines) {
    if (!lines.length) return 'none yet'
    let out = ''
    for (let i = 0; i < lines.length; i++) {
      const rest = `… and ${lines.length - i} more on the dashboard`
      const next = out ? `${out} | ${lines[i]}` : lines[i]
      if (next.length + rest.length + 3 > TEMPLATE_PARAM_MAX) return `${out} | ${rest}`
      out = next
    }
    return out
  }

  let running = false
  async function tick() {
    if (running) return
    running = true
    const now = clock.now()
    // each routine on its own: a crash in one must not skip the others
    for (const routine of [dailySummaries, barberReminders, customerReminders]) {
      try {
        await routine(now)
      } catch (err) {
        console.error(`[reminders] ${routine.name}: ${err.stack || err.message}`)
      }
    }
    running = false
  }

  // ───────── live notifications ─────────
  const safe = (fn) => (b) => Promise.resolve().then(() => fn(b)).catch((err) => console.error(`[notify] ${err.message}`))
  const isFuture = (b) => b.starts_at > iso(clock.now())

  bus.on('booking:created', safe(async (b) => {
    const when = whenLabel(b.starts_at, tz)
    await wa.send(b.barber_phone, { kind: 'text', text: `📅 New booking: ${b.customer_name || 'a customer'}, ${b.service_name}, ${when}.` },
      { name: 'barber_new_booking', params: [b.customer_name || 'a customer', b.service_name, when] })
    // booked by the shop (phone call, walk-in): the customer gets the confirmation on WhatsApp
    if (b.source === 'dashboard') {
      await wa.send(b.customer_phone, { kind: 'text', text: `You're booked at ${config.shopName} ✅\n${b.service_name} with ${b.barber_name}, ${when}.\nReply *my bookings* to manage it.` },
        { name: 'booking_confirmed', params: [b.service_name, b.barber_name, when] })
    }
  }))

  bus.on('booking:cancelled', safe(async (b) => {
    if (!isFuture(b)) return
    const when = whenLabel(b.starts_at, tz)
    await wa.send(b.barber_phone, { kind: 'text', text: `❌ Cancelled by ${b.cancelled_by === 'customer' ? 'the customer' : 'the shop'}: ${b.customer_name || 'customer'}, ${b.service_name}, ${when}. The slot is free again.` },
      { name: 'barber_cancelled', params: [b.customer_name || 'customer', b.service_name, when] })
    if (b.cancelled_by !== 'customer') {
      await wa.send(b.customer_phone, { kind: 'text', text: `Sorry, ${config.shopName} had to cancel your ${b.service_name} on ${when}. Reply *book* to pick a new time.` },
        { name: 'booking_cancelled_by_shop', params: [b.service_name, when] })
    }
  }))

  return { tick }
}
