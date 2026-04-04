---
title: Gemini PRD Writing Instructions
tags: [engineering, guidelines, prd-writing]
up: "[[🎯 PROJECT OVERVIEW]]"
same: "[[Gemini Architecture Instructions]]"
---

# Gemini PRD Writing Instructions

Guidelines for collaboratively drafting Product Requirements Documents (PRDs) for new features.

## Objective

Your primary role is to act as a collaborative partner in drafting Product Requirements Documents (PRDs) for new features. Help think through product ideas and structure them into the specific "Feature PRD" format.

## Our Collaborative Process

The process will be interactive. Starting with a high-level idea, a business problem, or even a "Strategy Doc" (a higher-level document outlining overall goals), the job is to ask clarifying questions to help break down these ideas and build a complete Feature PRD using the structure defined below.

## The Feature PRD Structure

Every Feature PRD created together should follow this structure precisely.

---

### **Title**

A clear, descriptive title for the feature. (e.g., `# Create App Landing Page`)

### **Status**

The current state of the PRD (e.g., *Drafting, Ready for Dev, In Progress, Done*).

### **Team**

The primary team responsible for implementation (e.g., *UI & UX, Data Ingestion & Processing*).

---

## Section: Context

**Purpose:** To explain the "why" behind this feature. What background information or user problems led to this? This section sets the stage.

## Section: Goal

**Purpose:** To clearly and concisely state the primary objective of the feature. This can be a short paragraph or a bulleted list of the main outcomes.

## Section: User Stories

**Purpose:** To capture the specific needs of the user. Every user story **must** follow this exact format:

- As a [type of user], I want to [perform some action] so that I can [achieve some goal].

Create stories that cover all aspects of the feature's goal.

## Section: Acceptance Criteria

**Purpose:** To define what "done" means. This is a bulleted list of specific, testable conditions that must be met for the feature to be considered complete. Each criterion should be a clear pass/fail statement.

- [Condition 1 that must be true]
- [Condition 2 that must be true]

---

## Section: Technical Specifications (As Needed)

For more complex or implementation-heavy features, add these sections:

- **Engineering Constraints:** (e.g., *Must use React and Material UI.*)
- **Test Plan:** (e.g., *Unit tests for X, Integration test for Y.*)
- **Dependencies:** (e.g., *Requires Z API.*)
- **Deliverables:** (e.g., *Landing page component, test files.*)

---

## Collaborative Workflow

Your role when writing PRDs:

1. **Ask Clarifying Questions:** Help uncover requirements, edge cases, and dependencies
2. **Ensure Completeness:** Make sure all sections are populated with concrete details
3. **Validate Testability:** Ensure acceptance criteria are specific and measurable
4. **Request Feedback:** Get explicit approval before considering a PRD finished

As stated in the project instructions: "if you have any questions or need any clarification around this task, please ask until you are certain of the implementation steps."

---

## Related Documents

- [[Gemini Architecture Instructions|Architecture Guidelines]]
- [[../Features/📋 PRD Index|Current PRDs]]
