# Remedial Session Question Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-link remedial participant, schedule, question-count, and question-type percentage controls without changing the main exam or authentication flow.

**Architecture:** Store immutable remedial configuration on `ulangan_sesi`. At first student entry, `studentService.startExam` samples the master question bank using that session configuration and persists the IDs in `pengerjaan.soal_ids`; subsequent requests use the persisted IDs. Review keeps existing weighted scoring.

**Tech Stack:** Node.js, Express, better-sqlite3/libsql-compatible SQLite, node:test, existing browser HTML.

**Spec:** `docs/superpowers/specs/2026-10-31-remedial-session-question-config.md`

## Global Constraints

- Do not modify auth, student session tokens, queue limits, or the main `ulangan` question settings.
- Keep duplicate student names/classes merged by highest score.
- Use existing timezone parsing and weighted score normalization.
- Do not add dependencies.

## Review Focus

- A remedial link with percentages that round to a non-integer total still selects exactly the requested count.
- Missing question categories are capped without selecting duplicate questions.
- A refresh/rejoin returns the same question IDs.
- A selected excluded student is rejected with a clear "tidak perlu mengulang" message.
- Invalid schedule or percentage input returns a clear 400 error without creating a session.

### Task 1: Schema and session configuration

**Files:** `src/config/database.js`, `src/services/examService.js`, `src/services/reviewService.js`, `tests/remedial_question_config.test.js`

- Add nullable session columns with `safeAddColumn` and expose them from session reads.
- Validate and normalize question count, ratios, student IDs, and schedule.
- Create a new remedial session when its configuration differs from an active existing session; preserve reuse for identical configuration.

### Task 2: Question selection

**Files:** `src/services/packageService.js`, `src/services/studentService.js`, `tests/remedial_question_config.test.js`

- Add deterministic category detection and largest-remainder allocation for requested percentages.
- Apply session configuration only when the session is remedial and no persisted `soal_ids` exist.
- Persist selected IDs before returning the student sheet; keep existing selection path untouched for regular exams.

### Task 3: Participant exclusion list and teacher UI/API

**Files:** `server.js`, `src/services/reviewService.js`, `src/services/studentService.js`, `public/guru.html`, `tests/remedial_question_config.test.js`

- Pass the new options through the endpoint.
- Treat saved student IDs as an exclusion list for students who do not need to retake; enforce class and schedule while allowing other identities, including new participants, to enter.
- Add controls for question count, ratios, schedule, and optional student selection to the report card; include the effective configuration in the generated WhatsApp text/result.

### Task 4: Verification

- Run the focused test serially with `node -e 'require(...)'` because this Windows environment blocks Node test child processes with `spawn EPERM`.
- Run all existing tests serially using the repository's established serial runner command.
- Run syntax checks for changed JavaScript files and inspect `git diff` for auth/database regressions.
