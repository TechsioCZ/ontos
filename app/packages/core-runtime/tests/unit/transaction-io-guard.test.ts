// @effect-diagnostics nodeBuiltinImport:off -- Synchronous static scan of the workspace sources; remove-when: the transport boundary becomes an oxlint rule.
import { readFileSync, readdirSync } from 'node:fs';
import nodePath from 'node:path';

import { Cause, Effect, Exit, Option, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { withPostgresSessionAdvisoryLock } from '../../src/db/session-advisory-lock.ts';
import {
  IoInsideDatabaseTransaction,
  OpenDatabaseTransaction,
  insideDatabaseTransaction,
} from '../../src/db/transaction-io-guard.ts';

const appRoot = new URL('../../../../', import.meta.url).pathname;
const skippedDirectories = new Set(['.git', 'dist', 'node_modules', 'tests', 'test', 'fixtures', '.modern', 'build']);

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name) || entry.name.startsWith('.')
        ? []
        : sourceFiles(nodePath.join(directory, entry.name));
    }
    return /\.(?:c|m)?tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts')
      ? [nodePath.join(directory, entry.name)]
      : [];
  });

const sourcesMatching = (roots: readonly string[], allowed: string, matches: (source: string) => boolean) =>
  roots.flatMap((root) =>
    sourceFiles(nodePath.join(appRoot, root))
      .map((file) => nodePath.relative(appRoot, file))
      .filter((file) => file !== allowed)
      .filter((file) => matches(readFileSync(nodePath.join(appRoot, file), 'utf-8'))),
  );

// The runtime refuses remote I/O inside a marked transaction only because every transport is opened behind
// the guard. A second way to a platform transport, or a second Core pool, would bypass it.
it('opens the SpiceDB transport only behind the transaction guard', () => {
  expect(
    sourcesMatching(
      ['packages', 'verticals', 'apps'],
      'packages/core-runtime/src/permissions/spicedb-transaction-guard.ts',
      (source) => source.includes("'#spicedb-transport'") || /\bspiceDbTransport\.open\(/u.test(source),
    ),
  ).toEqual([]);
});

it('reaches module releases only through the guarded module transport', () => {
  expect(
    sourcesMatching(
      ['packages', 'verticals', 'apps'],
      'packages/core-runtime/src/http/unit-service-fetch.export.ts',
      (source) => source.includes("'#unit-service-fetch'"),
    ),
  ).toEqual([]);
});

it('creates the Core connection pool only behind the pool guard', () => {
  expect(
    sourcesMatching(['packages/core-runtime/src'], 'packages/core-runtime/src/db/client.ts', (source) =>
      /\bPgClient\.make\(/u.test(source),
    ),
  ).toEqual([]);
});

it.effect('refuses a private advisory-lock session before connection acquisition inside a marked transaction', () =>
  Effect.gen(function* refusePrivateSessionAcquisition() {
    let operationRan = false;
    const result = yield* withPostgresSessionAdvisoryLock(
      Redacted.make('postgresql://localhost:1/unused'),
      'transaction-guard-private-session',
      Effect.sync(() => {
        operationRan = true;
      }),
    ).pipe(insideDatabaseTransaction('test.private-session'), Effect.exit);
    if (!Exit.isFailure(result)) {
      expect.unreachable('Private session acquisition must refuse a marked transaction');
    }
    const defect = Cause.squash(result.cause);
    expect(defect).toBeInstanceOf(IoInsideDatabaseTransaction);
    expect(defect).toMatchObject({ io: 'pool-acquisition', operationKey: 'test.private-session' });
    expect(operationRan).toBe(false);
  }),
);

it.effect('restores transaction references after nested marks and defects', () =>
  Effect.gen(function* restoreTransactionReferences() {
    const originalMark = yield* OpenDatabaseTransaction;
    const originalFetch = yield* FetchHttpClient.Fetch;
    yield* Effect.gen(function* outerTransactionMark() {
      const outerMark = yield* OpenDatabaseTransaction;
      const outerFetch = yield* FetchHttpClient.Fetch;
      expect(outerMark.pipe(Option.map((mark) => mark.operationKey))).toEqual(Option.some('outer'));
      expect(outerFetch).not.toBe(originalFetch);
      const innerMark = yield* OpenDatabaseTransaction.pipe(insideDatabaseTransaction('inner'));
      expect(innerMark.pipe(Option.map((mark) => mark.operationKey))).toEqual(Option.some('inner'));
      expect(yield* OpenDatabaseTransaction).toBe(outerMark);
      expect(yield* FetchHttpClient.Fetch).toBe(outerFetch);
      const failed = yield* Effect.die('transaction-test-defect').pipe(
        insideDatabaseTransaction('failed-inner'),
        Effect.exit,
      );
      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* OpenDatabaseTransaction).toBe(outerMark);
      expect(yield* FetchHttpClient.Fetch).toBe(outerFetch);
    }).pipe(insideDatabaseTransaction('outer'));
    expect(yield* OpenDatabaseTransaction).toBe(originalMark);
    expect(yield* FetchHttpClient.Fetch).toBe(originalFetch);
  }),
);
