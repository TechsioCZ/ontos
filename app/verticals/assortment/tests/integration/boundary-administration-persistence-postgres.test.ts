import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  CreateClosedAssortmentBoundaryPayloadSchema,
  ReplaceClosedAssortmentBoundaryPayloadSchema,
} from '../../shared/actions/boundary-administration.ts';
import type { CreateClosedAssortmentBoundaryPayload } from '../../shared/actions/boundary-administration.ts';
import {
  AssortmentBoundaryResolutionInputSchema,
  resolveAssortmentBoundary,
} from '../../shared/domain/boundary-resolution.ts';
import {
  admissionSetEntries,
  admissionSets,
  assortmentRelations,
  closedBoundaries,
  closedBoundaryEndFacts,
  collectionRevisions,
} from '../../src/database/schema.ts';
import { boundaryMeaningFingerprint } from '../../src/actions/boundary-administration-support.ts';
import {
  boundaryAdministrationPersistenceForScope,
  boundaryRef,
} from '../../src/services/boundary-administration.service.ts';

type OwnerDatabase = TestDatabaseFromClient<typeof coreRelations>;
interface PersistedBoundaryLifecycleFixture {
  effectiveFrom: string;
  effectiveTo?: string;
}
type BoundaryFixture = Readonly<{ database: OwnerDatabase; scope: OperationalScope & { legalEntityId: string } }>;
const t0 = DateTime.makeUnsafe('2030-01-01T00:00:00.000Z');
const t1 = DateTime.makeUnsafe('2030-02-01T00:00:00.000Z');
const t2 = DateTime.makeUnsafe('2030-03-01T00:00:00.000Z');
const t3 = DateTime.makeUnsafe('2030-04-01T00:00:00.000Z');
const BoundaryIdSchema = Schema.String.pipe(Schema.brand('BoundaryId'));
const successSchema = Schema.Struct({ boundaryId: BoundaryIdSchema, created: Schema.Boolean });
const replacementSuccessSchema = Schema.Struct({ createdBoundaryId: BoundaryIdSchema, replaced: Schema.Boolean });
const overlap = { conflict: 'CONCURRENT_OVERLAP', kind: 'conflict' };

const runScoped = <Value>(
  fixture: BoundaryFixture,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, unknown>,
) =>
  fixture.database.transaction((transaction) =>
    Effect.gen(function* runBoundaryOperation() {
      const scoped = yield* installOperationalScope(transaction, fixture.scope);
      return yield* operation(scoped);
    }),
  );

const cleanupFixture = (admin: TestDatabaseFromClient<typeof assortmentRelations>, scope: OperationalScope) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanup() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction.delete(admissionSetEntries).where(eq(admissionSetEntries.tenantId, scope.tenantId));
      yield* transaction.delete(admissionSets).where(eq(admissionSets.tenantId, scope.tenantId));
      yield* transaction.delete(collectionRevisions).where(eq(collectionRevisions.tenantId, scope.tenantId));
      yield* transaction.delete(closedBoundaryEndFacts).where(eq(closedBoundaryEndFacts.tenantId, scope.tenantId));
      yield* transaction.delete(closedBoundaries).where(eq(closedBoundaries.tenantId, scope.tenantId));
    }),
  );

const withFixture = <Value>(run: (fixture: BoundaryFixture) => Effect.Effect<Value, unknown>) =>
  Effect.scoped(
    Effect.gen(function* boundaryFixture() {
      const { admin: client } = yield* testDatabaseClients;
      const database = yield* makeTestDatabaseFromClient(client, coreRelations);
      const admin = yield* makeTestDatabaseFromClient(client, assortmentRelations);
      const scope = {
        authContextRef: `better-auth-session:${randomUUID()}`,
        authMethod: 'session' as const,
        correlationId: randomUUID(),
        legalEntityId: randomUUID(),
        principalId: randomUUID(),
        tenantId: randomUUID(),
      } satisfies OperationalScope;
      yield* Effect.addFinalizer(() => cleanupFixture(admin, scope).pipe(Effect.orDie));
      return yield* run({ database, scope });
    }),
  );

const payload = (
  fixture: BoundaryFixture,
  market: string | null,
  storefront: string | null,
  at = t0,
  subjectId = 'profile-1',
) => {
  const { scope } = fixture;
  const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
    moduleId,
    resourceId,
    resourceType,
    tenantId: scope.tenantId,
  });
  interface CommercialScopeFixture {
    channelRef: ReturnType<typeof ref>;
    commerceMarketRef?: ReturnType<typeof ref>;
    sellingLegalEntityRef: ReturnType<typeof ref>;
    storefrontRef?: ReturnType<typeof ref>;
  }
  const commercialScope: CommercialScopeFixture = {
    channelRef: ref('commerce.channel', 'commerce.channel.channel', 'channel-1'),
    sellingLegalEntityRef: ref('party.registry', 'party.registry.legal-entity', scope.legalEntityId),
  };
  if (market !== null) {
    commercialScope.commerceMarketRef = ref('commerce.market', 'commerce.market.market', market);
  }
  if (storefront !== null) {
    commercialScope.storefrontRef = ref('commerce.storefront', 'commerce.storefront.application', storefront);
  }
  return Schema.decodeUnknownSync(CreateClosedAssortmentBoundaryPayloadSchema)({
    admissionSet: { entries: [] },
    commercialScope,
    decisionPurpose: 'PURCHASE',
    effectiveFrom: DateTime.formatIso(at),
    provenanceRef: 'boundary-acceptance',
    reason: 'Prove complete resulting Boundary state',
    subject: {
      kind: 'RETAIL_CUSTOMER_PROFILE',
      profileRef: ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', subjectId),
    },
  });
};
const common = (fixture: BoundaryFixture, invocationId = randomUUID()) => ({
  actionInvocationId: invocationId,
  actorPrincipalId: fixture.scope.principalId,
  legalEntityId: fixture.scope.legalEntityId,
  tenantId: fixture.scope.tenantId,
});
const create = (fixture: BoundaryFixture, input: CreateClosedAssortmentBoundaryPayload, invocationId = randomUUID()) =>
  runScoped(fixture, (tx) =>
    boundaryAdministrationPersistenceForScope(tx, fixture.scope).create({ ...input, ...common(fixture, invocationId) }),
  );
const created = (fixture: BoundaryFixture, input: CreateClosedAssortmentBoundaryPayload) =>
  create(fixture, input).pipe(Effect.flatMap(Schema.decodeUnknownEffect(successSchema)));
const end = (
  fixture: BoundaryFixture,
  id: string,
  input: CreateClosedAssortmentBoundaryPayload,
  at: DateTime.Utc,
  invocationId = randomUUID(),
) =>
  runScoped(fixture, (tx) =>
    boundaryAdministrationPersistenceForScope(tx, fixture.scope).end({
      ...common(fixture, invocationId),
      boundaryRef: boundaryRef(fixture.scope.tenantId, id),
      effectiveAt: at,
      expectedBasisFingerprint: boundaryMeaningFingerprint(input),
      provenanceRef: input.provenanceRef,
      reason: input.reason,
    }),
  );
const replacement = (
  fixture: BoundaryFixture,
  id: string,
  old: CreateClosedAssortmentBoundaryPayload,
  next: CreateClosedAssortmentBoundaryPayload,
) =>
  Schema.decodeUnknownSync(ReplaceClosedAssortmentBoundaryPayloadSchema)({
    effectiveAt: DateTime.formatIso(next.effectiveFrom),
    existingBoundaryRef: boundaryRef(fixture.scope.tenantId, id),
    expectedExistingBasisFingerprint: boundaryMeaningFingerprint(old),
    proposedAdmissionSet: next.admissionSet,
    proposedCommercialScope: next.commercialScope,
    proposedDecisionPurpose: next.decisionPurpose,
    proposedEffectiveFrom: DateTime.formatIso(next.effectiveFrom),
    proposedSubject: next.subject,
    provenanceRef: next.provenanceRef,
    reason: next.reason,
  });
const replace = (fixture: BoundaryFixture, input: ReturnType<typeof replacement>, invocationId = randomUUID()) =>
  runScoped(fixture, (tx) =>
    boundaryAdministrationPersistenceForScope(tx, fixture.scope).replace({
      ...input,
      ...common(fixture, invocationId),
    }),
  );
const endsFor = (fixture: BoundaryFixture) =>
  runScoped(fixture, (tx) =>
    tx.select().from(closedBoundaryEndFacts).where(eq(closedBoundaryEndFacts.tenantId, fixture.scope.tenantId)),
  );

it.live(
  'persists covered crossing scopes, rejects exposed End, and atomically replaces the covering aggregate',
  () =>
    withFixture((fixture) =>
      Effect.gen(function* coveredCrossing() {
        const aInput = payload(fixture, 'cz', null);
        const cInput = payload(fixture, 'cz', 'x');
        const bInput = payload(fixture, null, 'x');
        const a = yield* created(fixture, aInput);
        const c = yield* created(fixture, cInput);
        const b = yield* created(fixture, bInput);
        expect(yield* create(fixture, cInput)).toEqual(overlap);
        expect(yield* end(fixture, c.boundaryId, cInput, t1)).toEqual(overlap);
        expect(yield* endsFor(fixture)).toHaveLength(0);
        const next = { ...payload(fixture, 'cz', 'x', t1), admissionSet: { entries: [{ kind: 'ALL' as const }] } };
        const intent = replacement(fixture, c.boundaryId, cInput, next);
        const invocation = randomUUID();
        const result = yield* replace(fixture, intent, invocation).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(replacementSuccessSchema)),
        );
        expect(result.replaced).toBe(true);
        expect(yield* replace(fixture, intent, invocation)).toEqual({
          createdBoundaryId: result.createdBoundaryId,
          replaced: false,
        });
        expect(yield* replace(fixture, { ...intent, reason: 'changed' }, invocation)).toEqual({
          conflict: 'IDEMPOTENCY_REUSED',
          kind: 'conflict',
        });
        const moveAway = replacement(fixture, result.createdBoundaryId, next, payload(fixture, 'sk', 'y', t2));
        expect(yield* replace(fixture, moveAway)).toEqual(overlap);
        expect(yield* endsFor(fixture)).toHaveLength(1);
        const rows = yield* runScoped(fixture, (tx) =>
          tx.select().from(closedBoundaries).where(eq(closedBoundaries.tenantId, fixture.scope.tenantId)),
        );
        expect(rows).toHaveLength(4);
        const endFacts = yield* endsFor(fixture);
        const meanings = new Map<string, CreateClosedAssortmentBoundaryPayload>([
          [a.boundaryId, aInput],
          [b.boundaryId, bInput],
          [c.boundaryId, cInput],
          [result.createdBoundaryId, next],
        ]);
        const persisted = rows.map((row) => {
          const meaning = meanings.get(row.closedBoundaryId) ?? next;
          const endFact = endFacts.find((fact) => fact.closedBoundaryId === row.closedBoundaryId);
          const lifecycle: PersistedBoundaryLifecycleFixture = {
            effectiveFrom: DateTime.formatIso(DateTime.makeUnsafe(row.effectiveFrom)),
          };
          if (endFact !== undefined) {
            lifecycle.effectiveTo = DateTime.formatIso(DateTime.makeUnsafe(endFact.effectiveAt));
          }
          return {
            ...lifecycle,
            admissionSet: meaning.admissionSet.entries,
            boundaryRef: boundaryRef(fixture.scope.tenantId, row.closedBoundaryId),
            commercialScope: meaning.commercialScope,
            decisionPurpose: row.purpose,
            subject: meaning.subject,
          };
        });
        const resolveCell = (market: string, storefront: string) => {
          const { commercialScope } = payload(fixture, market, storefront);
          const operationTime = DateTime.formatIso(t1);
          const { tenantId } = fixture.scope;
          const catalogRef = (resourceType: string, resourceId: string) => ({
            moduleId: 'commerce.catalog',
            resourceId,
            resourceType,
            tenantId,
          });
          return resolveAssortmentBoundary(
            Schema.decodeUnknownSync(AssortmentBoundaryResolutionInputSchema)({
              boundaries: persisted,
              completeness: {
                evidence: {
                  predicate: 'complete persisted Boundary fixture',
                  proof: {
                    evidenceRef: {
                      ...boundaryRef(tenantId, 'fixture-proof'),
                      resourceType: 'commerce.assortment.collection-proof',
                    },
                    ownerModuleId: 'commerce.assortment',
                  },
                  scope: 'fixture Boundary scope',
                  state: 'COMPLETE',
                },
                scope: {
                  commercialScope,
                  decisionPurpose: 'PURCHASE',
                  kind: 'APPLICABLE_CLOSED_BOUNDARIES',
                  operationTime,
                  subject: aInput.subject,
                  tenantId,
                },
              },
              decisionPurpose: 'PURCHASE',
              subject: aInput.subject,
              target: {
                kind: 'CATALOG_SELECTION',
                selection: {
                  configuration: { kind: 'NONE' },
                  productRef: catalogRef('commerce.catalog.product', 'product-1'),
                  variantKind: 'ATOMIC',
                  variantRef: catalogRef('commerce.catalog.variant', 'variant-1'),
                },
              },
              tenantId,
              trustedContext: { ...commercialScope, operationTime, tenantId },
            }),
          );
        };
        expect(resolveCell('cz', 'x')).toMatchObject({
          admitted: true,
          boundary: { boundaryRef: { resourceId: result.createdBoundaryId } },
          kind: 'UNIQUE_MAXIMAL_BOUNDARY',
        });
        expect(resolveCell('cz', 'y')).toMatchObject({
          admitted: false,
          boundary: { boundaryRef: { resourceId: a.boundaryId } },
          kind: 'UNIQUE_MAXIMAL_BOUNDARY',
        });
        expect(resolveCell('sk', 'x')).toMatchObject({
          admitted: false,
          boundary: { boundaryRef: { resourceId: b.boundaryId } },
          kind: 'UNIQUE_MAXIMAL_BOUNDARY',
        });
        expect(resolveCell('sk', 'y')).toMatchObject({ kind: 'NO_APPLICABLE_BOUNDARY' });
        expect(yield* end(fixture, a.boundaryId, aInput, t2)).toEqual({ ended: true });
        expect(yield* end(fixture, result.createdBoundaryId, next, t3)).toEqual({ ended: true });
        expect(yield* end(fixture, b.boundaryId, bInput, t3)).toEqual({ ended: true });
      }),
    ),
  30_000,
);

it.live(
  'validates future coverage gaps and adjacent half-open lifecycle segments',
  () =>
    withFixture((fixture) =>
      Effect.gen(function* futureCoverage() {
        const aInput = payload(fixture, 'cz', null);
        const cInput = payload(fixture, 'cz', 'x');
        yield* created(fixture, aInput);
        const c = yield* created(fixture, cInput);
        expect(yield* end(fixture, c.boundaryId, cInput, t2)).toEqual({ ended: true });
        const bInput = payload(fixture, null, 'x', t1);
        expect(yield* create(fixture, bInput)).toEqual(overlap);
        const gapInput = payload(fixture, 'cz', 'x', t3);
        yield* created(fixture, gapInput);
        expect(yield* create(fixture, bInput)).toEqual(overlap);
        yield* created(fixture, payload(fixture, null, 'x', t3));
        const adjacentA = payload(fixture, 'cz', null, t0, 'adjacent-profile');
        const adjacentC = payload(fixture, 'cz', 'x', t0, 'adjacent-profile');
        yield* created(fixture, adjacentA);
        const oldCover = yield* created(fixture, adjacentC);
        expect(yield* end(fixture, oldCover.boundaryId, adjacentC, t2)).toEqual({ ended: true });
        const bridgeInput = payload(fixture, 'cz', 'x', t2, 'adjacent-profile');
        const newCover = yield* created(fixture, bridgeInput);
        const adjacentB = payload(fixture, null, 'x', t1, 'adjacent-profile');
        const b = yield* created(fixture, adjacentB);
        expect(yield* create(fixture, payload(fixture, 'cz', null, t3, 'adjacent-profile'))).toEqual(overlap);
        expect(yield* end(fixture, newCover.boundaryId, bridgeInput, t3)).toEqual(overlap);
        expect(yield* end(fixture, b.boundaryId, adjacentB, t3)).toEqual({ ended: true });
        expect(yield* end(fixture, newCover.boundaryId, bridgeInput, t3)).toEqual({ ended: true });
        yield* created(fixture, payload(fixture, 'cz', null, t1, 'disjoint-profile'));
        yield* created(fixture, payload(fixture, 'sk', null, t1, 'disjoint-profile'));
        yield* created(fixture, payload(fixture, 'cz', 'x', t1, 'disjoint-profile'));
        yield* created(fixture, payload(fixture, 'sk', 'y', t1, 'disjoint-profile'));
      }),
    ),
  30_000,
);

it.live(
  'serializes conflicting Creates and different replacement intents without duplicate lifecycle facts',
  () =>
    withFixture((fixture) =>
      Effect.gen(function* concurrentChanges() {
        const results = yield* Effect.all(
          [create(fixture, payload(fixture, 'cz', null)), create(fixture, payload(fixture, null, 'x'))],
          { concurrency: 2 },
        );
        expect(results.filter((result) => 'created' in result && result.created)).toHaveLength(1);
        expect(results.filter((result) => 'kind' in result && result.kind === 'conflict')).toHaveLength(1);
        const old = payload(fixture, 'sk', 'y', t0, 'other-profile');
        const oldResult = yield* created(fixture, old);
        const next = payload(fixture, 'sk', 'y', t1, 'other-profile');
        const intent = replacement(fixture, oldResult.boundaryId, old, next);
        const replacements = yield* Effect.all(
          [replace(fixture, intent), replace(fixture, { ...intent, reason: 'different intent' })],
          { concurrency: 2 },
        );
        expect(replacements.filter((result) => 'replaced' in result && result.replaced)).toHaveLength(1);
        expect(replacements.filter((result) => 'kind' in result && result.kind === 'conflict')).toHaveLength(1);
        expect(yield* endsFor(fixture)).toHaveLength(1);
        const replayOld = payload(fixture, 'cz', 'y', t0, 'replay-profile');
        const replayBoundary = yield* created(fixture, replayOld);
        const replayIntent = replacement(
          fixture,
          replayBoundary.boundaryId,
          replayOld,
          payload(fixture, 'cz', 'y', t1, 'replay-profile'),
        );
        const invocation = randomUUID();
        const exactReplays = yield* Effect.all(
          [replace(fixture, replayIntent, invocation), replace(fixture, replayIntent, invocation)],
          { concurrency: 2 },
        );
        expect(exactReplays.filter((result) => 'replaced' in result && result.replaced)).toHaveLength(1);
        expect(exactReplays.filter((result) => 'replaced' in result && !result.replaced)).toHaveLength(1);
        const replayIds = exactReplays.flatMap((result) =>
          'createdBoundaryId' in result ? [result.createdBoundaryId] : [],
        );
        expect(new Set(replayIds).size).toBe(1);
        const racingOld = payload(fixture, null, null, t0, 'end-replace-profile');
        const racingBoundary = yield* created(fixture, racingOld);
        const races = yield* Effect.all(
          [
            end(fixture, racingBoundary.boundaryId, racingOld, t1),
            replace(
              fixture,
              replacement(
                fixture,
                racingBoundary.boundaryId,
                racingOld,
                payload(fixture, null, null, t1, 'end-replace-profile'),
              ),
            ),
          ],
          { concurrency: 2 },
        );
        expect(
          races.filter((result) => ('ended' in result && result.ended) || ('replaced' in result && result.replaced)),
        ).toHaveLength(1);
        expect(
          races.filter((result) => 'kind' in result && result.kind === 'conflict' && result.conflict === 'LIFECYCLE'),
        ).toHaveLength(1);
        expect(
          (yield* endsFor(fixture)).filter((row) => row.closedBoundaryId === racingBoundary.boundaryId),
        ).toHaveLength(1);
      }),
    ),
  30_000,
);

it.live(
  'locks both subject groups in one order and rolls back an End when replacement storage fails',
  () =>
    withFixture((fixture) =>
      Effect.gen(function* orderedLocksAndRollback() {
        const leftInput = payload(fixture, 'cz', 'x', t0, 'left-profile');
        const rightInput = payload(fixture, 'sk', 'y', t0, 'right-profile');
        const left = yield* created(fixture, leftInput);
        const right = yield* created(fixture, rightInput);
        const moves = yield* Effect.all(
          [
            replace(
              fixture,
              replacement(fixture, left.boundaryId, leftInput, payload(fixture, 'cz', 'x', t1, 'right-profile')),
            ),
            replace(
              fixture,
              replacement(fixture, right.boundaryId, rightInput, payload(fixture, 'sk', 'y', t1, 'left-profile')),
            ),
          ],
          { concurrency: 2 },
        );
        expect(moves.every((result) => 'replaced' in result && result.replaced)).toBe(true);
        const rollbackInput = payload(fixture, null, null, t0, 'rollback-profile');
        const rollback = yield* created(fixture, rollbackInput);
        const valid = replacement(
          fixture,
          rollback.boundaryId,
          rollbackInput,
          payload(fixture, null, null, t1, 'rollback-profile'),
        );
        const invalidChannel = { ...valid.proposedCommercialScope.channelRef };
        Object.defineProperty(invalidChannel, 'resourceId', { value: ' invalid-padding ' });
        const failure = yield* Effect.exit(
          replace(fixture, {
            ...valid,
            proposedCommercialScope: { ...valid.proposedCommercialScope, channelRef: invalidChannel },
          }),
        );
        expect(Exit.isFailure(failure)).toBe(true);
        const ends = yield* endsFor(fixture);
        expect(ends.some((row) => row.closedBoundaryId === rollback.boundaryId)).toBe(false);
        expect(yield* replace(fixture, valid)).toMatchObject({ replaced: true });
      }),
    ),
  30_000,
);
