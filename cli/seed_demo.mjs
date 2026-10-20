// Fills an EMPTY database with fictional demo data: 3 barbers, services, opening
// hours, a few bookings and dashboard logins. Every name and number is made up;
// phone numbers use the 353000… range, which no real Irish mobile uses.
// Usage: node cli/seed_demo.mjs
import { config } from '../server/config.mjs'
import { local, toUtc, addDays, addMin, iso } from '../server/time.mjs'
import { openDb } from '../server/db.mjs'
import { hashPassword } from '../server/http.mjs'

if (config.whatsappMode === 'cloud') {
  console.error('Refusing: demo data and demo passwords never go into a database connected to real WhatsApp.')
  process.exit(1)
}

const db = openDb()
if (db.prepare('SELECT COUNT(*) AS n FROM barbers').get().n) {
  console.error(`The database already has data (${config.dbFile}). Delete it first to reseed.`)
  process.exit(1)
}

const tz = config.timeZone
const now = new Date()
const today = local(now, tz).date

db.exec('BEGIN')
const barbers = [['Aoife', '353000000101'], ['Cian', '353000000102'], ['Niamh', '353000000103']]
for (const [name, phone] of barbers) db.prepare('INSERT INTO barbers (name, phone) VALUES (?, ?)').run(name, phone)

const services = [['Kids cut (under 12)', 20, 1200], ['Classic cut', 30, 1800], ['Skin fade', 45, 2200], ['Beard trim', 15, 1000], ['Cut + beard', 45, 2500]]
for (const [name, dur, price] of services) db.prepare('INSERT INTO services (name, duration_min, price_cents) VALUES (?, ?, ?)').run(name, dur, price)

// Mon–Sat, lunch break 13:00–14:00; Cian is off on Mondays, Niamh works Sundays mornings
const hours = db.prepare('INSERT INTO working_hours VALUES (?, ?, ?, ?)')
for (const id of [1, 2, 3]) {
  for (let wd = 1; wd <= 6; wd++) {
    if (id === 2 && wd === 1) continue
    hours.run(id, wd, '09:00', '13:00')
    hours.run(id, wd, '14:00', '18:00')
  }
}
hours.run(3, 0, '10:00', '14:00')

const customers = [['Liam', '353000000201'], ['Sophie', '353000000202'], ['Jack', '353000000203'], ['Emma', '353000000204'], ['Noah', '353000000205'], ['Grace', '353000000206']]
for (const [name, phone] of customers) db.prepare('INSERT INTO customers (phone, name, created_at) VALUES (?, ?, ?)').run(phone, name, iso(addMin(now, -7 * 1440)))

// a handful of bookings on the next opening days, all made "a week ago"
const insert = db.prepare(`INSERT INTO bookings (customer_id, barber_id, service_id, starts_at, ends_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
const plan = [[0, '10:00', 1, 1, 1], [0, '11:30', 2, 3, 2], [0, '15:00', 3, 2, 3], [0, '16:15', 1, 5, 4], [1, '09:30', 2, 2, 5], [1, '14:00', 3, 1, 6], [2, '10:30', 1, 4, 1]]
let made = 0
for (const [dayOffset, time, barber, service, customer] of plan) {
  const date = addDays(today, dayOffset)
  const start = toUtc(date, time, tz)
  if (start < now) continue // the demo always starts with bookings in the future
  const dur = services[service - 1][1]
  insert.run(customer, barber, service, iso(start), iso(addMin(start, dur)), 'whatsapp', iso(addMin(now, -7 * 1440)))
  made++
}

const logins = [['owner', null], ['aoife', 1], ['cian', 2], ['niamh', 3]]
for (const [login, barberId] of logins) {
  db.prepare('INSERT INTO users (login, password_hash, barber_id) VALUES (?, ?, ?)').run(login, await hashPassword('demo1234'), barberId)
}
db.exec('COMMIT')

console.log(`Seeded ${barbers.length} barbers, ${services.length} services, ${customers.length} customers, ${made} bookings.`)
console.log('Dashboard logins (demo only): owner / aoife / cian / niamh, password demo1234')
