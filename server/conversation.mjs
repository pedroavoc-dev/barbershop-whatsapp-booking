// The WhatsApp booking flow, as a small state machine:
//   menu → service → barber → day → time → (name) → confirm
// Every button/list id carries its own value (svc:2, day:2026-10-21 …), so a tap on an
// old message still means something. Anything that touches an existing booking
// re-checks that it belongs to the phone that sent it.
import { iso, local, dayLabel, whenLabel } from './time.mjs'

const TIMES_PER_PAGE = 9
const euro = (cents) => `€${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`

export function createConversation({ db, clock, config, bookings, wa }) {
  const tz = config.timeZone
  const q = {
    get: db.prepare('SELECT * FROM conversations WHERE phone = ?'),
    put: db.prepare(`INSERT INTO conversations (phone, step, data, updated_at) VALUES (?, ?, ?, ?)
                     ON CONFLICT(phone) DO UPDATE SET step = excluded.step, data = excluded.data, updated_at = excluded.updated_at`),
    customer: db.prepare('SELECT * FROM customers WHERE phone = ?'),
  }

  function load(phone) {
    const row = q.get.get(phone)
    if (!row) return { step: 'idle', data: {} }
    const stale = clock.now() - new Date(row.updated_at) > config.conversationTimeoutMin * 60000
    return stale ? { step: 'idle', data: {} } : { step: row.step, data: JSON.parse(row.data) }
  }
  const save = (phone, step, data = {}) => q.put.run(phone, step, JSON.stringify(data), iso(clock.now()))

  // ───────── prompts ─────────
  const say = (phone, text) => wa.send(phone, { kind: 'text', text })

  function menu(phone, intro) {
    save(phone, 'idle')
    const name = q.customer.get(phone)?.name
    return wa.send(phone, {
      kind: 'buttons',
      text: intro || `Hi${name ? ' ' + name : ''}! Welcome to ${config.shopName} ✂️\nWhat would you like to do?`,
      buttons: [{ id: 'menu:book', title: 'Book a cut' }, { id: 'menu:mine', title: 'My bookings' }],
    })
  }

  function askService(phone) {
    save(phone, 'service')
    return wa.send(phone, {
      kind: 'list', text: 'Which service would you like?', button: 'Services',
      rows: bookings.services().map((s) => ({ id: `svc:${s.id}`, title: s.name, description: `${s.duration_min} min · ${euro(s.price_cents)}` })),
    })
  }

  function askBarber(phone, data) {
    save(phone, 'barber', data)
    return wa.send(phone, {
      kind: 'list', text: 'Who would you like to see?', button: 'Barbers',
      rows: [{ id: 'brb:any', title: 'No preference', description: 'First available' },
        ...bookings.barbers().map((b) => ({ id: `brb:${b.id}`, title: b.name }))],
    })
  }

  function askDay(phone, data) {
    const days = bookings.availableDays(data.serviceId, data.barberId).slice(0, 10)
    if (!days.length) {
      save(phone, 'barber', data)
      return say(phone, `Sorry, no free slots in the next ${config.bookingDaysAhead} days. Reply *menu* to try another barber or service.`)
    }
    save(phone, 'day', data)
    const today = bookings.today()
    return wa.send(phone, {
      kind: 'list', text: 'Which day suits you?', button: 'Days',
      rows: days.map((d) => ({ id: `day:${d.date}`, title: d.date === today ? `Today · ${dayLabel(d.date)}` : dayLabel(d.date), description: `${d.free} free slot${d.free > 1 ? 's' : ''}` })),
    })
  }

  function askTime(phone, data, offset = 0, intro = 'What time?') {
    const all = bookings.slots(data.date, data.serviceId, data.barberId)
    if (!all.length) return askDay(phone, { ...data, date: undefined })
    save(phone, 'time', data)
    const page = all.slice(offset, offset + TIMES_PER_PAGE)
    const rows = page.map((s) => ({ id: `time:${s.start}`, title: s.time }))
    if (offset + TIMES_PER_PAGE < all.length) rows.push({ id: `more:${offset + TIMES_PER_PAGE}`, title: 'Later times…' })
    return wa.send(phone, { kind: 'list', text: `${intro} (${dayLabel(data.date)})`, button: 'Times', rows })
  }

  function askConfirm(phone, data) {
    save(phone, 'confirm', data)
    const service = bookings.service(data.serviceId)
    const barber = data.barberId ? bookings.barber(data.barberId)?.name : 'first available barber'
    return wa.send(phone, {
      kind: 'buttons',
      text: `Please confirm:\n\n✂️ ${service.name} (${service.duration_min} min, ${euro(service.price_cents)})\n💈 ${barber}\n📅 ${whenLabel(data.start, tz)}\n👤 ${data.name || q.customer.get(phone)?.name}`,
      buttons: [{ id: 'ok:yes', title: 'Confirm' }, { id: 'ok:change', title: 'Change time' }, { id: 'ok:no', title: 'Cancel' }],
    })
  }

  function showMine(phone) {
    const list = bookings.upcomingFor(phone)
    save(phone, 'idle')
    if (!list.length) {
      return wa.send(phone, { kind: 'buttons', text: "You don't have any upcoming bookings.", buttons: [{ id: 'menu:book', title: 'Book a cut' }] })
    }
    return wa.send(phone, {
      kind: 'list', text: 'Your upcoming bookings. Tap one to cancel it.', button: 'Bookings',
      rows: list.map((b) => ({ id: `cxl:${b.id}`, title: whenLabel(b.starts_at, tz), description: `${b.service_name} with ${b.barber_name}` })),
    })
  }

  function askCancel(phone, id) {
    const b = bookings.get(id)
    if (!b || b.customer_phone !== phone || b.status !== 'confirmed' || b.starts_at <= iso(clock.now())) {
      return menu(phone, "I couldn't find that booking. It may already be cancelled or finished.")
    }
    save(phone, 'cancel', { bookingId: id })
    return wa.send(phone, {
      kind: 'buttons', text: `Cancel ${b.service_name} with ${b.barber_name} on ${whenLabel(b.starts_at, tz)}?`,
      buttons: [{ id: `cxlyes:${id}`, title: 'Yes, cancel it' }, { id: `keep:${id}`, title: 'Keep it' }],
    })
  }

  // ───────── input ─────────
  async function handle({ phone, text, replyId }) {
    const state = load(phone)
    const word = String(text || '').trim().toLowerCase()

    if (!replyId) {
      if (state.step === 'name') return gotName(phone, state.data, text)
      if (['menu', 'hi', 'hello', 'hey', 'start', 'restart'].includes(word)) return menu(phone)
      if (word === 'book') return askService(phone)
      if (['cancel', 'stop', 'exit'].includes(word) && state.step !== 'idle') return menu(phone, 'No problem, nothing was booked. Anything else?')
      if (['my bookings', 'bookings', 'mine'].includes(word)) return showMine(phone)
      if (state.step === 'idle') return menu(phone)
      return say(phone, 'Please tap one of the options above, or reply *menu* to start again.')
    }

    const [action, value] = [replyId.split(':')[0], replyId.slice(replyId.indexOf(':') + 1)]
    const data = state.data

    switch (action) {
      case 'menu':
        return value === 'mine' ? showMine(phone) : askService(phone)

      case 'svc': {
        const service = bookings.service(Number(value))
        if (!service) return askService(phone)
        return askBarber(phone, { serviceId: service.id })
      }
      case 'brb': {
        if (!data.serviceId) return askService(phone)
        const barberId = value === 'any' ? null : Number(value)
        if (barberId && !bookings.barber(barberId)) return askBarber(phone, data)
        return askDay(phone, { serviceId: data.serviceId, barberId })
      }
      case 'day':
        if (!data.serviceId) return askService(phone)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return askDay(phone, data)
        return askTime(phone, { ...data, date: value })
      case 'more':
        if (!data.date) return askService(phone)
        return askTime(phone, data, Math.max(0, Number(value) || 0))
      case 'time': {
        if (!data.date || !data.serviceId) return askService(phone)
        const free = bookings.slots(data.date, data.serviceId, data.barberId).some((s) => s.start === value)
        if (!free) return askTime(phone, data, 0, 'That time was just taken. Pick another one')
        const next = { ...data, start: value }
        if (!q.customer.get(phone)?.name) {
          save(phone, 'name', next)
          return say(phone, 'Almost done! What name should we put on the booking?')
        }
        return askConfirm(phone, next)
      }
      case 'ok':
        if (state.step !== 'confirm' || !data.start) return menu(phone, 'That booking request has expired. Shall we start again?')
        if (value === 'change') return askTime(phone, data)
        if (value === 'no') return menu(phone, 'No problem, nothing was booked. Anything else?')
        return confirm(phone, data)

      case 'cxl':
      case 'rem_cxl':
        return askCancel(phone, Number(value))
      case 'cxlyes': {
        const r = bookings.cancel(Number(value), { by: 'customer', phone })
        if (r.error) return menu(phone, "I couldn't cancel that booking. It may already be cancelled or started.")
        return menu(phone, `Done, your booking on ${whenLabel(r.booking.starts_at, tz)} is cancelled. Anything else?`)
      }
      case 'keep':
        return menu(phone, 'Great, your booking stays as it is. See you then! Anything else?')
      case 'rem_ok': {
        const b = bookings.get(Number(value))
        save(phone, 'idle')
        if (!b || b.customer_phone !== phone || b.status !== 'confirmed') return menu(phone)
        return say(phone, `Thanks! See you at ${local(b.starts_at, tz).time} 💈`)
      }
      default:
        return menu(phone)
    }
  }

  function gotName(phone, data, text) {
    // printable letters only, so the name is safe to show anywhere (messages, dashboard)
    const name = String(text || '').replace(/[^\p{L}\p{M}' .-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (name.length < 2) return say(phone, 'Sorry, I didn\'t get that. What name should we put on the booking?')
    return askConfirm(phone, { ...data, name })
  }

  async function confirm(phone, data) {
    const r = bookings.book({ phone, name: data.name, serviceId: data.serviceId, barberId: data.barberId ?? null, start: data.start, source: 'whatsapp' })
    if (r.error === 'slot_taken') return askTime(phone, { ...data, start: undefined }, 0, 'Sorry, someone just took that time. Pick another one')
    if (r.error === 'too_many') return menu(phone, `You already have ${config.maxActivePerCustomer} upcoming bookings, which is our limit. Reply *my bookings* to manage them.`)
    if (r.error === 'customer_overlap') return menu(phone, 'You already have a booking at that time. Reply *my bookings* to see it.')
    if (r.error) return menu(phone, 'Sorry, something went wrong and nothing was booked. Please try again.')
    save(phone, 'idle')
    const b = r.booking
    return say(phone, `You're booked! ✅\n\n✂️ ${b.service_name}\n💈 ${b.barber_name}\n📅 ${whenLabel(b.starts_at, tz)}\n\nWe'll remind you 1 hour before. To cancel, reply *my bookings*.`)
  }

  return { handle }
}
