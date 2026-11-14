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
  declaredEvidenceCallInsideTransaction,
  insideDatabaseTransaction,
  refuseInsideDatabaseTransaction,
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
      /\b(?:PgClient\.make|openDatabaseClient)\(/u.test(source),
    ).filter((file) => file !== 'packages/core-runtime/src/db/database-client.ts'),
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

const evidence = declaredEvidenceCallInsideTransaction({ evidence: 'test.owner-proof', owner: 'test.owner' });
const callFetch = (url: string) =>
  Effect.flatMap(Effect.service(FetchHttpClient.Fetch), (fetch) =>
    Effect.tryPromise({ catch: (cause) => cause, try: () => fetch(url) }),
  );
const withStubFetch = <Value, Failure, Requirements>(
  effect: (calls: string[]) => Effect.Effect<Value, Failure, Requirements>,
) => {
  const calls: string[] = [];
  const stub: typeof globalThis.fetch = (input) => {
    calls.push(String(input));
    return Promise.resolve(new Response('owner proof'));
  };
  return effect(calls).pipe(Effect.provideService(FetchHttpClient.Fetch, stub));
};
const defectOf = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

it.effect('still refuses an undeclared fetch inside a marked transaction', () =>
  withStubFetch((calls) =>
    Effect.gen(function* undeclaredFetch() {
      const exit = yield* callFetch('https://owner.test/proof').pipe(
        insideDatabaseTransaction('test.undeclared'),
        Effect.exit,
      );
      expect(defectOf(exit)).toBeInstanceOf(IoInsideDatabaseTransaction);
      expect(defectOf(exit)).toMatchObject({ io: 'outbound-fetch', operationKey: 'test.undeclared' });
      expect(calls).toEqual([]);
    }),
  ),
);

it.effect('lets a declared evidence call reach the fetch the mark replaced, then restores the mark', () =>
  withStubFetch((calls) =>
    Effect.gen(function* declaredFetch() {
      const original = yield* FetchHttpClient.Fetch;
      yield* Effect.gen(function* insideMark() {
        const mark = yield* OpenDatabaseTransaction;
        const refusing = yield* FetchHttpClient.Fetch;
        const response = yield* callFetch('https://owner.test/proof').pipe(evidence);
        expect(response.status).toBe(200);
        expect(calls).toEqual(['https://owner.test/proof']);
        expect(yield* OpenDatabaseTransaction).toBe(mark);
        expect(yield* FetchHttpClient.Fetch).toBe(refusing);
        expect(refusing).not.toBe(original);
      }).pipe(insideDatabaseTransaction('test.declared'));
    }),
  ),
);

it.effect('lifts SpiceDB and module-transport refusals only inside the declared effect', () =>
  Effect.gen(function* transportRefusals() {
    yield* Effect.gen(function* insideMark() {
      expect(defectOf(yield* Effect.exit(refuseInsideDatabaseTransaction('spicedb', 'CheckPermission')))).toMatchObject({
        io: 'spicedb',
      });
      expect(
        Exit.isSuccess(
          yield* Effect.exit(
            Effect.all([
              refuseInsideDatabaseTransaction('spicedb', 'CheckPermission'),
              refuseInsideDatabaseTransaction('module-transport', 'test.module'),
            ]).pipe(evidence),
          ),
        ),
      ).toBe(true);
      expect(
        defectOf(yield* Effect.exit(refuseInsideDatabaseTransaction('module-transport', 'test.module'))),
      ).toMatchObject({ io: 'module-transport', operationKey: 'test.transports' });
    }).pipe(insideDatabaseTransaction('test.transports'));
  }),
);

it.effect('keeps refusing a second pool acquisition inside a declared evidence call', () =>
  Effect.gen(function* poolStillGuarded() {
    const exit = yield* refuseInsideDatabaseTransaction('pool-acquisition', 'PostgreSQL connection pool').pipe(
      evidence,
      insideDatabaseTransaction('test.pool'),
      Effect.exit,
    );
    expect(defectOf(exit)).toBeInstanceOf(IoInsideDatabaseTransaction);
    expect(defectOf(exit)).toMatchObject({ io: 'pool-acquisition', operationKey: 'test.pool' });
  }),
);

it.effect('gives a declared call inside nested marks the outermost original fetch', () =>
  withStubFetch((calls) =>
    Effect.gen(function* nestedMarks() {
      yield* callFetch('https://owner.test/nested').pipe(
        evidence,
        insideDatabaseTransaction('test.inner'),
        insideDatabaseTransaction('test.outer'),
      );
      expect(calls).toEqual(['https://owner.test/nested']);
      const inner = yield* Effect.service(OpenDatabaseTransaction).pipe(
        insideDatabaseTransaction('test.inner-after'),
        evidence,
        insideDatabaseTransaction('test.outer-after'),
      );
      expect(inner.pipe(Option.map((mark) => mark.operationKey))).toEqual(Option.some('test.inner-after'));
    }),
  ),
);

it.effect('is the identity outside any marked transaction', () =>
  withStubFetch((calls) =>
    Effect.gen(function* identity() {
      const fetch = yield* FetchHttpClient.Fetch;
      const observed = yield* Effect.all([Effect.service(OpenDatabaseTransaction), Effect.service(FetchHttpClient.Fetch)]).pipe(
        evidence,
      );
      expect(Option.isNone(observed[0])).toBe(true);
      expect(observed[1]).toBe(fetch);
      yield* callFetch('https://owner.test/outside').pipe(evidence);
      yield* refuseInsideDatabaseTransaction('pool-acquisition', 'PostgreSQL connection pool').pipe(evidence);
      expect(calls).toEqual(['https://owner.test/outside']);
    }),
  ),
);
