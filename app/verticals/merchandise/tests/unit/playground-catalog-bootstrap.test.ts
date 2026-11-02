import { NodeCrypto } from '@effect/platform-node';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  BOOTSTRAP_MAX_BYTES,
  BootstrapBatchSchema,
  PLAYGROUND_COMPANY,
  PLAYGROUND_MANIFEST_DIGEST,
  PLAYGROUND_SOURCE_FINGERPRINT,
  PLAYGROUND_TENANT,
  bootstrapBatchNeedsAppend,
  bootstrapBatches,
  bootstrapCanonicalJson,
  bootstrapDigest,
  bootstrapRejected,
} from '../../shared/domain/playground-catalog-bootstrap.ts';
import type { BootstrapBatch, BootstrapCheckpoint } from '../../shared/domain/playground-catalog-bootstrap.ts';
import { bootstrapPlaygroundCatalogAction } from '../../src/actions/bootstrap-playground-catalog.action.ts';
import {
  assertPlaygroundBootstrapScope,
  runPlaygroundBootstrap,
} from '../../src/services/playground-catalog-bootstrap.ts';
import type { BootstrapTransaction } from '../../src/services/playground-catalog-bootstrap.ts';
import { merchandiseMcpContribution } from '../../shared/mcp/contribution.ts';
import { approvedBootstrapManifest } from '../fixtures/playground-bootstrap-manifest.ts';

const begin = {
  _tag: 'Begin',
  confirmation: 'Initialize empty AKROS playground from the approved frozen source',
  manifest: approvedBootstrapManifest,
} as const;
const verify = { _tag: 'Verify', sourceFingerprint: PLAYGROUND_SOURCE_FINGERPRINT } as const;
const initial: BootstrapCheckpoint = { manifest: approvedBootstrapManifest, nextBatch: 0, status: 'IMPORTING' };
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:bootstrap-test',
  authMethod: 'session',
  legalEntityId: PLAYGROUND_COMPANY,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId: PLAYGROUND_TENANT,
});
const scope = { ...principal, correlationId: 'bootstrap-test' };
const port = (state: BootstrapCheckpoint = initial, nonempty = false) => {
  let saved = state;
  let writes = 0;
  let verifications = 0;
  const transaction: BootstrapTransaction = {
    append: () =>
      Effect.sync(() => {
        writes += 1;
      }),
    begin: () => (nonempty ? Effect.fail(bootstrapRejected('Target merchandise is not empty')) : Effect.succeed(saved)),
    checkpoint: () => Effect.succeed(saved),
    save: (value) =>
      Effect.sync(() => {
        saved = value;
      }),
    verify: () =>
      Effect.sync(() => {
        verifications += 1;
      }),
  };
  return { snapshot: () => ({ saved, verifications, writes }), transaction };
};

it.layer(NodeCrypto.layer)('Playground catalog bootstrap', (suite) => {
  suite.effect('pins the frozen snapshot and all 110 bounded batch digests', () =>
    Effect.gen(function* pinnedManifest() {
      expect(yield* bootstrapDigest(approvedBootstrapManifest)).toBe(PLAYGROUND_MANIFEST_DIGEST);
      expect(approvedBootstrapManifest.batchDigests).toHaveLength(110);
      expect(approvedBootstrapManifest).toMatchObject({ categories: 2125, products: 1289, variants: 19_025 });
      expect(yield* bootstrapDigest({ a: 1, b: 2 })).toBe(
        yield* bootstrapDigest(
          Object.fromEntries([
            ['b', 2],
            ['a', 1],
          ]),
        ),
      );
    }),
  );
  suite.effect('begins and resumes only the exact reviewed import', () =>
    Effect.gen(function* beginAndResume() {
      const fixture = port({ ...initial, nextBatch: 7 });
      expect(yield* runPlaygroundBootstrap(fixture.transaction, begin, 'invocation')).toMatchObject({
        nextBatch: 7,
        status: 'IMPORTING',
      });
      const tampered = { ...begin, manifest: { ...approvedBootstrapManifest, products: 1288 } };
      expect(
        Predicate.isTagged(
          yield* runPlaygroundBootstrap(fixture.transaction, tampered, 'tampered').pipe(Effect.flip),
          'PlaygroundBootstrapRejected',
        ),
      ).toBe(true);
      expect(fixture.snapshot().writes).toBe(0);
    }),
  );
  suite.effect('refuses a non-empty target without any append', () =>
    Effect.gen(function* nonempty() {
      const fixture = port(initial, true);
      expect(
        Predicate.isTagged(
          yield* runPlaygroundBootstrap(fixture.transaction, begin, 'nonempty').pipe(Effect.flip),
          'PlaygroundBootstrapRejected',
        ),
      ).toBe(true);
      expect(fixture.snapshot().writes).toBe(0);
    }),
  );
  suite.effect('refuses a different retained import even if the supplied manifest is approved', () =>
    Effect.gen(function* differentImport() {
      const fixture = port({ ...initial, manifest: { ...approvedBootstrapManifest, categories: 1 } });
      expect(
        Predicate.isTagged(
          yield* runPlaygroundBootstrap(fixture.transaction, begin, 'different').pipe(Effect.flip),
          'PlaygroundBootstrapRejected',
        ),
      ).toBe(true);
    }),
  );
  suite.effect('requires all batches before verifying and publishing', () =>
    Effect.gen(function* incomplete() {
      const fixture = port();
      yield* runPlaygroundBootstrap(fixture.transaction, verify, 'early').pipe(Effect.flip);
      expect(fixture.snapshot().saved.status).toBe('IMPORTING');
      expect(fixture.snapshot().verifications).toBe(0);
      const complete = port({ ...initial, nextBatch: approvedBootstrapManifest.batchDigests.length });
      expect(yield* runPlaygroundBootstrap(complete.transaction, verify, 'finish')).toMatchObject({
        status: 'VERIFIED',
      });
      expect(yield* runPlaygroundBootstrap(complete.transaction, verify, 'finish-again')).toMatchObject({
        status: 'VERIFIED',
      });
      expect(complete.snapshot().verifications).toBe(2);
      expect(complete.snapshot().writes).toBe(0);
    }),
  );
  suite.effect('failed row verification cannot publish the checkpoint', () =>
    Effect.gen(function* verificationFailure() {
      const fixture = port({ ...initial, nextBatch: approvedBootstrapManifest.batchDigests.length });
      const transaction = { ...fixture.transaction, verify: () => Effect.fail(bootstrapRejected('Count mismatch')) };
      yield* runPlaygroundBootstrap(transaction, verify, 'bad-count').pipe(Effect.flip);
      expect(fixture.snapshot().saved.status).toBe('IMPORTING');
    }),
  );
  suite.effect('accepts exact next batches, no-ops identical retries, rejects reordering and tampering', () =>
    Effect.gen(function* batchProgress() {
      const batch: BootstrapBatch = { categories: [], products: [] };
      const digest = yield* bootstrapDigest(batch);
      const checkpoint: BootstrapCheckpoint = {
        ...initial,
        manifest: { ...approvedBootstrapManifest, batchDigests: [digest, digest] },
      };
      expect(yield* bootstrapBatchNeedsAppend(checkpoint, 0, batch)).toBe(true);
      expect(yield* bootstrapBatchNeedsAppend({ ...checkpoint, nextBatch: 1 }, 0, batch)).toBe(false);
      yield* bootstrapBatchNeedsAppend(checkpoint, 1, batch).pipe(Effect.flip);
      yield* bootstrapBatchNeedsAppend({ ...checkpoint, status: 'VERIFIED' }, 0, batch).pipe(Effect.flip);
      yield* bootstrapBatchNeedsAppend(
        { ...checkpoint, manifest: { ...checkpoint.manifest, batchDigests: ['0'.repeat(64)] } },
        0,
        batch,
      ).pipe(Effect.flip);
    }),
  );
  it('has structural batch limits and a deterministic partition for more than 2,000 categories', () => {
    const category = {
      description: '',
      hasChildren: false,
      heading: '',
      id: 'category',
      imageAlt: '',
      imageSrc: '',
      longDescription: '',
      name: 'Category',
      parentId: null,
      position: 0,
      slug: 'category',
    };
    const catalog = Schema.decodeUnknownSync(BootstrapBatchSchema)({ categories: [category], products: [] });
    const [first] = catalog.categories;
    if (first === undefined) {
      return;
    }
    const batches = bootstrapBatches({
      categories: Array.from({ length: 2125 }, (_, index) => ({ ...first, id: `${index}` })),
      products: [],
    });
    expect(batches).toHaveLength(43);
    expect(batches.flatMap((batch) => batch.categories)).toHaveLength(2125);
    for (const batch of batches) {
      expect(batch.categories.length).toBeLessThanOrEqual(50);
      expect(new TextEncoder().encode(bootstrapCanonicalJson(batch)).byteLength).toBeLessThanOrEqual(
        BOOTSTRAP_MAX_BYTES,
      );
    }
    expect(
      Schema.is(BootstrapBatchSchema)({ categories: Array.from({ length: 51 }, () => category), products: [] }),
    ).toBe(false);
  });
  suite.effect('restricts the boundary to stage, the exact tenant/company, and a human session', () =>
    Effect.gen(function* scopeRestrictions() {
      yield* assertPlaygroundBootstrapScope(scope, 'stage');
      for (const environment of ['', 'production', 'development']) {
        yield* assertPlaygroundBootstrapScope(scope, environment).pipe(Effect.flip);
      }
      for (const other of [
        { ...scope, tenantId: 'other-tenant' },
        { ...scope, legalEntityId: 'other-company' },
        { ...scope, authMethod: 'api_key' },
      ]) {
        yield* assertPlaygroundBootstrapScope(other, 'stage').pipe(Effect.flip);
      }
    }),
  );
  suite.effect('requires both explicit executor and tenant administrator permission before owner work', () =>
    Effect.gen(function* administratorGate() {
      for (const permissions of [
        { actionPermission: 'denied', tenantPermission: 'allowed' },
        { actionPermission: 'allowed', tenantPermission: 'denied' },
      ] as const) {
        let calls = 0;
        const harness = yield* makeActionTestHarness({
          ...permissions,
          services: [
            bindActionTestServices(bootstrapPlaygroundCatalogAction, {
              bootstrap: () =>
                Effect.sync(() => {
                  calls += 1;
                  return {
                    nextBatch: 0,
                    sourceFingerprint: PLAYGROUND_SOURCE_FINGERPRINT,
                    status: 'IMPORTING',
                  } as const;
                }),
            }),
          ],
        });
        yield* harness.runtime
          .runAction({
            payload: begin,
            principal,
            registration: bootstrapPlaygroundCatalogAction,
            transport: { correlationId: 'bootstrap-denied', idempotencyKey: 'denied' },
          })
          .pipe(Effect.flip);
        expect(calls).toBe(0);
        expect(harness.snapshot().committed).toHaveLength(0);
      }
    }),
  );
  suite.effect('records an authorized Action once, and Core replay cannot append twice', () =>
    Effect.gen(function* auditAndReplay() {
      let calls = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(bootstrapPlaygroundCatalogAction, {
            bootstrap: () =>
              Effect.sync(() => {
                calls += 1;
                return { nextBatch: 0, sourceFingerprint: PLAYGROUND_SOURCE_FINGERPRINT, status: 'IMPORTING' } as const;
              }),
          }),
        ],
        tenantPermission: 'allowed',
      });
      const request = {
        payload: begin,
        principal,
        registration: bootstrapPlaygroundCatalogAction,
        transport: { correlationId: 'bootstrap-success', idempotencyKey: 'same' },
      };
      yield* harness.runtime.runAction(request);
      expect(
        Predicate.isTagged(yield* harness.runtime.runAction(request).pipe(Effect.flip), 'ActionAlreadyCommitted'),
      ).toBe(true);
      expect(calls).toBe(1);
      expect(harness.snapshot().committed).toHaveLength(1);
      expect(harness.snapshot().committed[0]?.evidence.dataAccessEvents).toMatchObject([
        {
          accessKind: 'read',
          queryHash: `${PLAYGROUND_SOURCE_FINGERPRINT}:Begin:0`,
          resultCount: 1,
          targetResourceId: PLAYGROUND_COMPANY,
          targetResourceType: 'catalog-bootstrap',
        },
      ]);
      expect(merchandiseMcpContribution.actions['bootstrap-playground-catalog']).toBe('hidden');
    }),
  );
});
