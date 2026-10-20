// Starts the server and the reminder loop.
import { config, checkConfig } from './config.mjs'
import { createClock } from './time.mjs'
import { createApp } from './app.mjs'

checkConfig()
const clock = createClock()
const app = createApp({ config, clock })

app.http.server.listen(config.port, config.host, () => {
  console.log(`[${config.shopName}] dashboard on http://${config.host}:${config.port}  ·  WhatsApp: ${config.whatsappMode}${config.demo ? '  ·  DEMO mode' : ''}`)
  if (config.whatsappMode === 'simulator') console.log(`phone simulator on http://${config.host}:${config.port}/phone.html`)
})

app.reminders.tick()
setInterval(() => app.reminders.tick(), config.reminderTickSec * 1000)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { app.http.server.close(); app.db.close(); process.exit(0) })
}
