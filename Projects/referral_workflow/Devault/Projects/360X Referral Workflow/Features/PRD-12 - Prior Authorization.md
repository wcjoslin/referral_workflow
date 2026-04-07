---
title: PRD-12 - Prior Authorization (Da Vinci PAS)
tags: [prd, features, fhir, prior-auth, cms-0057-f]
aliases: [PRD-12, Prior Authorization, PAS]
up: "[[📋 PRD Index]]"
---

# PRD-12: Prior Authorization Support (Da Vinci PAS)

**Status:** Ready for Dev
**Team:** Engineering
**Module:** `prd12/`
**Epic:** FHIR-Based Prior Authorization

---

## Overview

### Context

The CMS Interoperability and Prior Authorization Final Rule (CMS-0057-F) requires payers to implement FHIR-based prior authorization APIs. The Da Vinci Prior Authorization Support (PAS) Implementation Guide (HL7 FHIR US Da Vinci PAS, STU 2.2.1) defines how provider systems submit prior authorization requests and receive payer decisions using FHIR R4 resources — specifically the `Claim` and `ClaimResponse` resources with `$submit` and `$inquire` operations.

In the referral workflow, prior authorization is a **pre-gate** that occurs before a referral is sent to the specialist. The referring provider fills out patient information, submits a PA request to the payer, and only proceeds with the referral once authorization is granted. This bridges the gap between referral creation and referral transmission, ensuring that the payer has approved the intended care plan before clinical coordination begins.

The PAS IG defines an intermediary layer that converts FHIR requests to X12 278 transactions for HIPAA compliance. For this PoC, we implement a mock intermediary/payer that operates entirely in FHIR, demonstrating the provider-side workflow without X12 278 conversion.

### Goal

The primary goal of this feature is to:
1. Enable referring providers to submit FHIR-based prior authorization requests (Da Vinci PAS `$submit`) before sending a referral, using auto-populated clinical data with clinician review and edit
2. Handle all three payer decision outcomes — approved, denied, and pended — with subscription-based notifications (rest-hook) as the primary async mechanism and `$inquire` polling as fallback
3. Gate the referral workflow on PA approval so that referrals only enter the `Received` state after authorization is confirmed

### Scope

**In Scope:**
- PAS-compliant FHIR Bundle construction (`Claim` with `use: "preauthorization"`, `Patient`, `Coverage`, `Practitioner`, `Organization`, `Condition` resources)
- `$submit` operation to mock payer, returning synchronous `ClaimResponse`
- `$inquire` operation for polling pended request status
- Rest-hook subscription registration and webhook handler for async payer notifications
- Prior authorization state machine (Draft → Submitted → Approved/Denied/Pended → terminal)
- Mock payer Express sub-router with deterministic decision logic for demo scenarios
- Clinician-facing UI: auto-populated PA form (editable), status detail page, PA queue/list
- Database persistence for PA requests and responses
- Demo automation script covering approve, deny, and pend-then-approve scenarios
- Integration with demo launcher (`POST /demo/launch`)

**Out of Scope:**
- X12 278 transaction conversion (mock intermediary handles FHIR only)
- Post-encounter specialist PA requests (trigger point #2 — deferred to follow-up PRD)
- Coverage Requirements Discovery (CRD) / Documentation Templates and Rules (DTR) integration
- Real payer connectivity or authentication flows
- Clinical Data Exchange (CDex) Task-based additional information requests
- PA request updates or cancellations (`Claim Update` profile)

---

## User Stories & Acceptance Criteria

### As a referring provider, I want to submit a prior authorization request from the referral workflow so that I can obtain payer approval before sending the referral to the specialist.

**AC1:** When I navigate to the PA form for a referral, the form is pre-populated with patient demographics, diagnosis codes, and provider information from the referral's clinical data.
**AC2:** I can edit the insurer name, insurer ID, subscriber/member ID, service code (CPT/HCPCS), and provider NPI before submitting.
**AC3:** On form submission, a PAS-compliant FHIR Bundle is constructed and sent via `$submit` to the payer endpoint, and the result is displayed within 15 seconds.
**AC4:** If approved, I see the authorization number and a "Proceed with Referral" action.
**AC5:** If denied, I see the denial reason and can modify and resubmit.

### As a referring provider, I want to be notified when a pended prior authorization is resolved so that I can proceed with the referral without manual follow-up.

**AC1:** When the payer pends a request, the system registers a rest-hook subscription for that PA request.
**AC2:** The status detail page auto-polls and updates the UI when the payer sends a subscription notification with the final decision.
**AC3:** I can manually trigger a status check via `$inquire` as a fallback if the subscription notification hasn't arrived.
**AC4:** Pended requests that exceed the configured timeout transition to `Expired` state.

### As a referring provider, I want to view all prior authorization requests and their statuses so that I can manage my PA workload.

**AC1:** The PA queue page lists all requests with columns: ID, Patient, Service, Insurer, State, Submitted date, and Auth Number.
**AC2:** State badges use color coding: green (Approved), red (Denied), amber (Pended), gray (Draft), blue (Submitted).
**AC3:** Each row links to the detail page for that PA request.

---

## Technical Specifications

### Dependencies

- **Existing FHIR client patterns** (`src/modules/prd08/fhirClient.ts`) — Reuse `fetch` + `AbortController` + timeout pattern for `$submit` and `$inquire` calls
- **Existing claims state machine pattern** (`src/state/claimsStateMachine.ts`) — Follow the same const/type/transition/isValidState export pattern
- **Express server** (`src/server.ts`) — Add PA routes and mount mock payer sub-router
- **Drizzle ORM** (`src/db/schema.ts`) — Add `priorAuthRequests` and `priorAuthResponses` tables
- No new npm packages required (uses native `fetch`, existing `express`, `drizzle-orm`)

### Engineering Constraints

- Mock payer runs as an Express sub-router mounted at `/mock-payer` on the same server (port 3001), keeping everything in one process
- PA state machine is standalone — not embedded in the referral state machine. The referral workflow checks PA status as a pre-gate before allowing the referral to proceed
- FHIR Bundle construction is a pure function (no side effects, no DB access) — all data passed in as typed input
- Subscription notifications include the full PAS Response Bundle per the PAS IG specification
- UI auto-polling uses lightweight DB reads (`GET /prior-auth/:id/status`), not `$inquire`, to avoid stressing the payer. Manual `$inquire` is available as a button

### Data Models

#### Prior Authorization State Machine (`src/state/priorAuthStateMachine.ts`)

```
Draft → Submitted → Approved     (terminal)
                  → Denied       (terminal)
                  → Pended → Approved  (terminal)
                           → Denied    (terminal)
                           → Expired   (terminal)
Submitted → Error                      (terminal)
```

```typescript
export const PriorAuthState = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  PENDED: 'Pended',
  EXPIRED: 'Expired',
  ERROR: 'Error',
} as const;

export type PriorAuthState = (typeof PriorAuthState)[keyof typeof PriorAuthState];
```

#### Database Tables (added to `src/db/schema.ts`)

```typescript
// prior_auth_requests — one per PA submission
export const priorAuthRequests = sqliteTable('prior_auth_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  referralId: integer('referral_id').references(() => referrals.id),
  patientId: integer('patient_id').references(() => patients.id).notNull(),
  state: text('state').notNull().default('Draft'),
  claimJson: text('claim_json').notNull(),         // serialized FHIR Claim resource
  bundleJson: text('bundle_json'),                  // full PAS Bundle sent to payer
  insurerName: text('insurer_name').notNull(),
  insurerId: text('insurer_id').notNull(),
  serviceCode: text('service_code').notNull(),      // CPT/HCPCS code
  serviceDisplay: text('service_display'),           // human-readable service name
  providerNpi: text('provider_npi').notNull(),
  providerName: text('provider_name').notNull(),
  subscriberId: text('subscriber_id'),               // member/insurance ID
  subscriptionId: text('subscription_id'),           // payer-assigned subscription ID
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  submittedAt: integer('submitted_at', { mode: 'timestamp' }),
});

// prior_auth_responses — one per ClaimResponse received
export const priorAuthResponses = sqliteTable('prior_auth_responses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  requestId: integer('request_id').references(() => priorAuthRequests.id).notNull(),
  responseJson: text('response_json').notNull(),     // full FHIR ClaimResponse
  outcome: text('outcome').notNull(),                // 'approved' | 'denied' | 'pended'
  reviewAction: text('review_action'),               // PAS reviewAction code
  authNumber: text('auth_number'),                   // payer-assigned auth reference
  denialReason: text('denial_reason'),               // human-readable reason if denied
  itemAdjudications: text('item_adjudications'),     // JSON array of item-level decisions
  receivedVia: text('received_via').notNull(),       // 'sync' | 'subscription' | 'inquire'
  receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),
});
```

### Module Structure (`src/modules/prd12/`)

| File | Purpose |
|------|---------|
| `pasClient.ts` | FHIR client for `$submit` and `$inquire` operations. Uses `fetch` + `AbortController` + 10s timeout (pattern from `prd08/fhirClient.ts`). Posts PAS Bundles, returns typed ClaimResponse data. |
| `pasBundleBuilder.ts` | Pure function that constructs a PAS-compliant FHIR Bundle from referral + patient + form data. First entry is `Claim` (`use: "preauthorization"`), followed by `Patient`, `Coverage`, `Practitioner`, `Organization`, `Condition`. Each resource gets `urn:uuid:{guid}` fullUrl. |
| `pasResponseParser.ts` | Parses ClaimResponse Bundles. Extracts review action codes (approved/denied/pended), item-level adjudication details, auth numbers, denial reasons. Handles OperationOutcome error responses. |
| `priorAuthService.ts` | Core orchestrator. Exposes `submitPriorAuth(formData)`, `checkStatus(requestId)`, `handlePayerNotification(bundle)`. Manages DB persistence, state transitions, and subscription registration for pended responses. |
| `subscriptionService.ts` | Manages rest-hook subscription lifecycle. Registers subscription with mock payer on pended `$submit` response. Processes inbound webhook notifications. Implements `$inquire` polling fallback with configurable interval. |
| `mockPayerServer.ts` | Express sub-router mounted at `/mock-payer`. Handles `POST /Claim/$submit`, `POST /Claim/$inquiry`, and `POST /Subscription`. Deterministic decision logic by service code for demo predictability. |
| `mockPayerDemo.ts` | Demo automation script. Three scenarios: immediate approve, immediate deny, pend-then-approve via subscription. Also integrates with demo launcher. |

### FHIR PAS Bundle Structure

The `buildPasBundle()` function constructs a Bundle per the PAS IG:

1. **Claim** (first entry) — `use: "preauthorization"`, `status: "active"`, `type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/claim-type", code: "professional" }] }`, references to Patient, Practitioner, Organization (insurer), Coverage. Items with `productOrService` coding (CPT/HCPCS system). `supportingInfo` references to Condition resources.
2. **Patient** — demographics from DB `patients` table + referral data
3. **Coverage** — subscriber ID, insurer reference, patient reference
4. **Practitioner** — NPI and name from form input
5. **Organization** (insurer) — name and ID from form input
6. **Condition(s)** — extracted from referral `clinicalData` JSON (diagnoses/problems)

### Mock Payer Decision Logic

Deterministic by last digit of service code for demo predictability:

| Last Digit | Decision | Behavior |
|-----------|----------|----------|
| 0–5 | Approve | Synchronous approval with auth number |
| 6–7 | Deny | Synchronous denial with reason ("Not medically necessary" or "Out of network") |
| 8–9 | Pend | Synchronous pend response, then fires rest-hook notification after configurable delay (default 5s) with approval |

Pended claims stored in memory `Map<string, PendingClaim>`. `setTimeout` simulates async payer processing.

### API Design

#### Submit Prior Authorization

**Endpoint:** `POST /prior-auth/submit`

**Request:**
```json
{
  "referralId": 1,
  "patientId": 1,
  "insurerName": "Aetna",
  "insurerId": "60054",
  "serviceCode": "99213",
  "serviceDisplay": "Office visit, established patient",
  "providerNpi": "1234567890",
  "providerName": "Dr. Smith",
  "subscriberId": "MEM123456"
}
```

**Response (Approved):**
```json
{
  "id": 1,
  "state": "Approved",
  "outcome": "approved",
  "authNumber": "AUTH-2026-001234",
  "referralId": 1
}
```

**Response (Pended):**
```json
{
  "id": 1,
  "state": "Pended",
  "outcome": "pended",
  "message": "Request pended for review. You will be notified when a decision is made."
}
```

#### Check Status

**Endpoint:** `GET /prior-auth/:id/status`

**Response:**
```json
{
  "state": "Approved",
  "outcome": "approved",
  "authNumber": "AUTH-2026-001234",
  "denialReason": null
}
```

#### Webhook (Payer → Provider)

**Endpoint:** `POST /prior-auth/webhook`

**Request body:** Full PAS Response Bundle (FHIR Bundle containing ClaimResponse)

#### All Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/prior-auth` | PA queue/list page |
| `GET` | `/prior-auth/new?referralId=N` | Form pre-populated from referral |
| `POST` | `/prior-auth/submit` | Build bundle, call $submit, store result |
| `GET` | `/prior-auth/:id` | Detail/status page |
| `GET` | `/prior-auth/:id/status` | JSON status for UI polling |
| `POST` | `/prior-auth/:id/inquire` | Manual $inquire trigger |
| `POST` | `/prior-auth/webhook` | Inbound rest-hook notifications |

### Configuration (`src/config.ts`)

```typescript
priorAuth: {
  mockPayerBaseUrl: env('PA_MOCK_PAYER_URL', 'http://localhost:3001/mock-payer'),
  pendTimeoutMs: parseInt(env('PA_PEND_TIMEOUT_MS', '300000'), 10),       // 5 min
  inquirePollIntervalMs: parseInt(env('PA_INQUIRE_POLL_MS', '30000'), 10), // 30s
  mockPayerDelayMs: parseInt(env('PA_MOCK_DELAY_MS', '5000'), 10),        // pend resolution
},
```

---

## Test Plan

**Unit Tests:**
- `priorAuthStateMachine.test.ts` — All valid transitions succeed, all invalid transitions throw `InvalidPriorAuthStateTransitionError`, `isValidState` guard validates correctly, terminal states have no outgoing transitions
- `pasBundleBuilder.test.ts` — Bundle first entry is Claim with `use: "preauthorization"`, all internal references resolve to bundle entries, no duplicate resources, correct coding systems (CPT, claim-type), missing optional data handled gracefully
- `pasResponseParser.test.ts` — Correctly parses approved/denied/pended ClaimResponses, extracts auth numbers and denial reasons, handles OperationOutcome error responses, handles malformed responses gracefully
- `priorAuthService.test.ts` — Submit flow persists request + response in DB, pended response triggers subscription registration, state transitions are correct for all outcomes

**Integration Tests:**
- Mock payer round-trip: submit PAS Bundle → receive ClaimResponse → verify decision logic by service code
- Subscription notification: submit pended request → verify webhook fires → verify DB state updates to Approved
- API endpoint tests: POST `/prior-auth/submit` returns correct responses for approve/deny/pend scenarios

**Edge Cases:**
- Duplicate submission for same referral
- Mock payer unavailable (timeout/network error) — should transition to Error state
- Webhook notification for unknown request ID — should log warning and return 404
- Pended request exceeds timeout — should transition to Expired
- Form submission with missing required fields — should return validation error

---

## Deliverables

- `src/state/priorAuthStateMachine.ts` — PA state machine
- `src/modules/prd12/pasClient.ts` — FHIR $submit and $inquire client
- `src/modules/prd12/pasBundleBuilder.ts` — PAS Bundle constructor
- `src/modules/prd12/pasResponseParser.ts` — ClaimResponse parser
- `src/modules/prd12/priorAuthService.ts` — Core orchestrator service
- `src/modules/prd12/subscriptionService.ts` — Subscription + polling service
- `src/modules/prd12/mockPayerServer.ts` — Mock payer Express sub-router
- `src/modules/prd12/mockPayerDemo.ts` — Demo automation script
- `src/views/priorAuthForm.html` — PA submission form (auto-populated, editable)
- `src/views/priorAuthDetail.html` — PA status/detail page
- `src/views/priorAuthQueue.html` — PA queue/list page
- Updated `src/db/schema.ts` — `priorAuthRequests` and `priorAuthResponses` tables
- Updated `src/config.ts` — `priorAuth` configuration block
- Updated `src/server.ts` — PA routes, mock payer mount, navigation update
- `tests/unit/prd12/priorAuthStateMachine.test.ts`
- `tests/unit/prd12/pasBundleBuilder.test.ts`
- `tests/unit/prd12/pasResponseParser.test.ts`
- `tests/unit/prd12/priorAuthService.test.ts`

---

## Related Documents

- [[📋 PRD Index|PRD Index]]
- [[PRD-08 - FHIR Patient Lookup|PRD-08: FHIR Patient Lookup]]
- [[../Architecture/Technical Architecture|Technical Architecture]]
- [Da Vinci PAS IG](https://hl7.org/fhir/us/davinci-pas/en/)
- [Da Vinci PAS Background](https://build.fhir.org/ig/HL7/davinci-pas/en/background.html)
- [CMS-0057-F Final Rule](https://www.cms.gov/regulations-and-guidance)

---

## History

**Created:** 2026-04-05
**Last Updated:** 2026-04-05
**Version:** 1.0
