import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

/*
 * Structural guards for the integrity and recovery code (#1434, #1447): it has no way to delete, no scheduler,
 * timer, retry loop or deadline, and no invented number. Recovery is client or workload driven, so a same-key
 * retry or the next authorized request is the only trigger there is, and a guard that fails loudly is cheaper
 * than a reviewer noticing a quiet `Effect.retry` later. Comments are stripped first, so they may say "delete".
 */

const RECOVERY_SOURCES = [
  'media/integrity-contract.ts',
  'media/reconciliation.ts',
  'media/recovery-log.ts',
  'media/verified-read.ts',
  'modules/actions/record-asset-integrity-failure.action.ts',
] as const;

const withoutComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^[\t ]*\/\/.*$/gmu, '');

/**
 * The one guard recovery code may name: the technical bound on a single platform digest step (`content-digest.ts`),
 * which bounds no object, schedules nothing and retries nothing.
 */
const withoutDigestStepGuard = (code: string): string => code.replaceAll(/\b[Dd]igestStepTimeout\b/gu, '');

/** Time, repetition, scheduling and physical removal: none of them may appear in recovery code. */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['a Schedule or Cron', /\b(?:Schedule|Cron)\b/u],
  ['a timer', /\b(?:setTimeout|setInterval|setImmediate)\b/u],
  [
    'an Effect retry, repeat, schedule, sleep, timeout or delay',
    /Effect\.(?:retry|repeat|schedule|sleep|timeout|delay)\w*/u,
  ],
  [
    'a Stream or Layer time operator',
    /(?:Stream|Layer|Schedule)\.(?:retry|repeat|schedule|timeout|debounce|throttle|aggregateWithin)\w*/u,
  ],
  ['a timeout, interval or deadline name', /\b\w*(?:timeout|interval|deadline|backoff|maxAttempts|attempts)\w*\b/iu],
  ['a Duration', /\bDuration\b/u],
  ['a delete call', /\.delete\(|\bdeleteObject\b|\bremoveObject\b|\bunlink\b/u],
  ['a delete statement', /\bdelete\s+from\b/iu],
];

/** The numbers recovery code may carry: zero, one, and the length of the redacted log reference. */
const ALLOWED_NUMBERS = new Set(['0', '1', '16']);

/** The guard is only worth having if it fails on the shapes it exists for. */
const violationsOf = (code: string): readonly string[] => [
  ...FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([name]) => name),
  ...[...code.matchAll(/(?<![\w.'-])\d[\d_]*(?![\w'-])/gu)]
    .filter(([number]) => !ALLOWED_NUMBERS.has(number))
    .map(([number]) => `the number ${number}`),
];

it('flags every retry, repeat, timeout, schedule and number shape it exists to catch', () => {
  for (const code of [
    'Effect.retry(policy)',
    'Effect.retryOrElse(a, b)',
    'Effect.repeatN(x, 3)',
    'Effect.timeoutOrElse(x)',
    'Effect.scheduleForked(x)',
    'Stream.timeout(x)',
    'const maxAttempts = 3',
    'const readTimeout = slow',
    'const wait = 1_000',
    'setTimeout(f, 0)',
    'Schedule.exponential(x)',
    'repository.delete(id)',
  ]) {
    expect(violationsOf(code).length, code).toBeGreaterThan(0);
  }
  expect(violationsOf('const ref = key.slice(0, 16)')).toEqual([]);
  expect(violationsOf(withoutDigestStepGuard('Effect.service(DigestStepTimeout)'))).toEqual([]);
  expect(violationsOf(withoutDigestStepGuard('const DigestStepTimeoutOverride = slow'))).not.toEqual([]);
});

it.layer(NodeServices.layer, { excludeTestServices: true })('core media recovery guards', (suite) => {
  suite.effect('contains no scheduler, timer, retry, deadline, delete or invented number', () =>
    Effect.gen(function* scan() {
      const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
      const root = yield* path.fromFileUrl(new URL('../../src/', import.meta.url));
      for (const relative of RECOVERY_SOURCES) {
        const code = withoutDigestStepGuard(
          withoutComments(yield* fileSystem.readFileString(path.join(root, relative))),
        );
        for (const [name, pattern] of FORBIDDEN) {
          expect(pattern.test(code), `${relative} contains ${name}`).toBe(false);
        }
        for (const [number] of code.matchAll(/(?<![\w.'-])\d[\d_]*(?![\w'-])/gu)) {
          expect(ALLOWED_NUMBERS.has(number), `${relative} carries the number ${number}`).toBe(true);
        }
      }
    }),
  );

  suite.effect('keeps the provider port without a delete, so no recovery code can remove bytes', () =>
    Effect.gen(function* port() {
      const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
      const root = yield* path.fromFileUrl(new URL('../../src/media/', import.meta.url));
      const code = withoutComments(yield* fileSystem.readFileString(path.join(root, 'object-storage.ts')));
      expect(/\b(?:delete|remove|purge)\w*\s*:/iu.test(code)).toBe(false);
    }),
  );

  suite.effect('lets the S3 adapter send one HTTP DELETE only: the abort of its own unfinished multipart upload', () =>
    Effect.gen(function* adapter() {
      const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
      const root = yield* path.fromFileUrl(new URL('../../src/media/', import.meta.url));
      const code = withoutComments(yield* fileSystem.readFileString(path.join(root, 's3-object-storage.ts')));
      const deletes = [...code.matchAll(/method:\s*'DELETE'(?!\s*\|)/gu)];
      expect(deletes).toHaveLength(1);
      // The one DELETE names the multipart upload id: it can never address an object key on its own.
      const [declaration] = deletes;
      const call = code.slice(Math.max(0, (declaration?.index ?? 0) - 40), (declaration?.index ?? 0) + 200);
      expect(call).toContain('Operations.abort');
      expect(call).toContain('{ uploadId }');
      expect(/\bDeleteObject|\bdeleteObjects?\b|\?delete\b/iu.test(code)).toBe(false);
    }),
  );
});
