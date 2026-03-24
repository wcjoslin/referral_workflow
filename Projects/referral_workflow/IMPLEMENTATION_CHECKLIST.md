# Implementation Checklist

This document is the single source of truth for implementation readiness across all PRDs. Each PRD section uses the standard Per-PRD template below, extended with PRD-specific items. Engineering architecture documents (`ENGINEERING-PRD-XX.md`) must be drafted and approved before any coding begins on that PRD.

---

## Phase 0: Project Setup
*One-time setup before any PRD coding begins.*

### Repository & Tooling
- [x] TypeScript project initialized (`tsconfig.json` with `strict: true`)
- [x] `package.json` configured with scripts: `build`, `test`, `lint`, `dev`
- [x] ESLint configured with TypeScript-aware rules (`@typescript-eslint`)
- [x] Prettier configured and integrated with ESLint
- [x] Jest + `ts-jest` configured (`jest.config.ts`)
- [x] `.env.example` created with all required keys documented
- [ ] `.env` added to `.gitignore`
- [x] `src/config.ts` module created to load and validate all env vars at startup (fail fast if required vars are missing)

### Project Structure
- [x] Folder structure established:
  ```
  src/
    config.ts
    db/
      schema.ts        # Drizzle schema (all tables)
      index.ts         # DB connection singleton
    state/
      referralStateMachine.ts
    modules/
      prd01/           # One folder per PRD
      prd02/
      ...
    mocks/
      mockReferrer.ts
      mockScheduler.ts
      mockEncounter.ts
      mockEhr.ts
  tests/
    unit/
    integration/
    fixtures/          # Sample C-CDA files, HL7 messages
  ```

### Infrastructure
- [ ] Mock Direct Gateway running locally (e.g., [Mailtrap](https://mailtrap.io/) sandbox or local [Mailhog](https://github.com/mailhog/MailHog))
- [ ] SMTP/IMAP credentials stored in `.env`
- [x] `drizzle-orm` and `drizzle-kit` installed
- [x] `db/schema.ts` written with `patients`, `referrals`, and `outbound_messages` tables (defined in `ENGINEERING-PRD-01.md` Section 7)
- [x] Initial Drizzle migration generated (`drizzle-kit generate`) and applied
- [x] Sample C-CDA Referral Note test files downloaded from [HL7 C-CDA Examples](https://github.com/HL7/C-CDA-Examples) and placed in `tests/fixtures/`

---

## Per-PRD Checklist Template
*Applied to every PRD. PRD-specific items listed in sections below.*

### Architecture Gate *(complete before writing any code)*
- [ ] `ENGINEERING-PRD-XX.md` drafted
- [ ] Architecture reviewed and approved
- [ ] All new dependencies identified and justified
- [ ] Data model / schema changes defined
- [ ] Function signatures and internal API design agreed upon

### Dependencies
- [ ] All new npm packages installed and added to `package.json`
- [ ] No unnecessary dependencies introduced

### Data Layer
- [ ] Schema changes (if any) defined in `db/schema.ts`
- [ ] Drizzle migration generated and tested
- [ ] All DB access goes through Drizzle query builder — no raw SQL
- [ ] Schema changes do not break existing PRD functionality

### Implementation Standards
- [ ] All code in TypeScript — zero `any` types, strict mode enforced
- [ ] All configuration via `.env` — nothing hardcoded (URLs, credentials, ports, timeouts, intervals)
- [ ] Error handling implemented for all expected failure modes defined in the PRD's acceptance criteria
- [ ] Key workflow events logged (message received, state transitions, errors)
- [ ] All state transitions go through `referralStateMachine.ts` — no ad-hoc `state` updates
- [ ] State transitions persisted to `referrals.state` in the DB immediately on change

### HL7 / C-CDA Standards
- [ ] All outbound HL7 V2 messages validated before sending
- [ ] `Message Control ID` (MSH-10) logged to `outbound_messages` table for every outbound HL7 message
- [ ] All outbound C-CDA documents validated against schema before sending
- [ ] MDN sent as `multipart/report` (RFC 3798) — not as HL7

### Testing
- [ ] Unit tests written for all pure functions (parsers, validators, message builders)
- [ ] Tests cover: happy path + key edge cases + all error conditions in the PRD's acceptance criteria
- [ ] Integration test covers the full PRD flow end-to-end using the mock gateway
- [ ] Mock scripts (where applicable) have their own isolated unit tests
- [ ] All pre-existing tests still pass (`jest` clean run with no skips)
- [ ] No tests marked `.only` or `.skip` in committed code

### Definition of Done
- [ ] Every acceptance criterion in the PRD has a corresponding passing test
- [ ] `tsc --noEmit` passes with zero errors
- [ ] ESLint passes with zero warnings
- [ ] All tests pass

---

## PRD-01: Receive and Acknowledge Referral

> **Architecture:** Approved — see `ENGINEERING-PRD-01.md`
> **Note:** PRD-01 is intentionally stateless. The SQLite + Drizzle persistence layer must be initialized during this phase (see Phase 0) to be ready for PRD-02.

### PRD-01 Specific — Setup
- [x] `@kno2/bluebutton`, `nodemailer`, `imapflow` installed
- [ ] Mock gateway (Mailtrap or Mailhog) configured; credentials in `.env`
- [ ] Sample Referral Note C-CDA from `tests/fixtures/` confirmed parseable by `@kno2/bluebutton`

### PRD-01 Specific — Implementation
- [x] `inboxMonitor.ts` polls IMAP inbox on configurable interval via `imapflow`
- [x] `messageProcessor.ts` extracts sender address and `Message-ID` header from inbound email
- [x] `cdaParser.ts` uses `@kno2/bluebutton` to extract patient first name, last name, DOB, and reason for referral
- [x] `mdnService.ts` sends RFC 3798 compliant `multipart/report` MDN via `nodemailer`
- [x] MDN `Original-Message-ID` field set to the inbound email's `Message-ID`
- [x] Processed `Message-ID`s tracked in-memory (`Set`) and persisted to a local file on shutdown to prevent reprocessing on restart
- [x] Missing C-CDA attachment: MDN still sent, internal error logged, `isCdaValid: false`
- [x] Malformed C-CDA: `try/catch` around parser, error logged, `isCdaValid: false`

### PRD-01 Specific — Testing
- [x] Unit: `parseCda()` correctly extracts name, DOB, reason for referral from sample C-CDA fixture
- [x] Unit: `parseCda()` returns `isCdaValid: false` for a malformed C-CDA
- [x] Unit: `mdnService` constructs a valid `multipart/report` with correct `Original-Message-ID`, `Final-Recipient`, and `Disposition` headers
- [x] Unit: `messageProcessor` handles email with no attachment — logs error, still triggers MDN
- [ ] Integration: place test email with C-CDA attachment in mock inbox → MDN returned to sender within timeout → `ReferralData` logged to console

---

## PRD-02: Process and Disposition Referral

> **Architecture:** Approved — see `ENGINEERING-PRD-02.md`

### PRD-02 Specific — Prerequisite
- [x] SQLite + Drizzle schema initialized and migration applied (Phase 0)

### PRD-02 Specific — Implementation
- [x] Auto-decline: validates presence of all required C-CDA sections; auto-generates `RRI^I12` rejection if incomplete
- [x] Clinician Review UI: displays patient demographics, reason for referral, problems/allergies/meds, diagnostic results
- [x] Missing optional sections flagged in UI (not blocking, but visible)
- [x] Gemini API (`@google/generative-ai`) call: evaluates clinical sufficiency of C-CDA content; result persisted to DB
- [x] Accept/Decline UI action: captures decision, clinician ID, and timestamp — written to `referrals` table
- [x] Decline reason: selected from predefined list or free-text input
- [x] `RRI^I12` generated for Accept (AA) and Decline (AR) — reason populated on decline
- [x] RRI transmitted via mock Direct gateway; `Message Control ID` logged to `outbound_messages`
- [x] State transition: `Acknowledged` → `Accepted` or `Declined`

### PRD-02 Specific — Testing
- [x] Unit: auto-decline fires correctly for a C-CDA missing required sections
- [x] Unit: `RRI^I12` message built correctly for Accept and Decline cases
- [x] Unit: Gemini API returns a structured sufficiency verdict from sample C-CDA input
- [ ] Integration: full flow — valid referral in DB → clinician clicks Accept → RRI sent → state updated to `Accepted`
- [ ] Integration: auto-decline flow — incomplete C-CDA arrives → auto-rejected → RRI sent → state updated to `Declined`

---

## PRD-03: Schedule Patient and Notify Referrer

> **Architecture:** Approved — see `ENGINEERING-PRD-03.md`

### PRD-03 Specific
- [x] `mockScheduler.ts` auto-assigns appointment slot on `Accepted` state transition
- [x] Scheduler UI: manual fallback for entering date, time, location, and assigned clinician
- [x] Resource/asset conflict detection against a mock availability calendar
- [x] `SIU^S12` generated with all required segments (MSH, SCH, PID)
- [x] SIU transmitted via mock Direct gateway; `Message Control ID` logged to `outbound_messages`
- [x] State transition: `Accepted` → `Scheduled`
- [x] Unit: `SIU^S12` built correctly with all required segments
- [x] Unit: scheduling conflict correctly detected against mock calendar
- [ ] Integration: `mockScheduler.ts` fires on acceptance → SIU sent → state updated to `Scheduled`

---

## PRD-04: Generate and Send Final Consult Note

> **Architecture:** Not yet written — draft `ENGINEERING-PRD-04.md` before coding begins.

### PRD-04 Specific *(preliminary — finalize after architecture approval)*
- [ ] `mockEhr.ts` sends `ORU^R01` with clinical note text for a given referral ID
- [ ] `ORU^R01` listener running on configurable port (separate from Direct inbox monitor)
- [ ] Claude API (`@anthropic-ai/sdk`) call: structures free-text note into Consult Note C-CDA sections (Assessment, Plan, Chief Complaint, etc.)
- [ ] Consult Note C-CDA generated using `xmlbuilder2` and validated against schema before sending
- [ ] C-CDA transmitted via mock Direct gateway
- [ ] Manual "Sign & Send Consult Note" UI fallback available
- [ ] Trigger layer implemented as a replaceable module (manual input and ORU listener share the same downstream pipeline)
- [ ] State transition: `Encounter` → `Closed`
- [ ] Unit: `ORU^R01` parsed correctly, clinical note text extracted
- [ ] Unit: Claude API structures sample note text into correct C-CDA sections
- [ ] Unit: generated C-CDA passes schema validation
- [ ] Integration: `mockEhr.ts` sends ORU → C-CDA generated and transmitted → state updated to `Closed`

---

## PRD-05: Patient Encounter and Interim Updates

> **Architecture:** Approved — see `ENGINEERING-PRD-05.md`

### PRD-05 Specific
- [x] `mockEncounter.ts` sends `ADT^A04` after configurable delay from scheduled appointment time
- [x] `ADT^A04` listener processes event and triggers state transition
- [x] Manual "Mark Encounter Complete" UI fallback available
- [x] Optional interim Direct Secure Message generated and sent if enabled
- [x] Interim message transmission logged against the referral record
- [x] State transition: `Scheduled` → `Encounter`
- [x] Unit: `ADT^A04` parsed correctly, referral ID extracted
- [x] Unit: state transitions correctly from `Scheduled` to `Encounter`
- [ ] Integration: `mockEncounter.ts` fires → state updated to `Encounter` → optional interim message sent

---

## PRD-06: Acknowledge Final Report and Close Loop

> **Architecture:** Not yet written — draft `ENGINEERING-PRD-06.md` before coding begins.

### PRD-06 Specific *(preliminary — finalize after architecture approval)*
- [ ] `mockReferrer.ts` auto-ACKs all inbound messages (RRI, SIU, Consult Note C-CDA)
- [ ] Inbound `ACK` parser extracts `Message Control ID` from `MSA` segment
- [ ] `Message Control ID` correlated to matching row in `outbound_messages` table
- [ ] Matched message status updated: `Pending` → `Acknowledged`; `acknowledgedAt` timestamp recorded
- [ ] Unmatched ACK logged without changing referral state
- [ ] State transition: `Closed` → `Closed-Confirmed`
- [ ] Unit: `ACK` message parsed, `Message Control ID` extracted from `MSA`
- [ ] Unit: correlation logic matches ACK to correct `outbound_messages` row
- [ ] Unit: unmatched ACK handled safely without state change
- [ ] Integration: `mockReferrer.ts` sends ACK for Consult Note → `outbound_messages` status updated → state updated to `Closed-Confirmed`

---

## PRD-07: Referrer-Side Acknowledgment Tracking

> **Architecture:** Not yet written — draft `ENGINEERING-PRD-07.md` before coding begins.

### PRD-07 Specific *(preliminary — finalize after architecture approval)*
- [ ] `outbound_messages` table confirmed to include `messageType`, `status`, `sentAt`, `acknowledgedAt` (already in schema)
- [ ] All outbound message modules (RRI, SIU, Consult Note) confirmed to log `Message Control ID` to `outbound_messages`
- [ ] "Message History" UI view built: displays per-referral message log with type, timestamp, and `Pending`/`Acknowledged` status
- [ ] `node-cron` background job runs on configurable schedule (default: daily) to flag messages `Pending` beyond configurable threshold (default: 48h)
- [ ] Flagged messages surfaced in the UI for manual follow-up
- [ ] Unit: background job correctly identifies overdue `Pending` messages
- [ ] Unit: messages acknowledged within threshold are not flagged
- [ ] Integration: full lifecycle — RRI sent → ACK received → status `Acknowledged`; SIU sent → no ACK → job flags it as overdue
