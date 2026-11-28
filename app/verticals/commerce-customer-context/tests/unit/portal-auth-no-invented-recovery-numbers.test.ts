import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import { OUTBOX_WORKER_GENERATED_DEFAULTS } from '../../src/portal-auth/communications/outbox-worker-defaults.ts';

/**
 * [#1403 D10 AC-07 R-13, #1400 LC-15] The Portal Auth redelivery path invents no retry count, interval, lease or wait. Core
 * requires a lease and a redelivery policy on the Auth submit worker and offers no omittable default, so the one place that
 * holds numbers is `outbox-worker-defaults.ts`: the generated worker defaults plus the relay's few named platform guards. Every
 * other file on the path (the submit worker and the relay loop) takes them from there and carries no literal of its own.
 */
const root = path.join(import.meta.dirname, '..', '..');
const GENERATOR_TEMPLATE = path.join(root, '..', '..', 'scripts', 'scaffolding', 'outbox-worker', 'scaffold.mts');
const PATH_FILES = [
  'src/workers/submit-portal-auth-communication-request.worker.ts',
  'src/portal-auth/communications/request-relay.ts',
];
const codeOf = (file: string) =>
  readFileSync(path.join(root, file), 'utf-8')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/?\*)/u.test(line))
    .join('\n');
/** A numeric literal other than 0 and 1 (indexes, "none yet" and "next" arithmetic carry no limit). */
const LIMIT_LITERAL = /(?<![\w.])(?![01](?![\w.]))\d[\d_]*(?:\.\d+)?(?!\w)/u;
/** A duration written with any digit, even 1: a wait is a wait whatever its size. */
const DURATION_LITERAL = /\bDuration\.\w+\(\s*\d/u;
const isInvented = (line: string) => LIMIT_LITERAL.test(line) || DURATION_LITERAL.test(line);
const generatedNumber = (template: string, key: string) =>
  Number((template.split(`${key}:`)[1] ?? 'NaN').trimStart().split(',')[0]?.replaceAll('_', ''));

describe('Portal Auth recovery path invents no numbers (#1403)', () => {
  it('the literal pattern really catches a limit, a lease or a wait, and spares 0, 1 and identifiers', () => {
    for (const offender of ['limit: 32,', 'leaseMillis: 30_000,', 'Duration.seconds(1)', 'x ** 20', 'a * 2.5']) {
      expect(isInvented(offender), offender).toBe(true);
    }
    for (const innocent of [
      'Math.max(0, attempts - 1)',
      'claimed === 0',
      'randomUUIDv4()',
      'const a = 1;',
      'Duration.millis(RELAY_POLL_INTERVAL_MS)',
    ]) {
      expect(isInvented(innocent), innocent).toBe(false);
    }
  });

  it('holds the generated worker defaults in one constant, equal to what the worker generator writes', () => {
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

  it.each(PATH_FILES)('%s carries no numeric literal of its own', (file) => {
    const literals = codeOf(file).split('\n').filter(isInvented);
    expect(literals).toEqual([]);
  });

  it('takes the submit worker lease and redelivery policy from the generated defaults, with no deferral of its own', () => {
    const worker = codeOf(PATH_FILES[0] ?? '');
    expect(worker).toMatch(/leaseDurationMs:\s*OUTBOX_WORKER_GENERATED_DEFAULTS\.leaseDurationMs,/u);
    expect(worker).toMatch(/const RETRY_POLICY = OUTBOX_WORKER_GENERATED_DEFAULTS\.retryPolicy;/u);
    expect(worker).toMatch(/retryPolicy:\s*RETRY_POLICY,/u);
  });

  it('takes the relay lease, first retry delay and retry ceiling from the same defaults', () => {
    const relay = codeOf(PATH_FILES[1] ?? '');
    expect(relay).toMatch(/leaseMillis:\s*OUTBOX_WORKER_GENERATED_DEFAULTS\.leaseDurationMs,/u);
    expect(relay).toMatch(/retryMillis:\s*OUTBOX_WORKER_GENERATED_DEFAULTS\.retryPolicy\.initialBackoffMs,/u);
    expect(relay).toMatch(/maxRetryMillis:\s*OUTBOX_WORKER_GENERATED_DEFAULTS\.retryPolicy\.maxBackoffMs,/u);
  });
});
