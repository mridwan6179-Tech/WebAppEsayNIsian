# Student Session Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent students on shared lab devices from resuming, editing, submitting, or viewing another student's exam by binding every student operation to a cryptographic session token.

**Architecture:** Add a random per-attempt token to `pengerjaan`. `startExam` creates or reuses the token and returns it to the browser. Student endpoints validate the token against the requested attempt before reading or mutating data; the browser stores the token alongside the attempt ID and sends it on every session request. Legacy service calls used by existing unit tests remain usable when no token is supplied, while HTTP student routes require the token.

**Tech Stack:** Node.js, Express 5, SQLite/libSQL, Node built-in `crypto`, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-22-student-session-isolation-design.md`

## Global Constraints

- Preserve existing exam and remedial behavior for the legitimate student who owns the attempt.
- Do not expose answer keys or broaden access to submitted results.
- Keep the public exam-code validation and teacher/admin authentication flows unchanged.
- Use ASCII-only source changes unless the surrounding file already requires otherwise.

## Review Focus

- A stale attempt ID without its token must be rejected by every student session endpoint.
- A valid token paired with a different attempt ID must be rejected.
- A token from student A must not allow student B's draft, heartbeat, submit, result, history, or remedial access.
- Refresh and shared-device handoff must preserve the owning student's session token and clear the old one when the identity changes.
- Existing active attempts created before migration must receive a token before the first student response.

### Task 1: Persist and issue student attempt tokens

**Files:**
- Create: `docs/superpowers/specs/2026-10-22-student-session-isolation-design.md`
- Modify: `src/config/database.js`
- Modify: `src/services/studentService.js`
- Test: `tests/student_session_isolation.test.js`

**Interfaces:**
- `studentService.startExam(...)` returns `studentSessionToken` for both new and resumed attempts.
- `studentService.verifyStudentSession(pengerjaanId, token)` returns the owned `pengerjaan` row or `null`.

- [ ] Write tests that create two attempts and assert their tokens differ, the owner token validates, and the other token/stale ID pair is rejected.
- [ ] Run the focused test and observe the expected failure because the token column and verifier do not exist.
- [ ] Add the nullable token column plus a unique partial index migration and generate/reuse a cryptographically random token in `startExam`.
- [ ] Implement `verifyStudentSession` and return the token in start/resume data without exposing it in teacher-facing result payloads.
- [ ] Run the focused test and confirm it passes.

### Task 2: Enforce token validation at student routes and service mutations

**Files:**
- Modify: `server.js`
- Modify: `src/services/studentService.js`
- Modify: `tests/student_session_isolation.test.js`

**Interfaces:**
- Student routes read `student_session_token` from the JSON body or `X-Student-Session-Token` header.
- `saveDraft`, `submitExam`, `recordPing`, `getActiveSession`, `getPengerjaanStatus`, `getStudentExamHistory`, and `startDirectRemedial` accept/validate the token when supplied.

- [ ] Add integration assertions for missing, mismatched, and valid tokens across resume, draft, submit, result, history, ping, and remedial routes.
- [ ] Run the focused test and observe failures for currently unprotected routes.
- [ ] Add one shared route guard/helper and pass the verified token through each student operation.
- [ ] Return `401` for missing/mismatched tokens and preserve legitimate `200` responses.
- [ ] Run the focused test and confirm it passes.

### Task 3: Bind browser state to the issued token

**Files:**
- Modify: `public/index.html`
- Modify: `tests/student_session_isolation.test.js`

**Interfaces:**
- Browser storage key: `ulangan_student_session_token`.
- Every student request carrying `pengerjaan_id` includes the token in the body or `X-Student-Session-Token` header.

- [ ] Add static checks for token persistence after start/resume, token clearing on ?Ganti Siswa?, and token inclusion in draft/submit/ping/result/remedial requests.
- [ ] Run the focused test and observe failures against the current browser source.
- [ ] Update start, queue resume, refresh resume, result polling, autosave, heartbeat, submit, and remedial flows to use the token and clear it with the old identity.
- [ ] Run the focused test and confirm it passes.

### Task 4: Full regression verification

**Files:**
- Modify: `tests/student_session_isolation.test.js` only if coverage gaps remain.

- [ ] Run the focused isolation test in a single Node test process.
- [ ] Run the project test command with the required Windows process permissions or a safe serial fallback, recording any pre-existing environment failures separately.
- [ ] Inspect the final diff for accidental identity or data-leak regressions.

---
