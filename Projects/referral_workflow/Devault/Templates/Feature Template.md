---
title: Feature Template
tags: [template]
aliases: [New Feature Template]
up: "[[_INDEX]]"
---

# Feature Template

Use this template when planning or documenting a new feature.

---

## {{Feature Name}}

**Status:** {{Drafting | Ready for Dev | In Progress | Done}}  
**Team:** {{Responsible Team}}  
**Epic:** {{Optional: Link to epic}} 
**Priority:** {{Low | Medium | High | Critical}}

### Context

_Explain the "why" behind this feature. What background information or user problems led to this? This section sets the stage._

---

### Goal

_State the primary objective or outcome of this feature clearly and concisely._

- {{Goal 1}}
- {{Goal 2}}
- {{Goal 3}}

---

### User Stories

_Capture the specific needs of the user. Every user story should follow this exact format:_

- As a {{type of user}}, I want to {{perform some action}} so that I can {{achieve some goal}}.
- As a {{type of user}}, I want to {{perform some action}} so that I can {{achieve some goal}}.
- As a {{type of user}}, I want to {{perform some action}} so that I can {{achieve some goal}}.

---

### Acceptance Criteria

_Define what "done" means. Each criterion should be a clear, testable, pass/fail statement._

- **AC1:** {{Specific testable condition}}
- **AC2:** {{Specific testable condition}}
- **AC3:** {{Specific testable condition}}
- **AC4:** {{Specific testable condition}}

---

## Technical Specifications

_Include these sections if applicable to a more complex feature:_

### Dependencies

- {{Dependency 1}} — Purpose and version
- {{Dependency 2}} — Purpose and version

### Engineering Constraints

- {{Constraint 1}}
- {{Constraint 2}}

### Test Plan

- **Unit Tests:** {{What to test}}
- **Integration Tests:** {{What to test}}
- **Edge Cases:** {{Notable scenarios}}

### Deliverables

- {{Deliverable 1}} — Description
- {{Deliverable 2}} — Description
- {{Deliverable 3}} — Description

---

## Design Notes

_Optional: Add any design sketches, diagrams, or additional context here._

---

## Related Documents

- [[../Ideas|Ideas & Backlog]]
- [[In Progress|In Progress Work]]
- {{Other related features or PRDs}}

---

## How to Use This Template

1. Copy this entire file
2. Rename it to match your feature (e.g., `Feature - Search and Filter`)
3. Fill in all `{{placeholder}}` sections
4. Add it to the appropriate folder structure
5. Link it from [[../Ideas|Ideas.md]] or [[In Progress|In Progress.md]]
