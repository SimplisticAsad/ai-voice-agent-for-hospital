# AI Voice Agent for Hospital — Patient Registration System

A voice AI agent that answers a phone call (via Twilio), conversationally collects U.S. patient
demographic information using a Qwen LLM (via Hugging Face + smolagents), persists it to SQLite,
and exposes it through a REST API and a small dashboard.

## Architecture

```
Caller (phone)
     │  PSTN
     ▼
Twilio Voice  ──(webhook: POST /voice/incoming, /voice/gather)──▶  Flask server
     │  <Gather input="speech"> for STT, <Say> for TTS                 │
     ▼                                                                  │
Conversation loop (app/voice_agent.py)                                  │
     │  smolagents ToolCallingAgent + Qwen (via HF Inference)           │
     │  tools: validate_field, check_existing_patient,                 │
     │         submit_registration, update_existing_patient, end_call  │
     ▼                                                                  ▼
app/patient_service.py  ◀── shared service layer ──▶  app/routes/patients.py (REST API)
     │
     ▼
SQLite (stdlib sqlite3, file-based, survives restarts)
     │
     ▼
templates/dashboard.html (reads GET /patients)
```

**Separation of concerns:**
- `app/routes/voice.py` — Twilio webhook handlers only (TwiML generation, per-call state keyed by `CallSid`). No business logic or SQL here.
- `app/voice_agent.py` — conversation/dialogue manager: system prompt, smolagents `ToolCallingAgent` construction, the per-call agent instance and its memory.
- `app/tools.py` — smolagents `Tool` subclasses that bridge the LLM to the service layer (`validate_field`, `check_existing_patient`, `submit_registration`, `update_existing_patient`, `end_call`).
- `app/patient_service.py` — the single source of truth for patient CRUD + validation orchestration. Used by **both** the REST API and the voice agent's tools, per the spec's "must use the REST API or the same service layer" requirement.
- `app/validators.py` — pure, stateless field validation/normalization functions (no I/O), used by both the API and the voice agent's `validate_field` tool.
- `app/routes/patients.py` — thin REST controllers over `patient_service`.
- `app/database.py` — schema, indices, and seed data (stdlib `sqlite3`).
- `wsgi.py` — Flask app factory / entrypoint.

## Why this stack

| Layer | Choice | Why |
|---|---|---|
| Telephony + STT/TTS | **Twilio Voice** `<Gather input="speech">` + `<Say>` | Twilio's built-in speech recognition and Polly TTS voices avoid needing a second vendor (Deepgram/ElevenLabs) and a second API key/websocket pipeline. |
| Conversation / NLU | **Qwen (`Qwen2.5-7B-Instruct` by default) via Hugging Face Inference + smolagents `ToolCallingAgent`** | Requested stack, matching the project's original Python/HF/smolagents prototype (`calling agent.ipynb`, `testcall.py`). `ToolCallingAgent` gives JSON-style tool calling (closer to OpenAI-style function calling than `CodeAgent`'s code-writing loop), routing every field through **deterministic server-side validation** (`validate_field`) instead of trusting the model's own judgment about format correctness. |
| Database | **SQLite via stdlib `sqlite3`** | Zero external services to provision, file persists across restarts, trivially portable to Postgres later. |
| Backend | **Python + Flask** | Matches the existing Python/Twilio/smolagents prototype this was built from; Twilio's Python SDK and smolagents are both first-class here. |

## ⚠️ Known model-quality issue (read before demoing)

During local testing (no phone call involved — see "Testing without a phone call" below) with the
free-tier Hugging Face Inference API and `Qwen/Qwen2.5-7B-Instruct`, we observed two serious
reliability problems that anyone building on this should know about:

1. **Tool-call parsing failures.** `ToolCallingAgent` requires the model to emit a specific JSON
   tool-call format. The 7B model frequently fails to do this correctly — in one recorded test
   turn, 7 of 9 reasoning steps failed with `"the model output does not contain any JSON blob"`
   before it eventually produced an answer only because it hit `max_steps`. This burns a lot of
   tokens/latency per turn (up to ~70k input tokens observed by the second turn, before we added
   the memory cap described below) and would cause dead air / Twilio `<Gather>` timeouts on a
   real call.
2. **Hallucinated patient data.** In one test, after the caller said "My name is Carlos Ramirez,"
   the model responded (in Spanish, unprompted) claiming it already had a date of birth of
   `01/01/1990` on file — a value that was never provided by the caller, the tools, or the system
   prompt. It also failed to retain the name just given. **This is a correctness failure, not a
   cosmetic one** — a model that invents demographic data is a real risk for a system whose whole
   purpose is accurately capturing that data.
3. **Inconsistent language switching.** The model switched to Spanish mid-conversation multiple
   times without being asked to, contrary to explicit system-prompt instructions to stay in
   English unless the caller requests otherwise.

Mitigations already applied in this codebase (`app/voice_agent.py`):
- `max_steps` capped at 5 (was 8) to limit runaway retries per turn.
- Agent memory is truncated to the last 10 steps after every turn, since `ToolCallingAgent`
  otherwise keeps *every* failed-parse attempt in context indefinitely, compounding token usage
  turn over turn (this alone caused one Hugging Face token's free monthly credits to be
  exhausted mid-test).

These mitigations reduce cost/latency but do **not** fix the underlying hallucination and
instruction-following weaknesses of a 7B instruct model asked to do structured multi-turn
tool-calling. If this were going into any real (even non-production) use with real callers, the
recommended fix is to swap the model layer for a stronger tool-calling model (OpenAI
`gpt-4o-mini` via native function calling, or a much larger Qwen model with confirmed inference
provider support) — the rest of the architecture (Flask routes, validators, service layer,
Twilio glue) would not need to change, only `app/voice_agent.py` and `app/tools.py`.

## Data model

See `app/database.py` for the full schema (`patients` table with a `CHECK` constraint on `sex`,
indices on `phone_number`/`last_name`/`date_of_birth`, soft-delete via `deleted_at`). All fields
and validation rules match the spec's demographic dataset table exactly. A `call_transcripts`
table stores a per-call transcript for observability/debugging.

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
server-side in `app/validators.py` — the API never trusts the voice agent's output blindly.

A minimal dashboard is served at `/` (reads `GET /patients`, supports filtering by last name / phone).

## Voice agent design

- **Entry point:** point a Twilio phone number's "A call comes in" webhook at
  `POST https://<your-host>/voice/incoming`.
- **Per-call state** lives in an in-memory dict keyed by Twilio's `CallSid` (see
  `app/routes/voice.py`), holding a persistent `ToolCallingAgent` instance and flags
  (`should_hangup`, `matched_existing_patient_id`, `saved_patient_id`).
- **Turn loop:** on each `<Gather>` result, `agent.run(speech_text, reset=False)` continues the
  same agent's memory across turns, letting it call tools and eventually produce the text spoken
  back via `<Say>`.
- **Tools exposed to the model** (`app/tools.py`):
  - `validate_field(field, value)` — runs the exact same validators as the REST API.
  - `check_existing_patient(phone_number)` — duplicate-detection bonus: as soon as a valid phone number is captured, the model checks for an existing record and offers to update instead of create.
  - `submit_registration(...)` / `update_existing_patient(...)` — the only two ways data reaches the database; both go through `patient_service`, so voice and API paths share one validation/persistence path.
  - `end_call()` — signals the webhook handler to append `<Hangup/>` after the goodbye line.
- **The full system prompt is in `app/voice_agent.py` (`SYSTEM_PROMPT`)**, with inline comments explaining each prompt-engineering decision.
- **Confirmation:** the prompt requires the agent to read back every collected field and get an explicit "yes" before any `submit_registration`/`update_existing_patient` call. (See the Known Issue above — in practice the 7B model does not always follow this reliably.)
- **Error handling:** if a save tool fails (validation or DB error), the tool result is fed back to the model, which is instructed to apologize and offer to retry rather than claim success.
- **Dropped calls:** Twilio's `statusCallback` hits `POST /voice/status`; on `completed`/`failed`/`busy`/`no-answer`/`canceled` the handler persists the transcript and clears in-memory state.
- **Observability:** every turn is logged to stdout, and the final collected payload / matched patient ID is logged on call completion. Full transcripts are saved to the `call_transcripts` table.

## Setup

### Prerequisites
- Python 3.10+
- A Twilio account with a phone number (trial account works, with caveats below)
- A Hugging Face account/token with available Inference Providers credit

### Install

```bash
pip install -r requirements.txt
cp .env.example .env
# fill in HF_TOKEN, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
python wsgi.py
```

The server starts on `PORT` (default `3000`), auto-creates `patients.db` (SQLite) with schema +
2 seed patients on first run, and serves the dashboard at `/`.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `HF_TOKEN` | Yes | Hugging Face token used for Qwen inference |
| `HF_MODEL` | No (default `Qwen/Qwen2.5-7B-Instruct`) | HF model id to use |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Yes (for live calls) | Twilio credentials |
| `TWILIO_PHONE_NUMBER` | Yes (for live calls) | Number/verified caller ID to call from |
| `TWILIO_TTS_VOICE` | No (default `Polly.Joanna`) | Any Twilio-supported `<Say>` voice |
| `PORT` | No (default `3000`) | HTTP port |
| `DATABASE_PATH` | No (default `./patients.db`) | SQLite file location |

### Exposing the server to Twilio

For local development, tunnel the port (e.g. `ngrok http 3000`) and set the Twilio number's
Voice webhook to `https://<ngrok-id>.ngrok-free.app/voice/incoming` (HTTP POST). Set the status
callback URL to `https://<ngrok-id>.ngrok-free.app/voice/status`.

**Trial account caveat:** a Twilio trial account can only place outbound calls to phone numbers
that have been verified in the console (Phone Numbers → Manage → Verified Caller IDs), and this
verification can only be triggered through the Twilio Console web UI — the API explicitly
rejects verification requests from trial accounts (`error 10002`). There is also no owned
inbound phone number on a bare trial account by default; only a verified outgoing caller ID,
which cannot receive inbound calls. A real "call the number and reach the agent" test therefore
needs either a purchased Twilio number (may require a paid account depending on region/country
availability) or placing outbound calls from the verified caller ID toward other verified
numbers.

### A note on local network interception

If Python/`curl`/`ngrok` fail with `SSL: CERTIFICATE_VERIFY_FAILED` or `certificate signed by
unknown authority`, check whether antivirus software (e.g. Avast's Web/Mail Shield) is doing
TLS interception/scanning on this machine. That was the root cause hit during this project's own
setup — Python's cert store could be patched by appending the antivirus's local root certificate
to `certifi`'s bundle, but `ngrok` (a Go binary) required the antivirus's HTTPS scanning to be
disabled outright.

## Testing without a phone call

The REST API can be exercised directly:

```bash
curl -X POST http://localhost:3000/patients \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Jane","last_name":"Smith","date_of_birth":"01/01/1990","sex":"Female","phone_number":"5551234567","address_line_1":"1 Main St","city":"Boston","state":"MA","zip_code":"02108"}'

curl http://localhost:3000/patients
curl "http://localhost:3000/patients?last_name=Smith"
```

The voice agent's webhook logic can also be exercised without an actual phone call, by POSTing
the same form-encoded fields Twilio would send:

```bash
curl -X POST http://localhost:3000/voice/incoming \
  --data-urlencode "CallSid=CAtest0001" \
  --data-urlencode "From=+15551234567"

curl -X POST http://localhost:3000/voice/gather \
  --data-urlencode "CallSid=CAtest0001" \
  --data-urlencode "SpeechResult=My name is Jane Smith"
```

This returns the actual TwiML the agent would generate, driven by a real LLM call, without
needing Twilio or a real phone in the loop.

## Known limitations & trade-offs

- **Model reliability** — see the "Known model-quality issue" section above. This is the single
  biggest caveat in this codebase.
- **In-memory call state** (`app/routes/voice.py`) means the voice agent only works correctly on
  a single server process/instance — a multi-instance deployment would need call state and the
  per-call agent moved to a shared store, which is nontrivial for a live smolagents agent object
  (would likely require serializing `agent.memory.steps` rather than the agent itself).
  Twilio's built-in speech recognition and TTS were used instead of a dedicated STT/TTS vendor
  (Deepgram/ElevenLabs) to keep the stack to two vendors (Twilio + Hugging Face).
- **No phone number ownership verification** for the duplicate-detection flow — a production
  system would verify identity (e.g. DOB + last name match) before allowing an update.
- **SQLite** is fine for a single-instance demo; a real deployment with concurrent write load
  would move to PostgreSQL.
- **No HIPAA controls** (encryption at rest, audit logging, BAA) — out of scope per the
  assessment brief; do not use with real patient data.
- **Trial Twilio account constraints** documented above meant a fully live inbound phone test
  could not be completed in this environment; the REST API and the voice webhook logic were both
  validated directly instead (see "Testing without a phone call").

## Bonus features implemented

- ✅ **Duplicate detection** — `check_existing_patient` tool + prompt instructions to offer an update instead of a new record.
- ✅ **Call transcript storage** — every call's transcript is saved to the `call_transcripts` table, linked to `patient_id` when a save succeeds.
- ✅ **Dashboard** — `templates/dashboard.html`, a simple read-only patient list with last-name/phone filtering.
- ⚠️ **Multi-language** — the system prompt instructs the agent to switch to Spanish on request, but as documented above the model was observed switching languages *unprompted* as well, which is a bug, not a feature, in its current state.
- ⬜ Appointment scheduling — not implemented.
- ⬜ Automated tests — not implemented given the time box.

## Next steps (if given more time)

1. Swap the LLM layer for a model with reliable tool-calling and lower hallucination rates (OpenAI `gpt-4o-mini` function calling, or a verified-larger Qwen deployment) — highest priority given the correctness issues found.
2. Add integration tests for `app/patient_service.py` and the `/patients` routes.
3. Move call state (and a serializable form of conversation memory) to a shared store (Redis) to support horizontal scaling.
4. Add identity verification (DOB match) before allowing an "update existing patient" flow triggered purely by caller ID/phone number.
5. Migrate SQLite → PostgreSQL for multi-instance deployments.

## Security notes

- No secrets are hardcoded; everything sensitive comes from environment variables (`.env`, gitignored).
- All API input is validated and normalized server-side regardless of what the voice agent sends.
- CORS is enabled for the demo dashboard.
