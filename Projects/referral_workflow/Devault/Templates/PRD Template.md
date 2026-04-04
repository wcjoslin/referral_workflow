---
title: PRD Template
tags: [template, prd]
aliases: [New PRD Template]
up: "[[_INDEX]]"
---

# PRD Template

Use this template when creating a new Product Requirements Document.

---

## PRD-{{Number}}: {{Feature Name}}

**Status:** {{Approved | Drafting | Ready for Dev | In Progress | Done}}  
**Team:** {{Responsible Team}}  
**Module:** `{{module-name}}/`  
**Epic:** {{Optional: Link to epic}}

---

## Overview

### Context

_Explain the background and motivation for this PRD. What problem does it solve? What led to this requirement?_

### Goal

_Clearly state the primary objective or outcomes of this PRD._

The primary goal of this feature is to:
1. {{Goal 1}}
2. {{Goal 2}}
3. {{Goal 3}}

### Scope

**In Scope:**
- {{Scope item 1}}
- {{Scope item 2}}
- {{Scope item 3}}

**Out of Scope:**
- {{Out of scope item 1}}
- {{Out of scope item 2}}

---

## User Stories & Acceptance Criteria

### As a {{User Type}}, I want {{action}} so that {{outcome}}...

**AC1:** {{Specific, testable condition}}  
**AC2:** {{Specific, testable condition}}  
**AC3:** {{Specific, testable condition}}

### As a {{User Type}}, I want {{action}} so that {{outcome}}...

**AC1:** {{Specific, testable condition}}  
**AC2:** {{Specific, testable condition}}

---

## Technical Specifications

### Dependencies

- {{Technology/Library Name}} — Purpose and justification
- {{Technology/Library Name}} — Purpose and justification

### Engineering Constraints

- {{Constraint 1}}
- {{Constraint 2}}
- {{Constraint 3}}

### Data Models

_If applicable, describe database schema, API models, or data structures._

```typescript
// Example TypeScript interface
interface {{EntityName}} {
  {{property}}: {{type}};
  {{property}}: {{type}};
}
```

### API Design (if applicable)

**Endpoint:** `POST /{{resource}}/{{action}}`

**Request:**
```json
{
  "field": "value"
}
```

**Response:**
```json
{
  "id": "123",
  "status": "success"
}
```

---

## Test Plan

**Unit Tests:**
- {{Test scenario 1}}
- {{Test scenario 2}}
- {{Test scenario 3}}

**Integration Tests:**
- {{Full workflow test 1}}
- {{Full workflow test 2}}

**Edge Cases:**
- {{Edge case 1}}
- {{Edge case 2}}

---

## Deliverables

- {{Deliverable 1 (e.g., module file, component, service)}}
- {{Deliverable 2}}
- {{Deliverable 3}}
- {{Test files}}

---

## Related Documents

- [[../Features/📋 PRD Index|PRD Index]]
- [[Other related PRD|Link to related]]
- [[../Architecture/Technical Architecture|Architecture]]

---

## History

**Created:** {{Date}}  
**Last Updated:** {{Date}}  
**Version:** {{Version number}}

