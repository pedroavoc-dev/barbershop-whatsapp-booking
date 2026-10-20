// WhatsApp channel. Same rules in both modes; only the transport changes:
//  - simulator: messages stay in the database (demo + tests)
//  - cloud: Meta WhatsApp Cloud API
// Meta's 24-hour rule: free-form messages (text, buttons, lists) only within 24h of the
// person's last message. Outside that window only a pre-approved template may be sent.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { iso } from './time.mjs'

const WINDOW_MS = 24 * 3600e3
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s))

export function createWhatsApp({ db, clock, config, fetchImpl = fetch }) {
  const q = {
    lastIn: db.prepare(`SELECT created_at FROM messages WHERE phone = ? AND direction = 'in' ORDER BY id DESC LIMIT 1`),
    insert: db.prepare(`INSERT INTO messages (direction, phone, kind, body, wa_id, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    seen: db.prepare('SELECT 1 FROM messages WHERE wa_id = ?'),
  }

  const inWindow = (phone) => {
    const last = q.lastIn.get(phone)
    return !!last && clock.now().getTime() - new Date(last.created_at).getTime() < WINDOW_MS
  }

  // message: { kind: 'text'|'buttons'|'list', text, buttons?, rows?, button? }
  // template: { name, params } used when the 24h window is closed (reminders, barber alerts)
  async function send(phone, message, template = null) {
    let out = normalise(message)
    if (!inWindow(phone)) {
      if (!template) return record(phone, out, false, 'outside 24h window and no template')
      out = { kind: 'template', name: template.name, params: template.params.map(String), text: message.text, buttons: template.buttons || [] }
    }
    if (config.whatsappMode === 'simulator') return record(phone, out, true)
    try {
      const r = await fetchImpl(`https://graph.facebook.com/${config.wa.apiVersion}/${config.wa.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.wa.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(toCloud(phone, out, config.wa.templateLang)),
        signal: AbortSignal.timeout(10000),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) return record(phone, out, false, `HTTP ${r.status}: ${body?.error?.message || 'no body'}`)
      return record(phone, out, true, null, body?.messages?.[0]?.id)
    } catch (err) {
      return record(phone, out, false, err.message)
    }
  }

  function record(phone, out, ok, error = null, waId = null) {
    const r = q.insert.run('out', phone, out.kind, JSON.stringify(out), waId, ok ? 'ok' : 'failed', error, iso(clock.now()))
    if (!ok) console.error(`[whatsapp] send to …${phone.slice(-4)} failed: ${error}`)
    return { ok, id: Number(r.lastInsertRowid), kind: out.kind, error }
  }

  // stores an inbound message; returns false if Meta is re-delivering one we already have
  function receive({ phone, waId, text, replyId, replyTitle }) {
    if (waId && q.seen.get(waId)) return false
    q.insert.run('in', phone, replyId ? 'reply' : 'text', JSON.stringify({ text, replyId, replyTitle }), waId || null, 'ok', null, iso(clock.now()))
    return true
  }

  return { send, receive, inWindow }
}

function normalise(m) {
  if (m.kind === 'buttons') {
    return { kind: 'buttons', text: cut(m.text, 1024), buttons: m.buttons.slice(0, 3).map((b) => ({ id: b.id, title: cut(b.title, 20) })) }
  }
  if (m.kind === 'list') {
    return {
      kind: 'list', text: cut(m.text, 1024), button: cut(m.button || 'Choose', 20),
      rows: m.rows.slice(0, 10).map((r) => ({ id: r.id, title: cut(r.title, 24), ...(r.description ? { description: cut(r.description, 72) } : {}) })),
    }
  }
  return { kind: 'text', text: cut(m.text, 4096) }
}

function toCloud(to, m, lang) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to }
  if (m.kind === 'text') return { ...base, type: 'text', text: { body: m.text, preview_url: false } }
  if (m.kind === 'buttons') {
    return { ...base, type: 'interactive', interactive: { type: 'button', body: { text: m.text },
      action: { buttons: m.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } }
  }
  if (m.kind === 'list') {
    return { ...base, type: 'interactive', interactive: { type: 'list', body: { text: m.text },
      action: { button: m.button, sections: [{ title: 'Options', rows: m.rows }] } } }
  }
  const components = [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text })) }]
  m.buttons.forEach((b, index) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: b.id }] }))
  return { ...base, type: 'template', template: { name: m.name, language: { code: lang }, components } }
}

// X-Hub-Signature-256 = "sha256=" + HMAC(app secret, raw body). Without this check anyone
// who finds the webhook URL can impersonate any customer.
export function validSignature(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'))
  const got = Buffer.from(header.slice(7))
  return got.length === expected.length && timingSafeEqual(got, expected)
}

// Meta webhook payload → [{ phone, waId, text, replyId, replyTitle }]
export function parseWebhook(payload) {
  const out = []
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const m of change?.value?.messages || []) {
        const phone = String(m.from || '').replace(/\D/g, '')
        if (!phone) continue
        const i = m.interactive
        const reply = i?.button_reply || i?.list_reply
        out.push({
          phone, waId: m.id,
          text: m.text?.body ?? reply?.title ?? m.button?.text ?? '',
          replyId: reply?.id ?? m.button?.payload ?? null,
          replyTitle: reply?.title ?? m.button?.text ?? null,
        })
      }
    }
  }
  return out
}
