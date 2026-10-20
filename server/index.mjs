// Starts the server and the reminder loop.
import { config, checkConfig } from './config.mjs'
import { createClock } from './time.mjs'
import { createApp } from './app.mjs'
import { checkPassword } from './http.mjs'

const DEMO_PASSWORD = 'demo1234' // same as cli/seed_demo.mjs

checkConfig()
const clock = createClock()
const app = createApp({ config, clock })

// a database seeded for the demo still has public passwords: never let it face real WhatsApp
if (config.whatsappMode === 'cloud') {
  const weak = []
  for (const u of app.db.prepare('SELECT login, password_hash FROM users').all()) {
    if (await checkPassword(DEMO_PASSWORD, u.password_hash).catch(() => false)) weak.push(u.login)
  }
  if (weak.length) {
    console.error(`Refusing to start in cloud mode: ${weak.join(', ')} still use the demo password. Reset with node cli/create_user.mjs <login>.`)
    process.exit(1)
  }
}

app.http.server.listen(config.port, config.host, () => {
  console.log(`[${config.shopName}] dashboard on http://${config.host}:${config.port}  ·  WhatsApp: ${config.whatsappMode}${config.demo ? '  ·  DEMO mode' : ''}`)
  if (config.whatsappMode === 'simulator') console.log(`phone simulator on http://${config.host}:${config.port}/phone.html`)
})

app.reminders.tick()
setInterval(() => app.reminders.tick(), config.reminderTickSec * 1000)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { app.http.server.close(); app.db.close(); process.exit(0) })
}
