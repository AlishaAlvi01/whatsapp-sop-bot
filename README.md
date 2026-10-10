# WhatsApp SOP Assistant

A WhatsApp bot that gives every team member instant answers from **their own role's SOPs** — and lets admins keep those SOPs up to date without leaving WhatsApp.

Runs on a single Cloudflare Worker. Free-tier friendly: Cloudflare Workers + KV, Groq, and the WhatsApp Cloud API directly from Meta (no BSP fees).

> Template repo. Generic, rebuilt reference implementation of a system I designed and run in production. No client code, data, or IDs are included.

## What it does

| Feature | How |
|---|---|
| Role-based SOP answers | Each user has a role in KV; each role maps to a primary Google Doc + read-only reference docs (e.g. a sales playbook) |
| Grounded answers only | LLM is told to answer only from the docs, and to say so when the answer isn't there |
| `/sop <note>` | Rewrites a rough note (text or voice) into a clean SOP entry and appends it to the role's doc |
| Contradiction check | Before saving, compares the new rule to the existing SOP; on conflict, sends **Replace / Keep both / Cancel** buttons |
| `/adduser`, `/removeuser` | Admin-only team management from WhatsApp; a typo'd role triggers a pick-list instead of an error |
| Voice notes | Whisper transcription with Urdu-script → Roman Urdu normalisation |
| Greeting | Greets the user by name once per 24h |
| Token guard | Primary SOP always fits; reference docs are truncated/dropped first |
| Idempotency | Duplicate webhook deliveries are ignored |

## Architecture

```
WhatsApp user ──► Meta Cloud API ──► Worker /webhook
                                        │  ack 200 immediately, work in waitUntil()
                                        ├─ KV TEAM   (who is this? which role?)
                                        ├─ KV STATE  (seen IDs, greetings, pending decisions)
                                        ├─ Groq      (Whisper, answer, polish, conflict check)
                                        └─ Google Docs API (read / append / replace SOPs)
```

## Setup

1. **Meta**: create an app with WhatsApp, add a number, generate a permanent System User token.
2. **Google**: create a service account, enable the Docs API, and share each SOP doc with the service-account email as *Editor*.
3. **Cloudflare**:
   ```bash
   npm install
   npx wrangler kv namespace create TEAM
   npx wrangler kv namespace create STATE
   # paste the IDs into wrangler.jsonc, fill ROLE_DOCS
   npx wrangler secret put WA_TOKEN
   npx wrangler secret put WA_PHONE_NUMBER_ID
   npx wrangler secret put WA_VERIFY_TOKEN
   npx wrangler secret put GROQ_API_KEY
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < service-account.json
   npm run deploy
   ```
4. Set the webhook URL in Meta to `https://<worker>.workers.dev/webhook` with your verify token, subscribe to `messages`.
5. Register your first admin: `npm run seed-admin -- 92300XXXXXXX "Your Name"` and run the printed command.

## Design notes

- **Confirmation-first UX.** Anything that changes data asks with buttons, never free text.
- **WhatsApp is the only interface** — admins never need a dashboard.
- **Secrets only via `wrangler secret`.** Nothing sensitive in the repo.
- Extend by adding command handlers in `handleCommand()`; the same Worker can host other flows (task creation, ledgers, data entry).

## Author

Built by **Alisha Alvi** — automation & AI systems engineer.
[LinkedIn](https://linkedin.com/in/alisha-alvie) · [GitHub](https://github.com/AlishaAlvi01) · alishaalvi745@gmail.com
