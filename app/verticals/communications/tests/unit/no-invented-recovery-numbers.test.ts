import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import { OUTBOX_WORKER_GENERATED_DEFAULTS } from '../../src/handoff/outbox-worker-defaults.ts';

/**
 * [#1403 R-13 R-14 AC-07] A static guard: no retry count, interval, backoff or waiting time is hard-coded in this owner, and no
 * scheduler or retry framework is introduced. A per-flow limit may exist only as owner-approved catalog DATA (`maxAttempts` of an
 * approved type). The one thing Core itself requires on every Outbox Worker descriptor, a lease and a redelivery policy, has NO
 * omittable default in Core: its values are exactly what the Codesmith worker generator writes, and this owner keeps them in ONE
 * named constant (`OUTBOX_WORKER_GENERATED_DEFAULTS`). This guard exempts that single file and nothing else: every worker
 * descriptor must take its numbers from it and carry none of its own.
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

/** The only file with a Core-required number: the values the worker generator writes into every descriptor. */
const GENERATED_DEFAULTS_FILE = 'src/handoff/outbox-worker-defaults.ts';
const CORE_WORKER_DEFINITIONS = [
  'src/workers/prepare-message-handoff.worker.ts',
  'src/workers/receive-privacy-measure.worker.ts',
  'src/workers/report-privacy-owner-outcome.worker.ts',
];
/** The Codesmith Outbox Worker generator's template: the authority for "generated defaults". */
const GENERATOR_TEMPLATE = path.join(root, '..', '..', 'scripts', 'scaffolding', 'outbox-worker', 'scaffold.mts');

const NUMERIC_LIMIT_AFTER =
  /\b(?:attempts?|retr(?:y|ies)|tries|submitted|attemptNumber|maxAttempts|limit)\w*(?:\.length)?\s*(?:>=|<=|===|!==|==|>|<)\s*\d/iu;
const NUMERIC_LIMIT_BEFORE = /\b\d+\s*(?:>=|<=|===|!==|==|>|<)\s*\w*(?:attempt|retr(?:y|ies)|tries|submitted)\w*/iu;
const NUMERIC_BOUND_CALL =
  /\b(?:attempts?|retr(?:y|ies)|tries)\w*\.(?:slice|splice|take)\(\s*\d|\b(?:times|repeats?|retries|maxTries)\s*[:=(]\s*\d/iu;

/** The number a generator template writes after `key:`, e.g. `30_000` -> 30000. */
const generatedNumber = (template: string, key: string) =>
  Number((template.split(`${key}:`)[1] ?? 'NaN').trimStart().split(',')[0]?.replaceAll('_', ''));

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
    expect(scanned.map(relativeOf)).toEqual(
      expect.arrayContaining([GENERATED_DEFAULTS_FILE, ...CORE_WORKER_DEFINITIONS]),
    );
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
    [
      'a lease, backoff or redelivery number written against its own descriptor key',
      /\b(?:leaseDurationMs|maxDeferralMs|initialBackoffMs|maxBackoffMs|multiplier)\s*:\s*[\d_.]+/u,
    ],
  ])('hard-codes %s nowhere in the sources', (_name, pattern) => {
    const offenders = scanned
      .filter((file) => relativeOf(file) !== GENERATED_DEFAULTS_FILE)
      .filter((file) => pattern.test(codeOf(file)))
      .map(relativeOf);
    expect(offenders).toEqual([]);
  });

  it('keeps the Core-required lease and redelivery policy in ONE named constant, equal to what the worker generator writes', () => {
    const template = readFileSync(GENERATOR_TEMPLATE, 'utf-8');
    expect(OUTBOX_WORKER_GENERATED_DEFAULTS).toEqual({
      leaseDurationMs: generatedNumber(template, 'leaseDurationMs'),
      retryPolicy: {
        initialBackoffMs: generatedNumber(template, 'initialBackoffMs'),
        maxAttempts: generatedNumber(template, 'maxAttempts'),
        maxBackoffMs: generatedNumber(template, 'maxBackoffMs'),
        multiplier: generatedNumber(template, 'multiplier'),
      },
    });
  });

  it('lets every Outbox Worker descriptor take its lease and redelivery policy from that constant and carry no number of its own', () => {
    for (const worker of CORE_WORKER_DEFINITIONS) {
      const code = codeOf(path.join(root, worker));
      expect(code, worker).toMatch(
        /leaseDurationMs:\s*(?:PREPARE_MESSAGE_HANDOFF_LEASE_MS|OUTBOX_WORKER_GENERATED_DEFAULTS\.leaseDurationMs),/u,
      );
      expect(code, worker).toMatch(/retryPolicy:\s*OUTBOX_WORKER_GENERATED_DEFAULTS\.retryPolicy,/u);
      expect(code, worker).not.toMatch(/\bmaxDeferralMs\b/u);
    }
    // the handoff lease the step bounds its provider call by is that same number, never a second one
    expect(codeOf(path.join(root, 'src/handoff/handoff-lease.ts'))).toMatch(
      /PREPARE_MESSAGE_HANDOFF_LEASE_MS\s*=\s*OUTBOX_WORKER_GENERATED_DEFAULTS\.leaseDurationMs;/u,
    );
  });

  it('reads a redelivery policy nowhere else: only the Core worker descriptors, never a recovery code', () => {
    const readers = scanned
      .filter((file) => relativeOf(file) !== GENERATED_DEFAULTS_FILE)
      .filter((file) => /\b(?:retryPolicy|maxDeferralMs)\b/u.test(codeOf(file)))
      .map(relativeOf);
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
