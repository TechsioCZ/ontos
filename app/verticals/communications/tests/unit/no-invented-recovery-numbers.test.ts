import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'effect-rstest';

/**
 * [#1403 R-13 R-14 AC-07] A static guard: no retry count, interval, backoff or waiting time is hard-coded in this owner, and no
 * scheduler or retry framework is introduced. A per-flow limit may exist only as owner-approved catalog DATA (`maxAttempts` of an
 * approved type), and the only retry configuration in the source is the Core Outbox worker's own technical redrive, which is the
 * same authority and never a new send approval.
 */
const root = path.join(import.meta.dirname, '..', '..');
const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const file = path.join(directory, entry);
    if (statSync(file).isDirectory()) {
      return sourceFiles(file);
    }
    return file.endsWith('.ts') ? [file] : [];
  });
const scanned = ['src', 'shared'].flatMap((directory) => sourceFiles(path.join(root, directory)));
/** The code of a file, without its comment lines: a comment may say "retry" and "backoff" freely. */
const codeOf = (file: string) =>
  readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/?\*)/u.test(line))
    .join('\n');
const relativeOf = (file: string) => path.relative(root, file);

/** The only file that configures a retry: the Core Outbox worker definition requires its own technical redrive policy. */
const CORE_REDRIVE_WORKER = 'src/workers/prepare-message-handoff.worker.ts';
// The Privacy handoff worker is the one other Core worker definition: it governs redelivery of the same Privacy message to the
// same idempotent record step (the generated defaults, no number of its own) and is never read by any recovery code.
const CORE_HANDOFF_RECORD_WORKER = 'src/workers/receive-privacy-measure.worker.ts';
const CORE_WORKER_DEFINITIONS = [CORE_REDRIVE_WORKER, CORE_HANDOFF_RECORD_WORKER];

const NUMERIC_LIMIT_AFTER =
  /\b(?:attempts?|retr(?:y|ies)|tries|submitted|attemptNumber|maxAttempts|limit)\w*(?:\.length)?\s*(?:>=|<=|===|!==|==|>|<)\s*\d/iu;
const NUMERIC_LIMIT_BEFORE = /\b\d+\s*(?:>=|<=|===|!==|==|>|<)\s*\w*(?:attempt|retr(?:y|ies)|tries|submitted)\w*/iu;
const NUMERIC_BOUND_CALL =
  /\b(?:attempts?|retr(?:y|ies)|tries)\w*\.(?:slice|splice|take)\(\s*\d|\b(?:times|repeats?|retries|maxTries)\s*[:=(]\s*\d/iu;

describe('no invented recovery numbers (#1403)', () => {
  it('the numeric-limit patterns really catch a limit written against an attempt or retry count, and spare the lease and plain arithmetic', () => {
    for (const offender of [
      'if (attempts.length >= 3) {',
      'submitted > 5',
      'retries === 4',
      'attemptNumber > 2',
      'if (3 <= attempts) {',
      'attempts.slice(0, 3)',
      'times: 3',
    ]) {
      expect(
        [NUMERIC_LIMIT_AFTER, NUMERIC_LIMIT_BEFORE, NUMERIC_BOUND_CALL].some((pattern) => pattern.test(offender)),
      ).toBe(true);
    }
    for (const innocent of [
      'const attemptNumber = (latest?.attemptNumber ?? 0) + 1;',
      'submitted >= policy.maxAttempts',
      'export const LEASE_MS = 30_000;',
    ]) {
      expect(
        [NUMERIC_LIMIT_AFTER, NUMERIC_LIMIT_BEFORE, NUMERIC_BOUND_CALL].some((pattern) => pattern.test(innocent)),
      ).toBe(false);
    }
  });

  it('finds the sources it scans, so the guard cannot pass on an empty directory', () => {
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned.map(relativeOf)).toContain(CORE_REDRIVE_WORKER);
  });

  it.each([
    ['a retry count', /\b(?:retryCount|retriesLeft|maxRetries|retryLimit|attemptLimit|maxAttempts\s*[:=]\s*\d)/u],
    [
      'an interval or a backoff',
      /\b(?:backoff|retryInterval|retryDelay|delayMs|intervalMs|waitMs|waitSeconds|cooldown)\b/iu,
    ],
    [
      'a scheduler, a timer or a polling loop',
      /\b(?:setInterval|setTimeout|Schedule\.|Effect\.(?:retry|repeat|schedule|sleep)|cron|node-cron|p-retry|async-retry|bullmq)\b/u,
    ],
    ['a numeric limit compared with an attempt or retry count', NUMERIC_LIMIT_AFTER],
    ['a numeric limit on the left of an attempt or retry comparison', NUMERIC_LIMIT_BEFORE],
    ['a numeric attempt or retry bound given to a slice, take, repeat or times', NUMERIC_BOUND_CALL],
    [
      'a retry framework import',
      /from\s+['"](?:p-retry|async-retry|retry|bull|bullmq|agenda|node-cron|cron|bee-queue)['"]/u,
    ],
  ])('hard-codes %s nowhere in the sources', (_name, pattern) => {
    const offenders = scanned
      .filter((file) => !CORE_WORKER_DEFINITIONS.includes(relativeOf(file)))
      .filter((file) => pattern.test(codeOf(file)))
      .map(relativeOf);
    expect(offenders).toEqual([]);
  });

  it('keeps the Core Outbox redrive the only retry configuration, as a Core worker definition and never a send approval', () => {
    expect(codeOf(path.join(root, CORE_REDRIVE_WORKER))).toMatch(/retryPolicy:\s*\{/u);
    // it governs redelivery of the same message to the same idempotent step; it is not read by any recovery code
    const readers = scanned.filter((file) => /\bretryPolicy\b/u.test(codeOf(file))).map(relativeOf);
    expect(readers).toEqual(CORE_WORKER_DEFINITIONS);
  });

  it('introduces no queue, worker or schedule of its own for recovery: the existing pre-handoff step and the Privacy handoff record step', () => {
    const workers = scanned.filter((file) => /defineOutboxWorker\(/u.test(codeOf(file))).map(relativeOf);
    expect(workers).toEqual(CORE_WORKER_DEFINITIONS);
  });

  it('lets an owner limit exist only as approved catalog data, and the recovery code only compares against it', () => {
    const evaluator = codeOf(path.join(root, 'src/domain/recovery/retry-eligibility.ts'));
    expect(evaluator).toMatch(/policy\.maxAttempts/u);
    expect(evaluator).not.toMatch(/maxAttempts\s*[:=]\s*\d/u);
    // a default limit would be an invented number: no type declares one in the approved registry
    expect(codeOf(path.join(root, 'src/domain/catalog/approved-registry.ts'))).not.toMatch(/recovery|maxAttempts/u);
  });
});
