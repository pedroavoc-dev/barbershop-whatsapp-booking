// Clock and local-time helpers. The database stores UTC; the shop lives in config.timeZone.
// Every module asks the clock for "now", so tests and the demo can move time.

export function createClock({ start = null, offsetMs = 0 } = {}) {
  let fixed = start ? new Date(start).getTime() : null
  let offset = offsetMs
  return {
    now: () => new Date(fixed ?? Date.now() + offset),
    set: (d) => { fixed = new Date(d).getTime() },
    advance: (min) => { if (fixed !== null) fixed += min * 60000; else offset += min * 60000 },
    offsetMin: () => (fixed === null ? Math.round(offset / 60000) : null),
    reset: () => { offset = 0 },
  }
}

const partsCache = new Map()
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }))
  }
  return partsCache.get(tz)
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// { date: 'YYYY-MM-DD', time: 'HH:MM', weekday: 0-6 } in the shop's time zone
export function local(d, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(d)).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: WEEKDAYS[p.weekday] }
}

function offsetMs(ms, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000
}

// local wall-clock date + time → UTC Date (handles the summer-time switch)
export function toUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, h, mi)
  let ms = guess - offsetMs(guess, tz)
  const again = guess - offsetMs(ms, tz)
  if (again !== ms) ms = again
  return new Date(ms)
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10)
}

export const addMin = (d, min) => new Date(new Date(d).getTime() + min * 60000)
export const iso = (d) => new Date(d).toISOString()

// "Tue 21 Oct" / "14:30" / "Tue 21 Oct, 14:30" for messages
export function dayLabel(date) {
  const d = new Date(`${date}T12:00:00Z`)
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}
export const whenLabel = (d, tz) => { const l = local(d, tz); return `${dayLabel(l.date)}, ${l.time}` }
