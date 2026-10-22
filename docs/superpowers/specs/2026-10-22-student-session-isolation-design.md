# Student Session Isolation Design

## Intent

A shared lab browser must never let a later student resume or mutate the previous student's attempt. The existing application uses a sequential `pengerjaan_id` stored in `localStorage` as the only handle for student data, so stale browser state can point at another student's record.

## Goals

- Bind each exam attempt to an unpredictable random token.
- Require the token for all student reads and writes tied to an attempt.
- Preserve refresh, retry, auto-save, heartbeat, submit, result polling, and direct remedial for the owning student.
- Clear the old token when the browser changes student identity.
- Treat a new `/api/siswa/mulai` request as a new attempt unless it carries a matching attempt ID and session token for an explicit resume/retake.

## Non-goals

- Redesign teacher/admin authentication.
- Change exam-code validation, grading, queue, or database replication behavior.
- Make public result links a new authentication system in this change.

## Constraints and decisions

- Tokens are generated with Node `crypto.randomBytes` and stored on `pengerjaan`.
- Existing rows get a token lazily when they are first returned or resumed.
- HTTP routes return `401` for missing or mismatched student tokens.
- Existing direct service tests that do not model HTTP authentication may continue to call service methods without a token; all production HTTP routes enforce it.
- The browser stores the active token in per-tab `sessionStorage` under `ulangan_student_session_token` and sends it in `X-Student-Session-Token`. Legacy shared `localStorage` values are removed during migration.

## Verification

The regression suite creates two students in one exam, proves token uniqueness and owner-only access, tests all student endpoint families, and checks the browser source for token lifecycle coverage.
