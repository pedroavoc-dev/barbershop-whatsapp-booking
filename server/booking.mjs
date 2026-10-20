// Booking rules: which slots are free, creating and cancelling bookings.
// Everything that writes runs inside one transaction, so a slot can't be sold twice.
import { tx } from './db.mjs'
import { local, toUtc, addDays, addMin, iso } from './time.mjs'

export function createBookings({ db, clock, config, bus }) {
  const tz = config.timeZone

  const q = {
    services: db.prepare('SELECT id, name, duration_min, price_cents FROM services WHERE active = 1 ORDER BY id'),
    service: db.prepare('SELECT * FROM services WHERE id = ? AND active = 1'),
    barbers: db.prepare('SELECT id, name FROM barbers WHERE active = 1 ORDER BY id'),
    barber: db.prepare('SELECT * FROM barbers WHERE id = ? AND active = 1'),
    hours: db.prepare('SELECT opens, closes FROM working_hours WHERE barber_id = ? AND weekday = ? ORDER BY opens'),
    busy: db.prepare(`SELECT starts_at, ends_at FROM bookings
                      WHERE barber_id = ? AND status = 'confirmed' AND starts_at < ? AND ends_at > ?
                      UNION ALL
                      SELECT starts_at, ends_at FROM time_off WHERE barber_id = ? AND starts_at < ? AND ends_at > ?`),
    customerByPhone: db.prepare('SELECT * FROM customers WHERE phone = ?'),
    insertCustomer: db.prepare('INSERT INTO customers (phone, name, created_at) VALUES (?, ?, ?)'),
    renameCustomer: db.prepare('UPDATE customers SET name = ? WHERE id = ?'),
    activeCount: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ? AND status = 'confirmed' AND starts_at > ?`),
    customerOverlap: db.prepare(`SELECT 1 FROM bookings WHERE customer_id = ? AND status = 'confirmed' AND starts_at < ? AND ends_at > ?`),
    insertBooking: db.prepare(`INSERT INTO bookings (customer_id, barber_id, service_id, starts_at, ends_at, source, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?)`),
    get: db.prepare(`SELECT b.*, c.name AS customer_name, c.phone AS customer_phone, br.name AS barber_name, br.phone AS barber_phone,
                            s.name AS service_name, s.duration_min, s.price_cents
                     FROM bookings b JOIN customers c ON c.id = b.customer_id JOIN barbers br ON br.id = b.barber_id
                     JOIN services s ON s.id = b.service_id WHERE b.id = ?`),
    cancel: db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ? AND status = 'confirmed'`),
    setStatus: db.prepare(`UPDATE bookings SET status = ? WHERE id = ? AND status IN ('confirmed', 'done', 'no_show')`),
    upcomingFor: db.prepare(`SELECT b.id FROM bookings b JOIN customers c ON c.id = b.customer_id
                             WHERE c.phone = ? AND b.status = 'confirmed' AND b.starts_at > ? ORDER BY b.starts_at`),
    range: db.prepare(`SELECT b.id FROM bookings b WHERE b.starts_at >= ? AND b.starts_at < ? AND (? IS NULL OR b.barber_id = ?)
                       ORDER BY b.starts_at, b.barber_id`),
  }

  const today = () => local(clock.now(), tz).date

  // free start times for one barber on one local date
  function barberSlots(barberId, date, durationMin) {
    const out = []
    const earliest = addMin(clock.now(), config.minNoticeMin)
    const dayStart = iso(toUtc(date, '00:00', tz)), dayEnd = iso(toUtc(addDays(date, 1), '00:00', tz))
    const busy = q.busy.all(barberId, dayEnd, dayStart, barberId, dayEnd, dayStart)
    const weekday = local(toUtc(date, '12:00', tz), tz).weekday
    for (const { opens, closes } of q.hours.all(barberId, weekday)) {
      const close = toUtc(date, closes, tz)
      for (let t = toUtc(date, opens, tz); addMin(t, durationMin) <= close; t = addMin(t, config.slotStepMin)) {
        const s = iso(t), e = iso(addMin(t, durationMin))
        if (t < earliest) continue
        if (busy.some((b) => b.starts_at < e && b.ends_at > s)) continue
        out.push(s)
      }
    }
    return out
  }

  // barberId null = "anyone": merge every barber's slots
  function slots(date, serviceId, barberId = null) {
    const service = q.service.get(serviceId)
    if (!service) return []
    const barbers = barberId ? [q.barber.get(barberId)].filter(Boolean) : q.barbers.all()
    const byStart = new Map()
    for (const b of barbers) {
      for (const s of barberSlots(b.id, date, service.duration_min)) {
        if (!byStart.has(s)) byStart.set(s, [])
        byStart.get(s).push(b.id)
      }
    }
    return [...byStart.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([start, barberIds]) => ({ start, time: local(start, tz).time, barberIds }))
  }

  function availableDays(serviceId, barberId = null) {
    const days = []
    for (let i = 0; i <= config.bookingDaysAhead; i++) {
      const date = addDays(today(), i)
      const n = slots(date, serviceId, barberId).length
      if (n) days.push({ date, free: n })
    }
    return days
  }

  // Creates the booking or returns { error }. Re-checks everything: the customer may
  // have looked at the slot minutes ago and someone else took it since.
  function book({ phone, name, serviceId, barberId = null, start, source }) {
    const service = q.service.get(serviceId)
    if (!service) return { error: 'service_unavailable' }
    const startD = new Date(start)
    if (Number.isNaN(startD.getTime())) return { error: 'bad_time' }
    const s = iso(startD), e = iso(addMin(startD, service.duration_min))
    const date = local(startD, tz).date
    if (date > addDays(today(), config.bookingDaysAhead)) return { error: 'too_far' }

    const result = tx(db, () => {
      let customer = q.customerByPhone.get(phone)
      if (!customer) {
        q.insertCustomer.run(phone, name || null, iso(clock.now()))
        customer = q.customerByPhone.get(phone)
      } else if (name && name !== customer.name) {
        q.renameCustomer.run(name, customer.id)
      }
      if (q.activeCount.get(customer.id, iso(clock.now())).n >= config.maxActivePerCustomer) return { error: 'too_many' }
      if (q.customerOverlap.get(customer.id, e, s)) return { error: 'customer_overlap' }

      // pick the barber inside the transaction, from slots computed right now
      const free = slots(date, serviceId, barberId).find((x) => x.start === s)
      if (!free) return { error: 'slot_taken' }
      const chosen = barberId ?? leastBusy(free.barberIds, date)
      const r = q.insertBooking.run(customer.id, chosen, serviceId, s, e, source, iso(clock.now()))
      return { id: Number(r.lastInsertRowid) }
    })
    if (result.error) return result
    const booking = get(result.id)
    bus.emit('booking:created', booking)
    return { booking }
  }

  function leastBusy(barberIds, date) {
    const from = iso(toUtc(date, '00:00', tz)), to = iso(toUtc(addDays(date, 1), '00:00', tz))
    const count = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE barber_id = ? AND status = 'confirmed' AND starts_at >= ? AND starts_at < ?`)
    return barberIds.map((id) => ({ id, n: count.get(id, from, to).n })).sort((a, b) => a.n - b.n || a.id - b.id)[0].id
  }

  // phone given = the customer is cancelling over WhatsApp: it must be THEIR booking
  function cancel(id, { by, phone = null }) {
    const b = get(id)
    if (!b || (phone && b.customer_phone !== phone)) return { error: 'not_found' }
    if (b.status !== 'confirmed') return { error: 'not_active' }
    if (phone && b.starts_at <= iso(clock.now())) return { error: 'already_started' }
    if (!q.cancel.run(iso(clock.now()), by, id).changes) return { error: 'not_active' }
    const updated = get(id)
    bus.emit('booking:cancelled', updated)
    return { booking: updated }
  }

  function setStatus(id, status) {
    if (!['done', 'no_show', 'confirmed'].includes(status)) return { error: 'bad_status' }
    const b = get(id)
    if (!b) return { error: 'not_found' }
    if (status !== 'confirmed' && b.starts_at > iso(clock.now())) return { error: 'not_started' }
    if (!q.setStatus.run(status, id).changes) return { error: 'not_active' }
    const updated = get(id)
    bus.emit('booking:updated', updated)
    return { booking: updated }
  }

  const get = (id) => q.get.get(id) || null
  const upcomingFor = (phone) => q.upcomingFor.all(phone, iso(clock.now())).map((r) => get(r.id))

  // bookings whose local date is in [fromDate, toDate)
  function between(fromDate, toDate, barberId = null) {
    const from = iso(toUtc(fromDate, '00:00', tz)), to = iso(toUtc(toDate, '00:00', tz))
    return q.range.all(from, to, barberId, barberId).map((r) => get(r.id))
  }

  return {
    services: () => q.services.all(),
    service: (id) => q.service.get(id) || null,
    barbers: () => q.barbers.all(),
    barber: (id) => q.barber.get(id) || null,
    slots, availableDays, book, cancel, setStatus, get, upcomingFor, between, today,
  }
}
