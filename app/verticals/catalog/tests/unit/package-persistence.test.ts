import { readFileSync } from 'node:fs';

import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CreatePackageDefinitionPayloadSchema } from '../../shared/actions/create-package-definition.ts';
import { RetirePackageDefinitionPayloadSchema } from '../../shared/actions/retire-package-definition.ts';
import { RevisePackageDefinitionPayloadSchema } from '../../shared/actions/revise-package-definition.ts';
import { packageContentRevisions, packageDefinitions, productVariants, products } from '../../src/database/schema.ts';
import {
  packagePersistenceForScope,
  PackagePersistenceUnavailable,
  resolveEffectiveRevision,
} from '../../src/persistence/package-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const packageId = '55555555-5555-4555-8555-555555555555';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:package-persistence-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'package-persistence-test',
};
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: `commerce.catalog.${resourceType}`,
  tenantId,
});
const payload = Schema.decodeUnknownSync(CreatePackageDefinitionPayloadSchema)({
  content: {
    amount: '10',
    effectiveAt: '2026-09-17T10:00:00.000Z',
    form: { productRef: ref('product', productId), variantRef: ref('variant', variantId) },
    unitRef: ref('product-unit', '66666666-6666-4666-8666-666666666666'),
  },
  definitionRef: ref('package-definition', packageId),
  evidenceRefs: ['catalog-record:package-1'],
  reason: 'Verified catalog packaging',
});
const evidence = { actionInvocationId: '77777777-7777-4777-8777-777777777777', principalId };
const selected = () => ({
  where: () => ({ for: () => ({ limit: () => Effect.succeed([{ lifecycleState: 'ACTIVE', productId, variantId }]) }) }),
});
const staleSelection = () => ({
  where: () => ({
    for: () => ({ limit: () => Effect.succeed([{ currentRevision: 2, packageDefinitionId: packageId }]) }),
  }),
});
const activeOptionSelection = () => ({
  where: () => ({
    for: () => ({
      limit: () =>
        Effect.succeed([
          {
            currentRevision: 1,
            lifecycleState: 'ACTIVE',
            optionState: 'ACTIVE',
            packageDefinitionId: packageId,
          },
        ]),
    }),
  }),
});
const futureDefinitionSelection = () => ({
  where: () => ({
    for: () => ({
      limit: () =>
        Effect.succeed([
          { currentRevision: 1, lifecycleState: 'ACTIVE', packageDefinitionId: packageId, productId, variantId },
        ]),
    }),
  }),
});
const contentSelection = (pending: boolean) => {
  let reads = 0;
  return () => ({
    where: () => ({
      limit: () => {
        const isPrior = reads === 0;
        reads += 1;
        if (isPrior) {
          return Effect.succeed([{ effectiveAt: new Date('2026-01-01T00:00:00.000Z') }]);
        }
        return Effect.succeed(pending ? [{ effectiveAt: new Date('2099-01-01T00:00:00.000Z'), revision: 2 }] : []);
      },
    }),
  });
};

const resolved = (revisions: readonly { readonly effectiveAt: Date; readonly revision: number }[], at: Date) =>
  Match.value(resolveEffectiveRevision(revisions, at)).pipe(
    Match.tag('resolved', ({ revision }) => revision),
    Match.orElse(() => 0),
  );

describe('effective Package content revision', () => {
  const first = { effectiveAt: new Date('2026-01-01T00:00:00.000Z'), revision: 1 };
  const next = { effectiveAt: new Date('2099-01-01T00:00:00.000Z'), revision: 2 };
  it('uses half-open intervals before, at, and after a scheduled successor', () => {
    expect(resolved([next, first], new Date('2098-12-31T23:59:59.999Z'))).toBe(1);
    expect(resolved([first, next], new Date('2099-01-01T00:00:00.000Z'))).toBe(2);
    expect(resolved([first, next], new Date('2100-01-01T00:00:00.000Z'))).toBe(2);
    expect(resolved([first, next], new Date('2025-01-01T00:00:00.000Z'))).toBe(0);
  });
  it('rejects duplicate effectiveness and gaps in revision history', () => {
    expect(resolved([first, { ...next, effectiveAt: first.effectiveAt }], next.effectiveAt)).toBe(0);
    expect(resolved([first, { ...next, revision: 3 }], next.effectiveAt)).toBe(0);
  });
});

it('migrates pre-intent content rows as unclassified without inventing a physical change', () => {
  const migration = readFileSync(
    new URL('../../drizzle/20260918054950_thick_agent_zero/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migration).toContain('ADD COLUMN "change_kind" text DEFAULT \'legacy_unclassified\' NOT NULL');
  expect(migration).toContain('"change_kind" = \'correction\'');
  expect(migration).toContain('"prior_error_explanation" is not null');
});

describe('Package persistence', () => {
  it.effect('appends an immutable draft revision only after trusted basis verification', () =>
    Effect.gen(function* createDraft() {
      const writes: unknown[] = [];
      const transaction = {
        insert: (table: typeof packageDefinitions | typeof packageContentRevisions) => ({
          values: (value: typeof packageDefinitions.$inferInsert | typeof packageContentRevisions.$inferInsert) => {
            writes.push([table, value]);
            return table === packageDefinitions
              ? { returning: () => Effect.succeed([{ ...value, currentRevision: 1, lifecycleState: 'DRAFT' }]) }
              : Effect.succeed([]);
          },
        }),
        select: () => ({
          from: (table: typeof products | typeof productVariants) => {
            expect(table === products || table === productVariants).toBe(true);
            return selected();
          },
        }),
      };
      const basis = { verify: () => Effect.succeed(true) };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = packagePersistenceForScope(transaction, scope, basis);
      const outcome = yield* service.create({ ...evidence, payload });
      expect(
        Match.value(outcome).pipe(
          Match.tag('created', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(writes).toEqual([
        [packageDefinitions, expect.objectContaining({ lifecycleState: 'DRAFT', optionState: 'NOT_SELECTABLE' })],
        [
          packageContentRevisions,
          expect.objectContaining({
            amount: '10',
            changeKind: 'physical_change',
            priorErrorExplanation: null,
            revision: 1,
            unitResourceId: payload.content.unitRef.resourceId,
            unitResourceType: 'commerce.catalog.product-unit',
          }),
        ],
      ]);
    }),
  );

  it.effect('fails closed without an authoritative Unit and Current basis before any write', () =>
    Effect.gen(function* noBasis() {
      const transaction = {
        insert: () => {
          throw new Error('No package write may occur without the basis');
        },
        select: () => ({ from: () => selected() }),
        update: () => {
          throw new Error('No package update may occur without the basis');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = packagePersistenceForScope(transaction, scope);
      const error = yield* service.create({ ...evidence, payload }).pipe(Effect.flip);
      expect(Schema.is(PackagePersistenceUnavailable)(error)).toBe(true);
    }),
  );

  it.effect('rejects a cross-Tenant Package reference before reading or writing', () =>
    Effect.gen(function* crossTenant() {
      const transaction = {
        select: () => {
          throw new Error('Cross-Tenant input must be rejected first');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = packagePersistenceForScope(transaction, scope);
      const outcome = yield* service.create({
        ...evidence,
        payload: {
          ...payload,
          definitionRef: { ...payload.definitionRef, tenantId: '88888888-8888-4888-8888-888888888888' },
        },
      });
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('rejects a noncanonical Unit resource type before reading or writing', () =>
    Effect.gen(function* wrongUnitType() {
      const transaction = {
        select: () => {
          throw new Error('Noncanonical Unit must be rejected first');
        },
      };
      const legacyPayload = Schema.decodeUnknownSync(CreatePackageDefinitionPayloadSchema)({
        ...payload,
        content: { ...payload.content, unitRef: ref('unit', payload.content.unitRef.resourceId) },
      });
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = packagePersistenceForScope(transaction, scope);
      const outcome = yield* service.create({ ...evidence, payload: legacyPayload });
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('returns a stale revision without invoking Current-basis verification or writing', () =>
    Effect.gen(function* stale() {
      const transaction = {
        select: () => ({ from: () => staleSelection() }),
        update: () => {
          throw new Error('Stale request must not write');
        },
      };
      const revisionPayload = Schema.decodeUnknownSync(RevisePackageDefinitionPayloadSchema)({
        changeKind: 'physical_change',
        content: payload.content,
        evidenceRefs: payload.evidenceRefs,
        expectedCurrent: { resourceRef: ref('package-definition', packageId), revision: 1 },
        reason: payload.reason,
      });
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = packagePersistenceForScope(transaction, scope);
      const outcome = yield* service.revise({ ...evidence, payload: revisionPayload });
      expect(
        Match.value(outcome).pipe(
          Match.tag('stale', ({ actualRevision }) => actualRevision),
          Match.orElse(() => 0),
        ),
      ).toBe(2);
    }),
  );

  it.effect('rejects an unexplained correction before reading or writing content history', () =>
    Effect.gen(function* unexplainedCorrection() {
      const transaction = {
        select: () => {
          throw new Error('Missing correction evidence must be rejected first');
        },
      };
      const revisionPayload = Schema.decodeUnknownSync(RevisePackageDefinitionPayloadSchema)({
        changeKind: 'correction',
        content: payload.content,
        evidenceRefs: payload.evidenceRefs,
        expectedCurrent: { resourceRef: ref('package-definition', packageId), revision: 1 },
        reason: 'Correct a claimed error',
      });
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = packagePersistenceForScope(transaction, scope);
      const outcome = yield* service.revise({ ...evidence, payload: revisionPayload });
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('keeps effective Current unchanged when a successor is scheduled for the future', () =>
    Effect.gen(function* futureSuccessor() {
      const revisionPayload = Schema.decodeUnknownSync(RevisePackageDefinitionPayloadSchema)({
        changeKind: 'physical_change',
        content: { ...payload.content, effectiveAt: '2099-01-01T00:00:00.000Z' },
        evidenceRefs: payload.evidenceRefs,
        expectedCurrent: { resourceRef: ref('package-definition', packageId), revision: 1 },
        reason: payload.reason,
      });
      const writes: unknown[] = [];
      const selectContent = contentSelection(false);
      const transaction = {
        insert: (table: typeof packageContentRevisions) => ({
          values: (value: typeof packageContentRevisions.$inferInsert) => {
            writes.push([table, value]);
            return Effect.succeed([]);
          },
        }),
        select: () => ({
          from: (table: typeof packageDefinitions | typeof packageContentRevisions) =>
            table === packageDefinitions ? futureDefinitionSelection() : selectContent(),
        }),
        update: () => {
          throw new Error('Future content must not advance Current');
        },
      };
      const basis = { verify: () => Effect.succeed(true) };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = packagePersistenceForScope(transaction, scope, basis);
      const outcome = yield* service.revise({ ...evidence, payload: revisionPayload });
      expect(
        Match.value(outcome).pipe(
          Match.tag('revised', ({ contentRevision }) => contentRevision.revision),
          Match.orElse(() => 0),
        ),
      ).toBe(2);
      expect(writes).toEqual([
        [
          packageContentRevisions,
          expect.objectContaining({ changeKind: 'physical_change', priorErrorExplanation: null, revision: 2 }),
        ],
      ]);
    }),
  );

  it.effect('persists a correction explanation in a new row without changing the historical revision', () =>
    Effect.gen(function* corrected() {
      const prior = { amount: '10', effectiveAt: new Date('2026-01-01T00:00:00.000Z'), revision: 1 };
      const writes: (typeof packageContentRevisions.$inferInsert)[] = [];
      let contentReads = 0;
      const readContent = () => {
        contentReads += 1;
        return Effect.succeed(contentReads === 1 ? [prior] : []);
      };
      const transaction = {
        insert: (table: typeof packageContentRevisions) => ({
          values: (value: typeof packageContentRevisions.$inferInsert) => {
            expect(table).toBe(packageContentRevisions);
            writes.push(value);
            return Effect.succeed([]);
          },
        }),
        select: () => ({
          from: (table: typeof packageDefinitions | typeof packageContentRevisions) =>
            table === packageDefinitions
              ? futureDefinitionSelection()
              : {
                  where: () => ({
                    limit: readContent,
                  }),
                },
        }),
        update: () => {
          throw new Error('A scheduled correction must not advance Current');
        },
      };
      const revisionPayload = Schema.decodeUnknownSync(RevisePackageDefinitionPayloadSchema)({
        changeKind: 'correction',
        content: { ...payload.content, amount: '8', effectiveAt: '2099-01-01T00:00:00.000Z' },
        evidenceRefs: payload.evidenceRefs,
        expectedCurrent: { resourceRef: ref('package-definition', packageId), revision: 1 },
        priorErrorExplanation: 'The source carton count was transcribed incorrectly',
        reason: 'Correct the recorded carton count',
      });
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = packagePersistenceForScope(transaction, scope, { verify: () => Effect.succeed(true) });
      const outcome = yield* service.revise({ ...evidence, payload: revisionPayload });
      expect(
        Match.value(outcome).pipe(
          Match.tag('revised', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(prior).toEqual({ amount: '10', effectiveAt: new Date('2026-01-01T00:00:00.000Z'), revision: 1 });
      expect(writes).toEqual([
        expect.objectContaining({
          amount: '8',
          changeKind: 'correction',
          priorErrorExplanation: 'The source carton count was transcribed incorrectly',
          revision: 2,
        }),
      ]);
    }),
  );

  it.effect('rejects a conflicting pending schedule without overwriting Current or history', () =>
    Effect.gen(function* conflictingSchedule() {
      const selectContent = contentSelection(true);
      const transaction = {
        insert: () => {
          throw new Error('Existing schedule must remain immutable');
        },
        select: () => ({
          from: (table: typeof packageDefinitions | typeof packageContentRevisions) =>
            table === packageDefinitions ? futureDefinitionSelection() : selectContent(),
        }),
        update: () => {
          throw new Error('Current must remain unchanged');
        },
      };
      const revisionPayload = Schema.decodeUnknownSync(RevisePackageDefinitionPayloadSchema)({
        changeKind: 'physical_change',
        content: { ...payload.content, effectiveAt: '2100-01-01T00:00:00.000Z' },
        evidenceRefs: payload.evidenceRefs,
        expectedCurrent: { resourceRef: ref('package-definition', packageId), revision: 1 },
        reason: payload.reason,
      });
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = packagePersistenceForScope(transaction, scope, { verify: () => Effect.succeed(true) });
      const outcome = yield* service.revise({ ...evidence, payload: revisionPayload });
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid', ({ reason }) => reason),
          Match.orElse(() => ''),
        ),
      ).toBe('A successor content revision is already scheduled');
    }),
  );

  it.effect(
    'does not silently retire an ACTIVE Option when Definition retirement lacks role history and selection impact',
    () =>
      Effect.gen(function* activeOption() {
        const transaction = {
          insert: () => {
            throw new Error('No incomplete role/content history may be written');
          },
          select: () => ({ from: () => activeOptionSelection() }),
          update: () => {
            throw new Error('ACTIVE Option must remain unchanged');
          },
        };
        const retirePayload = Schema.decodeUnknownSync(RetirePackageDefinitionPayloadSchema)({
          evidenceRefs: payload.evidenceRefs,
          expectedCurrent: { resourceRef: ref('package-definition', packageId), revision: 1 },
          reason: payload.reason,
        });
        const basis = { verify: () => Effect.succeed(true) };
        // @ts-expect-error Only the exercised Drizzle query chains are mocked.
        const service = packagePersistenceForScope(transaction, scope, basis);
        const failure = yield* service.retire({ ...evidence, payload: retirePayload }).pipe(Effect.flip);
        expect(Schema.is(PackagePersistenceUnavailable)(failure)).toBe(true);
      }),
  );
});
