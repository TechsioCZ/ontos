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
  'media/cleanup-eligibility.ts',
  'media/integrity-contract.ts',
  'media/reconciliation.ts',
  'media/recovery-log.ts',
  'media/verified-read.ts',
  'modules/actions/record-asset-integrity-failure.action.ts',
] as const;

const withoutComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^\s*\/\/.*$/gmu, '');

/** Time, repetition, scheduling and physical removal: none of them may appear in recovery code. */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['a Schedule or Cron', /\b(?:Schedule|Cron)\b/u],
  ['a timer', /\b(?:setTimeout|setInterval|setImmediate)\b/u],
  ['a retry, repeat, sleep or timeout', /Effect\.(?:retry|repeat|schedule|sleep|timeout|timeoutOption|delay)\b/u],
  ['a Duration', /\bDuration\b/u],
  ['a delete call', /\.delete\(|\bdeleteObject\b|\bremoveObject\b|\bunlink\b/u],
  ['a delete statement', /\bdelete\s+from\b/iu],
];

/** The one number recovery code may carry: the length of the redacted log reference. */
const ALLOWED_NUMBERS = new Set(['16']);

it.layer(NodeServices.layer, { excludeTestServices: true })('core media recovery guards', (suite) => {
  suite.effect('contains no scheduler, timer, retry, deadline, delete or invented number', () =>
    Effect.gen(function* scan() {
      const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
      const root = yield* path.fromFileUrl(new URL('../../src/', import.meta.url));
      for (const relative of RECOVERY_SOURCES) {
        const code = withoutComments(yield* fileSystem.readFileString(path.join(root, relative)));
        for (const [name, pattern] of FORBIDDEN) {
          expect(pattern.test(code), `${relative} contains ${name}`).toBe(false);
        }
        for (const [number] of code.matchAll(/(?<![\w.'-])\d{2,}(?![\w'-])/gu)) {
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
});
