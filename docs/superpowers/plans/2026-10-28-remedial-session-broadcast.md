# Remedial Session and WhatsApp Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a report-driven remedial session link for students below KKM, with duplicate name/class consolidation and WhatsApp-ready sharing.

**Architecture:** Reuse the existing `ulangan_sesi` table and session validation flow. Add report aggregation and remedial-session orchestration in `reviewService`, add one protected route in `server.js`, and extend the existing teacher report/WhatsApp UI. Do not change auth, database connection adapters, environment handling, or schema migrations.

**Tech Stack:** Node.js, Express, existing SQLite/LibSQL abstraction, existing browser UI, Node test runner.

**Spec:** This request and the approved chat description.

## Global Constraints

- Do not modify `src/services/authService.js`.
- Do not modify `src/config/database.js`, `src/config/remoteDatabase.js`, or database environment selection.
- Do not add database tables, columns, or migrations.
- Duplicate normalized name + class records use the highest submitted score for the report and remedial eligibility.
- Remedial session tokens are automatically generated with exactly 3 alphanumeric characters.

## Review Focus

- Duplicate participant rows with different scores collapse to one report row using the highest score.
- A tuntas student cannot enter a remedial session; a below-KKM student can.
- Creating the same selected remedial classes twice does not create duplicate active sessions.
- The WhatsApp text contains the new session token and direct link.
- Existing auth and database adapter files remain unchanged.

### Task 1: Report aggregation and remedial orchestration

**Files:**
- Modify: `src/services/reviewService.js`
- Test: `tests/remedial_session.test.js`

- [ ] Write failing tests for duplicate grouping, 3-character token generation, eligibility, idempotent creation, and class filtering.
- [ ] Run the test file and confirm the expected failures.
- [ ] Implement the service methods using existing `ulangan_sesi` and `examService.createSesi`.
- [ ] Run the test file and confirm it passes.

### Task 2: Protected API and WhatsApp formatter

**Files:**
- Modify: `server.js`, `src/services/geminiService.js`
- Test: `tests/remedial_session.test.js`

- [ ] Add the teacher-only remedial-session endpoint.
- [ ] Return session data, direct link, eligible students, and WhatsApp text.
- [ ] Test the formatter output for token, link, KKM, and selected classes.

### Task 3: Teacher report UI

**Files:**
- Modify: `public/guru.html`
- Test: `tests/remedial_session.test.js` static checks

- [ ] Add report controls for selecting candidate classes and creating the session.
- [ ] Show the generated link/token and copy-ready WhatsApp text through the existing broadcast modal.
- [ ] Add concise usage text in the report UI.

### Task 4: Verification

- [ ] Run focused tests directly because the Windows Node test runner may fail with `spawn EPERM`.
- [ ] Run syntax checks for modified JavaScript files.
- [ ] Confirm `git diff` contains no auth/database adapter changes.
