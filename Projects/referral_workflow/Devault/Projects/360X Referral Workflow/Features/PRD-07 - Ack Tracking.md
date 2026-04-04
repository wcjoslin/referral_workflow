---
up: "[[📋 PRD Index]]"
prev: "[[PRD-06 - Close Loop]]"
---

# PRD-07: Referrer-Side Acknowledgment Tracking

**Status:** Approved ✅  
**Team:** Clinical Workflow & Integration  
**Module:** `prd07/`

---

## Context

The 360X workflow is a conversational state machine. While our system sends key updates at various stages (disposition, scheduling, final report), a truly robust and auditable system must also track the *receipt* of these messages by the referring provider. This is typically handled by the referrer's system sending back `HL7 V2 ACK` messages.

This PRD describes a cross-cutting feature to track the acknowledgment status for all critical outbound communications. It consolidates the acknowledgment logic ([[PRD-06 - Close Loop|PRD-06]]) and applies it to other messages sent by our system, providing a complete audit trail of the conversation.

## Goal

The primary goal is to implement a generic acknowledgment tracking mechanism that will:

1. Log every critical outbound message sent to the referring provider
2. Listen for and correlate inbound `HL7 V2 ACK` messages to the specific outbound messages
3. Provide visibility into the acknowledgment status of each step in the referral workflow
4. Optionally, flag messages that have not been acknowledged within a specified timeframe

## User Stories

- As a **System Administrator**, I want a single view where I can see the full message history for a referral, including whether each message was acknowledged, so I can troubleshoot communication failures
- As a **System**, for every outbound message (`RRI`, `SIU`, Consult Note), I want to track if a corresponding acknowledgment (`ACK`) has been received
- As a **System**, I want to flag referrals where an important message (like the final consult note) has not been acknowledged within 48 hours, so that a manual follow-up can be initiated

## Acceptance Criteria

- **AC1:** The system must log the `Message Control ID` (from `MSH-10`) for every outbound `RRI^I12` ([[PRD-02 - Process & Disposition|PRD-02]]), `SIU^S12` ([[PRD-03 - Schedule Patient|PRD-03]]), and Consult Note ([[PRD-04 - Generate Consult Note|PRD-04]]) message
- **AC2:** The system shall use the `ACK` processing logic defined in [[PRD-06 - Close Loop|PRD-06]] to receive and parse inbound `HL7 V2 ACK` messages
- **AC3:** The system must update the status of the corresponding outbound message to "Acknowledged" upon receipt of a valid `ACK`
- **AC4:** A new "Message History" view shall be created, associated with each referral, that displays each outbound message, its timestamp, and its acknowledgment status (`Pending` or `Acknowledged`)
- **AC5:** The system shall include a background process that runs daily to identify any outbound messages that are still `Pending` after a configurable duration (e.g., 48 hours) and flag them for review

## Technical Specifications

**Dependencies:**
- **HL7 V2 Parser:** The same library used in [[PRD-06 - Close Loop|PRD-06]] for parsing `ACK` messages
- **Message Correlation Store:** The mechanism from [[PRD-06 - Close Loop|PRD-06]] to map `Message Control ID`s to referral IDs must be extended to also map to the specific message type (`RRI`, `SIU`, etc.). This could be a single table with columns for `ReferralID`, `MessageControlID`, `MessageType`, `Status` (`Pending`/`Acknowledged`), and `Timestamp`
- **Background Job Scheduler:** **`node-cron`** (Node.js/TypeScript) to run the check for unacknowledged messages

**Engineering Constraints:**
- This feature should build upon the inbound listening and `ACK` parsing logic developed for [[PRD-06 - Close Loop|PRD-06]] to avoid redundant work
- The data model must be designed to efficiently query for unacknowledged messages

**Test Plan:**
- Unit tests to verify that outbound messages of all types (`RRI`, `SIU`, etc.) have their `Message Control ID` correctly logged
- Integration test to simulate a full referral lifecycle:
  1. Send an `RRI` message
  2. Receive an `ACK` and verify the `RRI` is marked as "Acknowledged"
  3. Send an `SIU` message
  4. Do *not* send an `ACK`
  5. Run the background job and verify that the `SIU` message is correctly flagged as overdue
  6. Send the final Consult Note, receive the `ACK`, and verify it is marked "Acknowledged"

**Deliverables:**
- Updates to the `RRI` and `SIU` sending modules to log `Message Control ID`s
- A new data table or model for tracking message acknowledgment status
- A "Message History" UI component
- A background job for flagging overdue acknowledgments

---

## Related Documents

- [[📋 PRD Index|See all PRDs]]
- [[PRD-06 - Close Loop|Previous: PRD-06]]
- [[🎯 PROJECT OVERVIEW|Back to Project Overview]]
