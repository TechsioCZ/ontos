---
name: debugger-mode
description: "Hypothesis-driven runtime debugging with a local ingest HTTP server, background session logging under .cursor/debug-{session}.log, and codebase pattern scans for debug markers or ingest fetch calls. Use when diagnosing bugs in any repository, language, or stack where runtime evidence, repeated repro runs, local log capture, explicit hypothesis verdicts (CONFIRMED/REJECTED/INCONCLUSIVE), and deterministic cleanup of temporary instrumentation are needed."
---

# Debugger Mode

## Overview
Run a runtime-first debug loop instead of speculative patching. Start a local ingest server in the background, collect session logs under `.cursor/`, prove root cause with evidence, apply minimal fixes, verify, then remove instrumentation.

## Quick Start
1. Choose values for `SESSION_ID`, `RUN_ID`, `ROUTE_TOKEN`, and `PROJECT_ROOT`.
2. Start ingest server in the background.
3. Add temporary instrumentation wrapped in session markers.
4. Reproduce the issue and inspect `.cursor/debug-<session>.log`.
5. Evaluate hypotheses from concrete log lines.
6. Apply only confirmed fixes, rerun, and clean instrumentation.

## Commands
Use scripts from this skill folder.

```bash
python3 scripts/debug_log_server.py start \
  --daemon \
  --project-root "$PROJECT_ROOT" \
  --session-id "$SESSION_ID" \
  --route-token "$ROUTE_TOKEN" \
  --port 7276
```

This writes logs to `.cursor/debug-$SESSION_ID.log` by default.

```bash
python3 scripts/debug_log_server.py status \
  --project-root "$PROJECT_ROOT" \
  --session-id "$SESSION_ID"
```

```bash
python3 scripts/debug_log_server.py reset-log \
  --project-root "$PROJECT_ROOT" \
  --session-id "$SESSION_ID"
```

```bash
python3 scripts/debug_log_server.py stop \
  --project-root "$PROJECT_ROOT" \
  --session-id "$SESSION_ID"
```

## Codebase Scans
Use `debug_repo_scan.py` to search any repo regardless of language.

Search for `#region` markers:

```bash
python3 scripts/debug_repo_scan.py --root "$PROJECT_ROOT" regions
```

Find `fetch(...)` calls that appear to target ingest routes:

```bash
python3 scripts/debug_repo_scan.py --root "$PROJECT_ROOT" ingest-fetch
```

Run both scans:

```bash
python3 scripts/debug_repo_scan.py --root "$PROJECT_ROOT" all
```

Run arbitrary literal or regex searches:

```bash
python3 scripts/debug_repo_scan.py --root "$PROJECT_ROOT" search \
  --pattern "// #region"
```

```bash
python3 scripts/debug_repo_scan.py --root "$PROJECT_ROOT" search \
  --pattern "ingest/" \
  --regex \
  --ignore-case
```

## Ingest Payload Format
The ingest server expects JSON payloads with these fields:
- `sessionId`
- `runId`
- `hypothesisId`
- `location`
- `message`
- `data`
- `timestamp`

## Instrumentation Pattern
Wrap temporary instrumentation with explicit markers so cleanup is deterministic.

```ts
// DEBUG-SESSION:30f456-START
fetch("http://127.0.0.1:7276/ingest/bfd8afcf-6455-4eef-92a7-4862aa31a141", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Debug-Session-Id": "30f456",
  },
  body: JSON.stringify({
    sessionId: "30f456",
    runId: "run1",
    hypothesisId: "H1",
    location: "file.ts:42",
    message: "state snapshot",
    data: { example: true },
    timestamp: Date.now(),
  }),
}).catch(() => {});
// DEBUG-SESSION:30f456-END
```

## Debug Loop
1. Form 3-5 concrete hypotheses.
2. Add targeted instrumentation tied to each hypothesis.
3. Reproduce the issue.
4. Mark each hypothesis `CONFIRMED`, `REJECTED`, or `INCONCLUSIVE` from log evidence.
5. Implement only confirmed fixes.
6. Reproduce again and compare pre-fix vs post-fix logs.
7. Remove instrumentation only after verification succeeds.

## Cleanup
Remove marker-wrapped instrumentation for one session:

```bash
python3 scripts/cleanup_debug_instrumentation.py \
  --root "$PROJECT_ROOT" \
  --session-id "$SESSION_ID"
```

Preview cleanup without writing changes:

```bash
python3 scripts/cleanup_debug_instrumentation.py \
  --root "$PROJECT_ROOT" \
  --session-id "$SESSION_ID" \
  --dry-run
```

## Safety Rules
- Never log secrets, passwords, tokens, or PII.
- Keep one session id per debug run.
- Reset only the current session log.
- Keep instrumentation until post-fix verification is complete.
- Stop the debug server before finalizing.
