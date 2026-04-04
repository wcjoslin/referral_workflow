# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Commands

**Build, Test, Lint:**
```bash
npm run build              # Compile TypeScript to dist/
npm test                   # Run all tests (Jest)
npm run test:watch        # Run tests in watch mode
npm run test:coverage     # Run tests with coverage report
npm run lint              # Check for linting errors
npm run lint:fix          # Fix linting errors
npm run format            # Auto-format with Prettier
```

**Database & Development:**
```bash
npm run db:generate       # Generate Drizzle schema migrations
npm run db:migrate        # Run migrations on SQLite
npm run seed              # Seed demo data
npm run dev               # Run the application (ts-node)
```

**Single Test File:**
```bash
npx jest tests/unit/<path>/<file>.test.ts
```

Example: `npx jest tests/unit/referralStateMachine.test.ts`

## Project Structure

```
src/
├── index.ts                         # Main entry point (skill catalog, IMAP monitor, server startup)
├── server.ts                        # Express server (clinician UI at localhost:3001)
├── config.ts                        # Centralized config (env vars, timeouts)
├── db/
│   ├── schema.ts                    # Drizzle ORM schema (patients, referrals, messages, skill_executions)
│   ├── index.ts                     # Database initialization
│   └── migrate.ts                   # Migration runner
├── state/
│   └── referralStateMachine.ts      # Custom state machine (no third-party lib)
├── modules/
│   ├── prd01/                       # Receive and Acknowledge Referral
│   │   ├── inboxMonitor.ts          # IMAP poller
│   │   ├── messageProcessor.ts      # Inbound message processor
│   │   ├── cdaParser.ts             # C-CDA parser (uses @kno2/bluebutton)
│   │   └── mdnService.ts            # MDN (RFC 3798) generation
│   ├── prd02/                       # Process and Disposition Referral
│   │   ├── claudeService.ts         # Claude API for sufficiency validation
│   │   ├── dispositionService.ts    # Accept/Decline logic
│   │   └── rriBuilder.ts            # HL7 V2 RRI message builder
│   ├── prd03/                       # Schedule Patient and Notify Referrer
│   │   ├── resourceCalendar.ts      # Mock calendar slots
│   │   ├── schedulingService.ts     # Assignment logic
│   │   ├── siuBuilder.ts            # HL7 V2 SIU (scheduling) builder
│   │   └── mockScheduler.ts         # Auto-assigns appointments for demo
│   ├── prd04/                       # Generate and Send Final Consult Note
│   │   ├── oruParser.ts             # HL7 V2 ORU parser (mock EHR input)
│   │   ├── consultNoteService.ts    # Trigger & orchestration
│   │   ├── ccdaBuilder.ts           # C-CDA generation (xmlbuilder2)
│   │   ├── geminiConsultNote.ts     # Gemini API for note extraction
│   │   └── mockEhr.ts               # Simulates EHR sending ORU
│   ├── prd05/                       # Patient Encounter and Interim Updates
│   │   ├── adtParser.ts             # HL7 V2 ADT parser
│   │   ├── encounterService.ts      # Encounter state transition
│   │   └── mockEncounter.ts         # Simulates appointment trigger
│   ├── prd06/                       # Acknowledge Final Report and Close Loop
│   │   ├── ackParser.ts             # Inbound ACK parser
│   │   ├── ackService.ts            # ACK processing & state closure
│   │   └── mockReferrer.ts          # Auto-ACKs all messages for demo
│   ├── prd07/                       # Referrer-Side Acknowledgment Tracking
│   │   └── overdueChecker.ts        # Detects missing ACKs
│   ├── prd08/                       # FHIR Patient Lookup and Clinical Data Enrichment
│   │   ├── fhirClient.ts            # HAPI FHIR integration
│   │   ├── fhirEnrichment.ts        # Fetch and merge FHIR data
│   │   └── fhirConsultNote.ts       # FHIR-enriched consult notes
│   ├── prd09/                       # AI-Powered Rules Engine with Agent Skills
│   │   ├── skillLoader.ts           # Load YAML skill definitions from disk
│   │   ├── skillEvaluator.ts        # Evaluate skill conditions (deterministic + Gemini)
│   │   ├── skillGenerator.ts        # Generate skill prompts
│   │   ├── skillActions.ts          # Execute skill actions
│   │   ├── infoRequestService.ts    # Request missing info (Pending-Information state)
│   │   └── pendingInfoChecker.ts    # Timeout-based info request expiry
│   └── claims/                      # X12 Claims Attachment Workflow (CMS-0053-F)
│       ├── ediWatcher.ts            # File watcher for inbound 277 EDI files
│       ├── x12_277Parser.ts         # Parse X12N 277 payer requests
│       ├── x12_275Builder.ts        # Build X12N 275 attachment responses
│       ├── claimsStateMachine.ts    # Claims state machine (Received → Sent)
│       ├── loincMapper.ts           # Map LOINC codes to C-CDA document types
│       └── claimsCcdaBuilder.ts     # C-CDA generation for attachment responses
├── types/
│   └── bluebutton.d.ts              # Type definitions for C-CDA parsing
├── scripts/
│   ├── seed-demo.ts                 # Populate database with demo referral
│   ├── seed-claims-demo.ts          # Generate 4 demo X12 277 EDI files in claims-inbox/
│   ├── demo-scenarios.ts            # 4 scenario launchers used by /demo/launch route
│   ├── demo-skills.ts               # Evaluate PRD-09 skills against seeded referrals
│   └── node-polyfill.js             # Polyfill for bluebutton in Node.js
claims-inbox/                        # File-watch directory for inbound X12 277 EDI files
claims-outbox/                       # Output directory for outbound X12 275 responses

tests/
├── setup.ts                         # Jest setup
├── __mocks__/
│   └── bluebutton.stub.ts           # Mock for webpack-bundled @kno2/bluebutton
└── unit/
    └── [module-tests organized by PRD]
```

## Architecture Overview

### State Machine (Custom TypeScript)

All referrals follow this deterministic lifecycle:
```
Received → Acknowledged → [Accepted | Declined | Pending-Information]
                              ↓
                          [Scheduled → Encounter → Closed → Closed-Confirmed]
Pending-Information → Acknowledged (info received) | Declined (timeout)
```

Located in [src/state/referralStateMachine.ts](src/state/referralStateMachine.ts). All state changes **must** go through the `transition()` function. Terminal states: `Declined`, `Closed-Confirmed`.

### Key Design Decisions

1. **No LangGraph** — Custom TypeScript state machine + direct Anthropic SDK only where AI reasoning is needed (PRD-02, PRD-04, PRD-09).
2. **MDN is RFC 3798 (email format)** — Built with `nodemailer` as a multipart/report reply, not HL7 V2.
3. **HL7 V2 & C-CDA** — Uses `hl7` (npm) for parsing and `xmlbuilder2` for building.
4. **C-CDA Parsing** — `@kno2/bluebutton` is webpack-bundled (requires polyfill in Jest, see [jest.config.ts](jest.config.ts) moduleNameMapper).
5. **Database** — SQLite + Drizzle ORM; schema in [src/db/schema.ts](src/db/schema.ts). Core entities: `patients`, `referrals`, `outboundMessages`, `skillExecutions`, `attachmentRequests`, `attachmentResponses`.
6. **Demo Automation** — Four mock scripts automate non-clinician steps:
   - `mockReferrer.ts` — sends initial referral & auto-ACKs all inbound messages
   - `mockScheduler.ts` — auto-assigns appointment slots
   - `mockEncounter.ts` — triggers encounter when appointment time elapses
   - `mockEhr.ts` — sends clinical data to trigger consult note generation
7. **PRD-09 Agent Skills** — YAML+Markdown files with optional TypeScript scripts and JSON/MD assets. Progressive disclosure (Tier 1: name+description, Tier 2: full SKILL.md, Tier 3: scripts/assets). Deterministic scripts run first; fallback to Gemini 2.5-Flash. Most restrictive action wins in conflicts.
8. **X12 Claims Attachment (CMS-0053-F)** — EDI 277 files dropped in `claims-inbox/` are watched by `startEdiWatcher()` in `index.ts`, parsed via `node-x12`, matched to FHIR patient records, C-CDA documents generated per LOINC code, and returned as 275 responses. State machine mirrors the referral pattern. In active development.

### Email Transport

- **Outbound**: `nodemailer` SMTP
- **Inbound**: `imapflow` IMAP polling in [src/modules/prd01/inboxMonitor.ts](src/modules/prd01/inboxMonitor.ts) — polls every 30s by default.

### UI & Manual Fallbacks

Express server at `localhost:3001` provides:
- Clinician review interface (PRD-02: Accept/Decline decision — intentionally manual)
- Fallback buttons for PRD-03/05/06 when mock scripts unavailable

## Testing

**Coverage thresholds** (enforced): 80% lines/functions, 70% branches.

Test structure:
- **Unit tests** in `tests/unit/` organized by module (prd01, prd02, etc.)
- **Setup** in [tests/setup.ts](tests/setup.ts)
- **Mocks** in [tests/__mocks__/](tests/__mocks__/) — includes `bluebutton.stub.ts` for Jest compatibility

**Run a single test:**
```bash
npx jest tests/unit/prd02/claudeService.test.ts
```

**Watch mode:**
```bash
npm run test:watch
```

## Configuration

All config is centralized in [src/config.ts](src/config.ts). Environment variables:
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD` — IMAP credentials
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` — outbound email
- `ANTHROPIC_API_KEY` — Claude API (PRD-02)
- `GEMINI_API_KEY` — Gemini API (PRD-04, PRD-09)
- `FHIR_BASE_URL` — HAPI FHIR endpoint (PRD-08)
- `DATABASE_URL` — SQLite path (default: `./referral.db`)
- `PORT` — Express server port (default: `3000`)
- `SKILLS_DIR` — skill definitions directory (default: `./skills`)
- `CLAIMS_WATCH_DIR` / `CLAIMS_OUTBOUND_DIR` — EDI file-watcher directories (default: `./claims-inbox`, `./claims-outbox`)

## PRD Workflow Pattern

Each PRD (Product Requirement Document) is implemented as:
1. **Trigger** — module that detects the condition (e.g., inbound message, timeout, appointment time)
2. **Logic** — service that processes and updates the referral state
3. **Output** — message builder (RRI, SIU, C-CDA, MDN, etc.) or state transition
4. **Testing** — unit tests for core logic, mocks for external systems

Example: PRD-01 (Receive) →
- Trigger: `inboxMonitor.ts` detects new email
- Logic: `messageProcessor.ts` parses C-CDA, extracts patient/reason
- Output: `mdnService.ts` sends MDN acknowledgment
- State: transition to `Acknowledged`

## Common Tasks

**Add a new skill (PRD-09):**
1. Create a directory under `skills/` (e.g., `skills/my-skill-name/`) containing:
   - `SKILL.md` — YAML frontmatter (name, description, trigger-point, action-type, confidence-threshold, priority, active) + markdown evaluation steps
   - `scripts/check-*.ts` (optional) — deterministic `check(clinical, assets)` function; return `{resolved, matched?, explanation?}`
   - `assets/*.json` (optional) — facility config (e.g., approved payers list)
2. `skillLoader.ts` will auto-detect the directory on startup or via file watcher (chokidar).
3. Skill evaluation happens at trigger points: `post-intake`, `post-acceptance`, `encounter-complete`.
4. Deterministic script runs first; if `resolved: false`, falls back to Gemini 2.5-Flash evaluation.

**Add a database migration:**
1. Edit [src/db/schema.ts](src/db/schema.ts)
2. Run `npm run db:generate` to create migration files
3. Run `npm run db:migrate` to apply

**Debug IMAP/SMTP issues:**
- Check [src/config.ts](src/config.ts) for mailbox credentials
- Logs are printed to stdout (no log file by default)
- `inboxMonitor.ts` will retry if IMAP fails; server stays up

**Run the full demo:**
1. `npm run seed` — populate database
2. `npm run dev` — start server and IMAP monitor
3. Visit `localhost:3001` to see the UI
4. Mock scripts will auto-execute on defined triggers (or trigger manually from UI)

## Documentation & Planning

All product and engineering planning docs live in the **`Devault/`** Obsidian vault at the project root. This is the canonical location — not markdown files scattered in the repo root.

**Templates** (in `Devault/Templates/`):
- **PRD Template.md** — for major workflow modules. Sections: Context, Goal, Scope, User Stories + Acceptance Criteria, Technical Specs (data models, APIs), Test Plan, Deliverables, Related Docs.
- **Feature Template.md** — for lighter enhancements. Sections: Context, Goal, User Stories, Acceptance Criteria, optional Technical Specs.

**Where things live:**
- PRDs: `Devault/Projects/360X Referral Workflow/Features/` (PRD-01 through PRD-11)
- Engineering specs: `Devault/Projects/360X Referral Workflow/Engineering/`
- PRD registry/roadmap: `Devault/Projects/360X Referral Workflow/Features/📋 PRD Index.md`
- Architecture: `Devault/Projects/360X Referral Workflow/Architecture/`
- Backlog & ideas: `Devault/Projects/360X Referral Workflow/Backlog & Ideas/`

**Rule:** All new PRDs and features must be documented in the vault using the appropriate template **before implementation begins**. Add new PRDs to the PRD Index.

## Performance & Linting

- **Strict TypeScript** — `strict: true` in [tsconfig.json](tsconfig.json)
- **ESLint** — enforces no `any`, unused vars (args starting with `_` allowed), explicit return types on functions
- **Prettier** — auto-format with `npm run format`
- **Coverage** — 80% threshold; run `npm run test:coverage` to see gaps
