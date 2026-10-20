# Barbershop booking over WhatsApp

Customers book a haircut in a WhatsApp chat. The barber gets the booking on their own WhatsApp straight away, sees the whole day on a live dashboard, and everyone gets reminded at the right time.

Built for a kids' barbershop in Ireland (Magic Scissors) as a portfolio project. **All data in this repo is fictional**: the names are made up and every phone number is in the unused `353000…` range.

## What it does

**Customer, on WhatsApp**
- Taps through *service → barber (or "no preference") → day → time → confirm*. Uses WhatsApp buttons and lists, so there is nothing to type except their name the first time.
- Gets a reminder **1 hour before**, with *I'll be there* and *I need to cancel* buttons.
- Can see and cancel their upcoming bookings at any time ("my bookings").

**Barber, on WhatsApp**
- An alert for every new or cancelled booking, the moment it happens.
- A **daily summary before 10:00** (09:30 by default) with the day's list.
- A ping **30 minutes before** each appointment.

**Barber and owner, on the dashboard**
- Live timeline of the day, one column per barber. It updates without refreshing (Server-Sent Events).
- Book phone calls and walk-ins. The customer still gets a WhatsApp confirmation.
- Cancel (the customer is told), mark done or no-show, see the day's numbers.
- The owner sees every barber and the log of WhatsApp messages sent. A barber sees only their own bookings.
- **Demo "time machine"**: moves the server clock forward so you can watch reminders fire without waiting an hour.

## Try it

You need Node 24. There are no npm dependencies.

```
npm run seed     # fictional barbers, services, bookings, demo logins
npm run demo     # http://127.0.0.1:8090  (login: owner / demo1234)
```

Open `/phone.html` next to the dashboard. It is a WhatsApp simulator: the customer phone on the left, the barber's phone on the right. Say "hi" and book.

## How it works

```
WhatsApp ──► /webhook ──► conversation.mjs ──► booking.mjs ──► SQLite
(Meta Cloud API)    (signature check)  (state machine)    (rules, one transaction)
                                                              │
                         reminders.mjs ◄── tick every 30 s ───┤ events
                         (idempotent)                          ▼
                                    whatsapp.mjs ──► Meta    dashboard (SSE)
                                    (24 h rule)  └─► simulator (demo)
```

| File | Job |
|---|---|
| `server/booking.mjs` | Free slots (opening hours, lunch breaks, notice, overlap); create/cancel inside one write transaction so a slot is never sold twice |
| `server/conversation.mjs` | The chat flow as a state machine; every button carries its own value, so tapping an old message still works |
| `server/reminders.mjs` | Daily summary, 30-min and 1-hour reminders, live alerts; a unique key per reminder means restarts never send duplicates |
| `server/whatsapp.mjs` | Meta Cloud API client, webhook signature check, 24-hour-window rule, simulator transport |
| `server/http.mjs` | Dashboard API, login, CSRF, SSE, webhook endpoint |
| `server/time.mjs` | Injectable clock and Europe/Dublin conversions, including the summer-time switch |

## Decisions worth knowing

- **Meta's 24-hour rule is in the code, not left to luck.** Free-form messages only go out within 24 h of the person's last message. Outside that window (most reminders, and every barber alert) the app sends a pre-approved template, or refuses to send. The templates it needs are listed below.
- **Security.**
  - The webhook rejects anything without a valid `X-Hub-Signature-256` (HMAC with the app secret).
  - Meta's retries are de-duplicated by message id.
  - A customer can only see or cancel their **own** bookings, even if they forge a button id.
  - Dashboard logins use scrypt hashes, an HttpOnly + SameSite=Strict cookie, a CSRF token on every POST, an origin check and a rate limit.
  - A strict Content-Security-Policy blocks inline scripts.
- **No AI in the booking path.** Buttons are predictable, cheap and testable. Understanding free text ("can I come Friday after school?") with an LLM is the natural next layer, on top of these same booking rules.
- **Reminders are idempotent.**
  - Each reminder claims a unique key before sending.
  - A failed send is retried up to 3 times and never repeated once it succeeds.
  - A booking made inside the reminder window doesn't get a redundant reminder.

## Tests

```
npm run smoke
```

The smoke test drives the real HTTP server on a throwaway database with a fake clock. It covers 78 checks:
- the full chat booking;
- double-booking races;
- opening hours, lunch breaks and days off;
- reminder timing and de-duplication;
- the daily summary;
- the 24-hour rule;
- forged cancels;
- dashboard permissions and CSRF;
- the Meta webhook (signature, retries, Cloud API payloads).

Every rule has a canary, a case where it must *not* fire, so a broken check can't silently pass.

## Going live (not done here)

1. A WhatsApp Business number on the Meta Cloud API, then `WHATSAPP_MODE=cloud` and the `WA_*` settings in `.env` (see `.env.example`).
2. Submit these **utility** templates in WhatsApp Manager. Parameters are numbered and must not contain line breaks.

| Name | Body |
|---|---|
| `booking_reminder` | Hi {{1}}, a reminder: {{2}} with {{3}} today at {{4}}. *(quick replies: "I'll be there", "I need to cancel")* |
| `barber_upcoming` | In {{1}} min ({{2}}): {{3}} for {{4}}. |
| `barber_daily_summary` | Good morning {{1}}! {{2}}: {{3}} bookings. {{4}} |
| `barber_new_booking` | New booking: {{1}}, {{2}}, {{3}}. |
| `barber_cancelled` | Cancelled: {{1}}, {{2}}, {{3}}. The slot is free again. |
| `booking_confirmed` | You're booked: {{1}} with {{2}}, {{3}}. Reply "my bookings" to manage it. |
| `booking_cancelled_by_shop` | Sorry, we had to cancel your {{1}} on {{2}}. Reply "book" to pick a new time. |

3. HTTPS in front of the server (`SECURE_COOKIE=1`). Create real logins with `node cli/create_user.mjs <login> [barber_id]`.
4. Customer phone numbers are personal data under GDPR. Add a privacy notice to the first message and a retention policy for old messages before real use.
