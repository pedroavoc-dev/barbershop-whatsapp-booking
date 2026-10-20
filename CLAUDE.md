# Barbershop booking — project rules

WhatsApp booking for a barbershop (portfolio project, styled for Magic Scissors). Not in production. Code, UI and messages in English.

## Stack
Node 24 (built-in SQLite `node:sqlite`), no npm dependencies. Front end without a build step in `public/` (dashboard `index.html`, WhatsApp simulator `phone.html`).

## Run
- `npm run smoke` must pass before every commit (fake clock, throwaway DB).
- Demo: `npm run seed` then `npm run demo`.
- `npm run check` = `node --check` on every JS file.

## Rules that don't break
1. **No real personal data in the repo.** Demo phones only in the `353000…` range; names are fictional.
2. **Nothing changes data on GET.** POST + session + `X-CSRF`.
3. **A customer only touches their own bookings.** Every action carrying a booking id re-checks the phone that sent it.
4. **Meta's 24-hour rule lives in `whatsapp.mjs`.** Business-initiated messages need a template; template params have no line breaks.
5. **A new rule gets a new smoke scenario** with a positive case and a canary.
6. Migrations: `database/migrations/NNN_description.sql`, applied automatically on start.
