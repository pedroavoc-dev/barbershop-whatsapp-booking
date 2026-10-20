// Creates a dashboard login with a random password, printed once.
// Usage: node cli/create_user.mjs <login> [barber_id]   (no barber_id = owner, sees everyone)
import { randomBytes } from 'node:crypto'
import { openDb } from '../server/db.mjs'
import { hashPassword } from '../server/http.mjs'

const [login, barber] = process.argv.slice(2)
if (!/^[a-z0-9_.-]{3,30}$/.test(login || '')) {
  console.error('usage: node cli/create_user.mjs <login> [barber_id]   (login: 3–30 lowercase letters/digits)')
  process.exit(1)
}
const db = openDb()
const barberId = barber ? Number(barber) : null
if (barberId && !db.prepare('SELECT 1 FROM barbers WHERE id = ?').get(barberId)) {
  console.error(`barber ${barberId} does not exist`)
  process.exit(1)
}
const password = randomBytes(9).toString('base64url')
db.prepare(`INSERT INTO users (login, password_hash, barber_id) VALUES (?, ?, ?)
            ON CONFLICT(login) DO UPDATE SET password_hash = excluded.password_hash, barber_id = excluded.barber_id`)
  .run(login, await hashPassword(password), barberId)
db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE login = ?)').run(login)
console.log(`login: ${login}${barberId ? ` (barber ${barberId})` : ' (owner)'}\npassword: ${password}\nWrite it down now; it is not stored in clear anywhere.`)
