// Wires the modules together. The smoke test builds the same app with a fake clock.
import { EventEmitter } from 'node:events'
import { openDb } from './db.mjs'
import { createBookings } from './booking.mjs'
import { createWhatsApp } from './whatsapp.mjs'
import { createConversation } from './conversation.mjs'
import { createReminders } from './reminders.mjs'
import { createHttp } from './http.mjs'

export function createApp({ config, clock, dbFile = config.dbFile, fetchImpl }) {
  const db = openDb(dbFile)
  const bus = new EventEmitter()
  const bookings = createBookings({ db, clock, config, bus })
  const wa = createWhatsApp({ db, clock, config, fetchImpl })
  const conversation = createConversation({ db, clock, config, bookings, wa })
  const reminders = createReminders({ db, clock, config, bookings, wa, bus })
  const http = createHttp({ db, clock, config, bookings, wa, conversation, reminders, bus })
  return { db, bus, bookings, wa, conversation, reminders, http }
}
