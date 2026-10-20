// Settings read from .env (never committed). Defaults are for local development.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'))

const e = process.env
const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v))

export const config = {
  host: e.HOST || '127.0.0.1',
  port: num(e.PORT, 8090),
  secureCookie: e.SECURE_COOKIE === '1',     // turn on once served over HTTPS
  trustProxy: e.TRUST_PROXY === '1',         // behind a tunnel: use X-Forwarded-For for login rate limits
  dbFile: e.DB_FILE || join(ROOT, 'data', 'agenda.db'),

  shopName: e.SHOP_NAME || 'Magic Scissors',
  timeZone: e.TIME_ZONE || 'Europe/Dublin',
  slotStepMin: num(e.SLOT_STEP_MIN, 15),       // booking grid
  minNoticeMin: num(e.MIN_NOTICE_MIN, 30),     // no bookings closer than this to now
  bookingDaysAhead: num(e.BOOKING_DAYS_AHEAD, 14),
  maxActivePerCustomer: num(e.MAX_ACTIVE_PER_CUSTOMER, 3),
  conversationTimeoutMin: num(e.CONVERSATION_TIMEOUT_MIN, 30),

  // reminders
  dailySummaryAt: e.DAILY_SUMMARY_AT || '09:30', // local time, must be before 10:00
  customerReminderMin: num(e.CUSTOMER_REMINDER_MIN, 60),
  barberReminderMin: num(e.BARBER_REMINDER_MIN, 30),
  reminderTickSec: num(e.REMINDER_TICK_SEC, 30),

  // WhatsApp: 'simulator' keeps everything in the database (demo, tests);
  // 'cloud' talks to the Meta WhatsApp Cloud API.
  whatsappMode: e.WHATSAPP_MODE || 'simulator',
  wa: {
    token: e.WA_TOKEN || '',
    phoneNumberId: e.WA_PHONE_NUMBER_ID || '',
    appSecret: e.WA_APP_SECRET || '',          // validates X-Hub-Signature-256 on the webhook
    verifyToken: e.WA_VERIFY_TOKEN || '',      // webhook subscription handshake
    apiVersion: e.WA_API_VERSION || 'v21.0',
    templateLang: e.WA_TEMPLATE_LANG || 'en',
  },

  // demo mode: lets the dashboard fast-forward the clock to show reminders firing
  demo: e.DEMO === '1',
}

export function checkConfig() {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.dailySummaryAt) || config.dailySummaryAt >= '10:00') {
    throw new Error('DAILY_SUMMARY_AT must be HH:MM before 10:00')
  }
  if (config.whatsappMode === 'cloud') {
    const missing = ['token', 'phoneNumberId', 'appSecret', 'verifyToken'].filter((k) => !config.wa[k])
    if (missing.length) throw new Error(`WHATSAPP_MODE=cloud needs: ${missing.map((k) => 'WA_' + k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()).join(', ')}`)
    if (config.demo) throw new Error('DEMO=1 moves the clock; never combine it with real WhatsApp')
  } else if (config.whatsappMode !== 'simulator') {
    throw new Error('WHATSAPP_MODE must be simulator or cloud')
  }
}
