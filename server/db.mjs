// SQLite (built into Node 24) + numbered migrations applied on start.
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config, ROOT } from './config.mjs'

export function openDb(file = config.dbFile) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
  migrate(db)
  return db
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (file TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  const dir = join(ROOT, 'database', 'migrations')
  const done = new Set(db.prepare('SELECT file FROM migrations').all().map((r) => r.file))
  for (const file of readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()) {
    if (done.has(file)) continue
    db.exec('BEGIN')
    try {
      db.exec(readFileSync(join(dir, file), 'utf8'))
      db.prepare('INSERT INTO migrations VALUES (?, ?)').run(file, new Date().toISOString())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${file} failed: ${err.message}`)
    }
  }
}

// run fn inside one write transaction (BEGIN IMMEDIATE takes the write lock up front,
// so two bookings for the same slot can never both pass the "is it free?" check)
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
