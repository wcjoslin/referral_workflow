---
title: Tools & Resources
tags: [reference, resources, links]
up: "[[_INDEX]]"
---

# 📚 Tools & Resources

A reference guide to key tools, resources, and external links used in the 360X Referral Workflow project.

---

## Healthcare Standards & Frameworks

### Direct Secure Messaging
- **[DirectTrust](https://www.directtrust.org/)** — Official Direct governance organization
- **[ONC Direct Secure Messaging](https://www.healthit.gov/topic/direct-secure-messaging)** — U.S. Official Definition
- **[360X Protocol Guide](https://www.youtube.com/watch?v=3u_9XU56gP8)** — Official 360X Guide

### HL7 Standards

#### C-CDA (Clinical Document Architecture)
- **[HL7 C-CDA Examples Repository](https://github.com/HL7/C-CDA-Examples)** — Official examples for referral documents
- **[Synthea](https://synthea.mitre.org/)** — Synthetic patient generator for C-CDA test data
- **[CHB Sample C-CDAs](https://github.com/chb/sample_ccdas)** — Real-world EHR vendor samples

#### HL7 V2
- **[HL7 V2 Standard](https://www.hl7.org/implement/standards/product_brief.cfm?product_id=5)** — Official specification
- **[REF, RRI, SIU, ACK Messages](https://www.hl7.org/implement/standards/refstandards.cfm)** — Message type documentation

### FHIR
- **[HAPI FHIR](https://hapifhir.io/)** — Open-source FHIR server implementation
- **[FHIR Patient Resource](https://www.hl7.org/fhir/patient.html)** — Patient data specification
- **[FHIR Appointment Resource](https://www.hl7.org/fhir/appointment.html)** — Scheduling specification

---

## JavaScript/TypeScript Libraries

### C-CDA & Healthcare Data Parsing

| Library | Purpose | Link |
|---------|---------|------|
| **@kno2/bluebutton** | C-CDA to JSON parser | [npm](https://www.npmjs.com/package/@kno2/bluebutton) |
| **hl7** | HL7 V2 parser/generator | [npm](https://www.npmjs.com/package/hl7) |
| **xmlbuilder2** | XML document builder | [npm](https://www.npmjs.com/package/xmlbuilder2) |

### Email & Transport

| Library | Purpose | Link |
|---------|---------|------|
| **nodemailer** | SMTP email sending | [npm](https://www.npmjs.com/package/nodemailer) |
| **imapflow** | IMAP email polling | [npm](https://www.npmjs.com/package/imapflow) |

### Database & ORM

| Library | Purpose | Link |
|---------|---------|------|
| **drizzle-orm** | TypeScript ORM | [npm](https://www.npmjs.com/package/drizzle-orm) |
| **better-sqlite3** | SQLite driver (Node.js) | [npm](https://www.npmjs.com/package/better-sqlite3) |

### Testing

| Library | Purpose | Link |
|---------|---------|------|
| **jest** | Test runner | [npm](https://www.npmjs.com/package/jest) |
| **ts-jest** | Jest + TypeScript support | [npm](https://www.npmjs.com/package/ts-jest) |

### AI & LLM APIs

| Service | Purpose | Link |
|---------|---------|------|
| **Anthropic SDK** | Claude API | [npm](https://www.npmjs.com/package/@anthropic-ai/sdk) |
| **Google Generative AI** | Gemini API | [npm](https://www.npmjs.com/package/@google/generative-ai) |

---

## Development Tools

### Local Development
- **Node.js 20+** — JavaScript runtime
- **npm** — Package manager
- **TypeScript** — Type-safe JavaScript
- **ts-node** — Run TypeScript directly
- **Prettier** — Code formatter
- **ESLint** — Code linter

### Code Repositories
- **GitHub** — Main source control
- **[Project Repo](../../../)** — This project's repository

### Testing & CI/CD
- **Jest** — Unit & integration testing
- **npm test** — Run test suite locally
- **Coverage threshold:** 80% lines/functions, 70% branches

---

## External APIs & Services

### Gemini (Google AI)
- **[Gemini API Documentation](https://ai.google.dev/)** — Official docs
- **[Gemini 2.5 Flash](https://ai.google.dev/models)** — Recommended model for skills engine fallback
- **Environment Variable:** `GOOGLE_API_KEY`

### Claude (Anthropic)
- **[Claude API Documentation](https://docs.anthropic.com/)** — Official docs
- **[Model List](https://docs.anthropic.com/claude/reference/available-models)** — Available models
- **Environment Variable:** `ANTHROPIC_API_KEY`

### Email Services (Mock/Dev)
- **[Mailtrap](https://mailtrap.io/)** — Email testing service
- **[MailHog](https://github.com/mailhog/MailHog)** — Local email testing
- **Environment Variables:** `MAILBOX_HOST`, `MAILBOX_USER`, `MAILBOX_PASS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`

---

## Configuration & Environment

All configuration is centralized in:
- **File:** `src/config.ts`
- **Environment Variables:**
  - `MAILBOX_HOST`, `MAILBOX_USER`, `MAILBOX_PASS` — IMAP credentials
  - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — SMTP credentials
  - `ANTHROPIC_API_KEY` — Claude API key
  - `GOOGLE_API_KEY` — Gemini API key
  - `FHIR_SERVER_URL` — HAPI FHIR endpoint (optional, PRD-08)

---

## Useful Commands

### Build & Test
```bash
npm run build              # Compile TypeScript
npm test                   # Run all tests
npm run test:watch       # Tests in watch mode
npm run test:coverage    # Coverage report
npm run lint             # Check for linting
npm run lint:fix         # Fix linting errors
```

### Database & Development
```bash
npm run db:generate      # Generate migrations
npm run db:migrate       # Run migrations
npm run seed             # Seed demo data
npm run dev              # Start in development
```

---

## Documentation Resources

### Internal Documentation
- [[../_INDEX|Vault Index]] — Main entry point
- [[../Projects/360X Referral Workflow/🎯 PROJECT OVERVIEW|Project Overview]] — Architecture & roadmap
- **[CLAUDE.md](../../CLAUDE.md)** — Project setup & commands
- **[MEMORY.md](../../.claude/projects/c--Users-Wcjos/memory/MEMORY.md)** — User context & feedback

### External Resources
- **[Obsidian Help](https://help.obsidian.md/)** — Vault features & shortcuts
- **[Markdown Guide](https://www.markdownguide.org/)** — Markdown syntax reference

---

## Quick Links

| Resource | Link |
|----------|------|
| **Main Index** | [[../_INDEX|Go to Index]] |
| **Project Overview** | [[../Projects/360X Referral Workflow/🎯 PROJECT OVERVIEW|Project Overview]] |
| **All PRDs** | [[../Projects/360X Referral Workflow/Features/📋 PRD Index|PRD Index]] |
| **Architecture** | [[../Projects/360X Referral Workflow/Architecture/360X Workflow Overview|Workflow Overview]] |
| **Ideas & Backlog** | [[../Projects/360X Referral Workflow/Backlog & Ideas/Ideas|Ideas List]] |
| **Templates** | [[../Templates/Feature Template|Feature Template]] · [[../Templates/PRD Template|PRD Template]] |

---

**Last Updated:** 2026-04-02
