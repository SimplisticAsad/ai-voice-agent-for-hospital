# AI Voice Agent for Hospital — Patient Registration System

A voice AI agent that answers a real phone number, conversationally collects U.S. patient
demographic information, persists it to a database, and exposes it through a REST API and a
small dashboard.

## Architecture

```
Caller (phone)
     │  PSTN
     ▼
Twilio Voice  ──(webhook: POST /voice/incoming, /voice/gather)──▶  Express server
     │  <Gather input="speech"> for STT, <Say> for TTS                 │
     ▼                                                                  │
Conversation loop (services/llmAgent.js)                                │
     │  OpenAI chat.completions + function calling                      │
     │  tools: validate_field, check_existing_patient,                  │
     │         submit_registration, update_existing_patient, end_call   │
     ▼                                                                  ▼
services/patientService.js  ◀── shared service layer ──▶  routes/patients.js (REST API)
     │
     ▼
SQLite (better-sqlite3, file-based, survives restarts)
     │
     ▼
public/dashboard.html (reads GET /patients)
```

**Separation of concerns:**
- `routes/voice.js` — Twilio webhook handlers only (TwiML generation, per-call state machine keyed by `CallSid`). No business logic or SQL here.
- `services/llmAgent.js` — conversation/dialogue manager: system prompt, tool/function definitions, the tool-calling loop. This is the only place that talks to OpenAI.
- `services/patientService.js` — the single source of truth for patient CRUD + validation orchestration. Used by **both** the REST API and the voice agent's tools, per the spec's "must use the REST API or the same service layer" requirement.
- `services/validators.js` — pure, stateless field validation/normalization functions (no I/O), used by both the API and the voice agent's `validate_field` tool.
- `routes/patients.js` — thin REST controllers over `patientService`.
- `db/database.js` — schema, indices, and seed data.

## Why this stack

| Layer | Choice | Why |
|---|---|---|
| Telephony + STT/TTS | **Twilio Voice** `<Gather input="speech">` + `<Say>` | Twilio's built-in speech recognition and Polly TTS voices are "good enough" for a natural conversation without needing a second vendor (Deepgram/ElevenLabs) and a second API key/websocket pipeline — fewer moving parts to wire up correctly in the time box. Trade-off documented below. |
| Conversation / NLU | **OpenAI `gpt-4o-mini` with function calling** | Handles varied phrasing, corrections, and out-of-order answers naturally. Function calling (`tools`) forces the model to route every field through **deterministic server-side validation** (`validate_field`) instead of trusting the LLM's own judgment about format correctness — this is what makes "3-digit phone number" or "future DOB" reliably caught. |
| Database | **SQLite via `better-sqlite3`** | Zero external services to provision, synchronous API (simpler reasoning under time pressure), file persists across restarts, trivially portable to Postgres later (see Limitations). |
| Backend | **Node.js + Express** | Twilio and OpenAI both have first-class Node SDKs; one language across telephony glue, LLM orchestration, and REST API keeps the codebase small. |

## Data model

See `db/database.js` for the full schema (`patients` table with `CHECK` constraint on `sex`,
indices on `phone_number`/`last_name`/`date_of_birth`, soft-delete via `deleted_at`). All fields
and validation rules match the spec's demographic dataset table exactly. A `call_transcripts`
table stores a per-call transcript for observability/debugging (see Bonus section).

## REST API

Base URL: `http://localhost:3000` (or your deployed URL).

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/patients` | Optional query params: `?last_name=`, `?date_of_birth=` (YYYY-MM-DD), `?phone_number=` |
| GET | `/patients/:id` | 404 if not found or soft-deleted |
| POST | `/patients` | 201 + created record, or 422 with per-field errors |
| PUT | `/patients/:id` | Partial updates allowed |
| DELETE | `/patients/:id` | Soft delete (`deleted_at` set, row kept) |

All responses use the envelope `{ "data": ..., "error": ... }`. All input is validated
server-side in `services/validators.js` — the API never trusts the voice agent's output blindly.

A minimal dashboard is served at `/` (reads `GET /patients`, supports filtering by last name / phone).

## Voice agent design

- **Entry point:** point a Twilio phone number's "A call comes in" webhook at
  `POST https://<your-host>/voice/incoming`.
- **Per-call state** lives in an in-memory `Map` keyed by Twilio's `CallSid` (see `routes/voice.js`), holding the running chat message history and flags (`shouldHangup`, `matchedExistingPatientId`, `savedPatientId`).
- **Turn loop:** on each `<Gather>` result, the transcript is appended to the conversation and sent to OpenAI with `tools` enabled. The model may chain multiple tool calls (e.g. `validate_field` → `check_existing_patient`) before producing the text that actually gets spoken via `<Say>`.
- **Tools exposed to the model** (`services/llmAgent.js`):
  - `validate_field(field, value)` — runs the exact same validators as the REST API. This is what powers "if the caller provides invalid data... re-prompt specifically for that field."
  - `check_existing_patient(phone_number)` — duplicate-detection bonus: as soon as a valid phone number is captured, the model checks for an existing record and offers to update instead of create.
  - `submit_registration(...)` / `update_existing_patient(...)` — the only two ways data reaches the database; both go through `patientService`, so voice and API paths share one validation/persistence path.
  - `end_call()` — signals the webhook handler to append `<Hangup/>` after the goodbye line.
- **The full system prompt is in `services/llmAgent.js` (`SYSTEM_PROMPT`)**, with inline comments explaining each prompt-engineering decision (why confirmation is forced before saving, why corrections/restarts are handled explicitly, why tool calls are required rather than trusting free-form extraction).
- **Confirmation:** the prompt requires the agent to read back every collected field and get an explicit "yes" before any `submit_registration`/`update_existing_patient` call.
- **Corrections & restart:** handled conversationally per the prompt (re-validate and overwrite a field; a full "start over" wipes previously collected values).
- **Error handling:** if `submit_registration` fails (validation or DB error), the tool result is fed back to the model, which is instructed to apologize and offer to retry rather than claim success — so a DB failure never results in a false "you're all set."
- **Dropped calls:** Twilio's `statusCallback` hits `POST /voice/status`; on `completed`/`failed`/`busy`/`no-answer`/`canceled` the handler persists the transcript and clears in-memory state so nothing leaks across calls.
- **Observability:** every turn is logged to stdout (`[voice] <CallSid> said: ...`), and the final collected payload / matched patient ID is logged on call completion. Full transcripts are also saved to the `call_transcripts` table.

## Setup

### Prerequisites
- Node.js 18+
- A Twilio account with a phone number (trial account works)
- An OpenAI API key

### Install

```bash
npm install
cp .env.example .env
# fill in OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
npm start
```

The server starts on `PORT` (default `3000`), auto-creates `patients.db` (SQLite) with schema +
2 seed patients on first run, and serves the dashboard at `/`.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | OpenAI key used for the conversation LLM |
| `OPENAI_MODEL` | No (default `gpt-4o-mini`) | Chat model to use |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Yes (for live calls) | Twilio credentials |
| `TWILIO_TTS_VOICE` | No (default `Polly.Joanna`) | Any Twilio-supported `<Say>` voice |
| `PORT` | No (default `3000`) | HTTP port |
| `DATABASE_PATH` | No (default `./patients.db`) | SQLite file location |

### Exposing the server to Twilio

For local development, tunnel the port (e.g. `ngrok http 3000`) and set the Twilio number's
Voice webhook to `https://<ngrok-id>.ngrok.io/voice/incoming` (HTTP POST). Set the status
callback URL to `https://<ngrok-id>.ngrok.io/voice/status`. For a permanent deployment, host on
Railway/Render/Fly.io and point the webhook at that URL instead.

## Testing without a phone call

The REST API can be exercised directly:

```bash
curl -X POST http://localhost:3000/patients \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Jane","last_name":"Smith","date_of_birth":"01/01/1990","sex":"Female","phone_number":"5551234567","address_line_1":"1 Main St","city":"Boston","state":"MA","zip_code":"02108"}'

curl http://localhost:3000/patients
curl "http://localhost:3000/patients?last_name=Smith"
```

## Known limitations & trade-offs

- **In-memory call state** (`routes/voice.js`) means the voice agent only works correctly on a
  single server instance — a multi-instance/autoscaled deployment would need call state moved
  to Redis or the database, keyed by `CallSid`.
- **Twilio's built-in speech recognition and TTS** were used instead of a dedicated
  STT/TTS vendor (Deepgram/ElevenLabs). This is faster to integrate and keeps the stack to two
  vendors (Twilio + OpenAI) but has more latency and lower voice naturalness than a
  purpose-built realtime voice pipeline (e.g. Vapi/Retell, or Twilio Media Streams +
  streaming STT/TTS). Recommended next step for production-grade voice quality.
- **Tool-calling round trips**: the agent may call OpenAI multiple times per turn (e.g.
  `validate_field` then a final response), which adds latency compared to single-shot
  extraction. Acceptable for this use case, but a streaming response would feel more responsive.
- **No phone number ownership verification** — anyone who knows a phone number could, in
  theory, claim it during the "existing patient" duplicate-detection flow. A production system
  would verify identity (e.g. DOB + last name match) before allowing an update.
- **SQLite** is fine for a single-instance demo; a real deployment with concurrent write load
  would move to PostgreSQL (the schema in `db/database.js` is intentionally close to standard
  SQL and would port with minimal changes).
- **No HIPAA controls** (encryption at rest, audit logging, BAA) — out of scope per the
  assessment brief; do not use with real patient data.
- **Multi-language bonus** relies entirely on the LLM's fluency and Twilio's TTS voice — there's
  no automatic Twilio voice/locale switch (e.g. to a Spanish Polly voice) tied to the detected
  language, so TTS accent may not match the conversation language.

## Bonus features implemented

- ✅ **Duplicate detection** — `check_existing_patient` tool + prompt instructions to offer an update instead of a new record.
- ✅ **Call transcript storage** — every call's transcript is saved to the `call_transcripts` table, linked to `patient_id` when a save succeeds.
- ✅ **Dashboard** — `public/dashboard.html`, a simple read-only patient list with last-name/phone filtering.
- ✅ **Multi-language** — the system prompt instructs the agent to switch to Spanish (or any language) mid-call on request.
- ⬜ Appointment scheduling — not implemented (documented as a "Next Steps" item below).
- ⬜ Automated tests — not implemented given the time box; see Next Steps.

## Next steps (if given more time)

1. Add integration tests for `services/patientService.js` and the `/patients` routes (e.g. with `supertest` + an in-memory SQLite file).
2. Move call state to a shared store (Redis) to support horizontal scaling.
3. Switch to Twilio Media Streams + a streaming STT/TTS vendor for lower latency and more natural barge-in/interruption handling.
4. Add identity verification (DOB match) before allowing an "update existing patient" flow triggered purely by caller ID/phone number.
5. Add appointment scheduling as a follow-up tool call after successful registration.
6. Migrate SQLite → PostgreSQL for multi-instance deployments.

## Security notes

- No secrets are hardcoded; everything sensitive comes from environment variables (`.env`, gitignored).
- All API input is validated and normalized server-side regardless of what the voice agent sends.
- `express.json()` body size is capped; CORS is enabled for the demo dashboard.
