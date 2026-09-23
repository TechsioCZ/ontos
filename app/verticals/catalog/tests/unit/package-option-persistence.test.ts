import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { packageContentRevisions, packageDefinitions, packageOptionRoleRevisions } from '../../src/database/schema.ts';
import type { productUnits, productVariants, products } from '../../src/database/schema.ts';
import {
  packageOptionPersistenceForScope,
  PackageOptionPersistenceUnavailable,
} from '../../src/persistence/package-option-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const packageDefinitionId = '55555555-5555-4555-8555-555555555555';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:package-option-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'package-option-test',
};
const input = {
  actionInvocationId: '77777777-7777-4777-8777-777777777777',
  expectedContentRevision: 1,
  expectedOptionRevision: 0,
  packageDefinitionId,
};
const definition = {
  currentOptionRevision: 0,
  currentRevision: 1,
  lifecycleState: 'ACTIVE',
  optionState: 'NOT_SELECTABLE',
  packageDefinitionId,
  productId,
  tenantId,
  variantId,
};
const content = {
  effectiveAt: new Date('1900-01-01T00:00:00.000Z'),
  lifecycleState: 'ACTIVE',
  packageDefinitionId,
  productId,
  revision: 1,
  tenantId,
  unitResourceId: '66666666-6666-4666-8666-666666666666',
  unitResourceType: 'commerce.catalog.product-unit',
  variantId,
};
const finding = {
  evidenceRefs: ['request-evidence:sealed-box'],
  independentlyRequested: true,
  looseUnitsSubstitutable: false,
  validationReason: 'Original sealed box is independently requested',
};

type Table =
  | typeof packageDefinitions
  | typeof packageContentRevisions
  | typeof products
  | typeof productVariants
  | typeof productUnits
  | typeof packageOptionRoleRevisions;
type WriteValue = Partial<typeof packageDefinitions.$inferInsert> | typeof packageOptionRoleRevisions.$inferInsert;
type Write = readonly [Table, WriteValue];
type DefinitionFixture = typeof definition;

const lockedRows = (table: Table, current: DefinitionFixture) =>
  table === packageDefinitions ? [current] : [{ lifecycleState: 'ACTIVE' }];
const contentRows = (table: Table, current: DefinitionFixture, revisions: readonly (typeof content)[]) => {
  if (table === packageContentRevisions) {
    return revisions;
  }
  if (table === packageOptionRoleRevisions) {
    return [
      {
        contentRevision: current.currentRevision,
        evidenceRefs: finding.evidenceRefs,
        independentlyRequested: true,
        looseUnitsSubstitutable: false,
        productId,
        state: current.optionState,
        variantId,
      },
    ];
  }
  return [{ lifecycleState: 'ACTIVE' }];
};
const queryFor = (table: Table, current: DefinitionFixture, revisions: readonly (typeof content)[]) => {
  const lockedLimit = () => Effect.succeed(lockedRows(table, current));
  const plainRows = Effect.succeed(contentRows(table, current, revisions));
  return { where: () => ({ for: () => ({ limit: lockedLimit }), limit: () => plainRows, pipe: () => plainRows }) };
};
const updateFor = (table: Table, writes: Write[], current: DefinitionFixture) => ({
  set: (value: Partial<typeof packageDefinitions.$inferInsert>) => ({
    where: () => ({
      returning: () => {
        writes.push([table, value]);
        return Effect.succeed([{ ...current, ...value }]);
      },
    }),
  }),
});
const insertFor = (table: Table, writes: Write[]) => ({
  values: (value: typeof packageOptionRoleRevisions.$inferInsert) => {
    writes.push([table, value]);
    return Effect.succeed([]);
  },
});
const mockTransaction = (
  writes: Write[],
  current = definition,
  revisions: readonly (typeof content)[] = [content],
) => ({
  insert: (table: Table) => insertFor(table, writes),
  select: () => ({ from: (table: Table) => queryFor(table, current, revisions) }),
  update: (table: Table) => updateFor(table, writes, current),
});

describe('Package Option persistence', () => {
  it.effect('fails closed without trusted role and open-selection authorities before a write', () =>
    Effect.gen(function* noAuthority() {
      const writes: Write[] = [];
      // @ts-expect-error Only exercised Drizzle chains are mocked.
      const service = packageOptionPersistenceForScope(mockTransaction(writes), scope);
      const error = yield* service.activate(input).pipe(Effect.flip);
      expect(Schema.is(PackageOptionPersistenceUnavailable)(error)).toBe(true);
      expect(writes).toEqual([]);
    }),
  );

  it.effect('records a separate immutable role revision only after trusted role and impact proof', () =>
    Effect.gen(function* activate() {
      const writes: Write[] = [];
      const service = packageOptionPersistenceForScope(
        // @ts-expect-error Only exercised Drizzle chains are mocked.
        mockTransaction(writes),
        scope,
        { verify: () => Effect.succeed(Option.some(finding)) },
        { verify: () => Effect.succeed(true) },
      );
      const outcome = yield* service.activate(input);
      const changed = Match.value(outcome).pipe(
        Match.tag('changed', (value) => value),
        Match.orElse(() => null),
      );
      expect(changed).toMatchObject({ contentRevision: 1, optionRevision: 1, state: 'ACTIVE' });
      expect(writes).toEqual([
        [packageDefinitions, expect.objectContaining({ currentOptionRevision: 1, optionState: 'ACTIVE' })],
        [
          packageOptionRoleRevisions,
          expect.objectContaining({
            contentRevision: 1,
            independentlyRequested: true,
            looseUnitsSubstitutable: false,
            revision: 1,
            state: 'ACTIVE',
            validationReason: finding.validationReason,
          }),
        ],
      ]);
    }),
  );

  it.effect('keeps scheduled content out of the Current role until its effective time', () =>
    Effect.gen(function* scheduled() {
      const writes: Write[] = [];
      const observed: number[] = [];
      const future = { ...content, effectiveAt: new Date('2100-01-01T00:00:00.000Z'), revision: 2 };
      const service = packageOptionPersistenceForScope(
        // @ts-expect-error Only exercised Drizzle chains are mocked.
        mockTransaction(writes, definition, [content, future]),
        scope,
        {
          verify: ({ contentRevision }) => {
            observed.push(contentRevision);
            return Effect.succeed(Option.some(finding));
          },
        },
        {
          verify: ({ contentRevision }) => {
            observed.push(contentRevision);
            return Effect.succeed(true);
          },
        },
      );
      const outcome = yield* service.activate(input);
      expect(
        Match.value(outcome).pipe(
          Match.tag('changed', (value) => value.contentRevision),
          Match.orElse(() => 0),
        ),
      ).toBe(1);
      expect(observed).toEqual([1, 1]);
      expect(writes[1]).toEqual([packageOptionRoleRevisions, expect.objectContaining({ contentRevision: 1 })]);
    }),
  );

  it.effect('blocks Option activation until the due successor is explicitly promoted', () =>
    Effect.gen(function* effectiveSuccessor() {
      const writes: Write[] = [];
      const observed: number[] = [];
      const successor = { ...content, effectiveAt: new Date('1950-01-01T00:00:00.000Z'), revision: 2 };
      const service = packageOptionPersistenceForScope(
        // @ts-expect-error Only exercised Drizzle chains are mocked.
        mockTransaction(writes, definition, [content, successor]),
        scope,
        {
          verify: ({ contentRevision }) => {
            observed.push(contentRevision);
            return Effect.succeed(Option.some(finding));
          },
        },
        {
          verify: ({ contentRevision }) => {
            observed.push(contentRevision);
            return Effect.succeed(true);
          },
        },
      );
      const stale = yield* service.activate(input);
      expect(
        Match.value(stale).pipe(
          Match.tag('stale', (value) => value.actualContentRevision),
          Match.orElse(() => 0),
        ),
      ).toBe(2);
      expect(observed).toEqual([]);
      const outcome = yield* service.activate({ ...input, expectedContentRevision: 2 });
      expect(
        Match.value(outcome).pipe(
          Match.tag('stale', (value) => value.actualContentRevision),
          Match.orElse(() => 0),
        ),
      ).toBe(2);
      expect(observed).toEqual([]);
      expect(writes).toEqual([]);
    }),
  );

  it.effect('fails closed on a broken content chain before role evidence or writes', () =>
    Effect.gen(function* brokenChain() {
      const writes: Write[] = [];
      let consulted = false;
      const broken = { ...content, effectiveAt: new Date('1950-01-01T00:00:00.000Z'), revision: 3 };
      const service = packageOptionPersistenceForScope(
        // @ts-expect-error Only exercised Drizzle chains are mocked.
        mockTransaction(writes, definition, [content, broken]),
        scope,
        {
          verify: () => {
            consulted = true;
            return Effect.succeed(Option.some(finding));
          },
        },
        { verify: () => Effect.succeed(true) },
      );
      const error = yield* service.activate(input).pipe(Effect.flip);
      expect(Schema.is(PackageOptionPersistenceUnavailable)(error)).toBe(true);
      expect(consulted).toBe(false);
      expect(writes).toEqual([]);
    }),
  );

  it.effect('blocks Option retirement until due content is explicitly promoted', () =>
    Effect.gen(function* retireSuccessor() {
      const writes: Write[] = [];
      const active = { ...definition, currentOptionRevision: 1, optionState: 'ACTIVE' };
      const successor = { ...content, effectiveAt: new Date('1950-01-01T00:00:00.000Z'), revision: 2 };
      const service = packageOptionPersistenceForScope(
        // @ts-expect-error Only exercised Drizzle chains are mocked.
        mockTransaction(writes, active, [content, successor]),
        scope,
        undefined,
        { verify: ({ contentRevision }) => Effect.succeed(contentRevision === 2) },
      );
      const outcome = yield* service.retire({ ...input, expectedContentRevision: 2, expectedOptionRevision: 1 });
      expect(
        Match.value(outcome).pipe(
          Match.tag('stale', (value) => value.actualContentRevision),
          Match.orElse(() => 0),
        ),
      ).toBe(2);
      expect(writes).toEqual([]);
    }),
  );

  it.effect('rejects quantity-only evidence and open-selection impact without changing the role', () =>
    Effect.gen(function* reject() {
      const writes: Write[] = [];
      const quantityOnly = packageOptionPersistenceForScope(
        // @ts-expect-error Only exercised Drizzle chains are mocked.
        mockTransaction(writes),
        scope,
        { verify: () => Effect.succeed(Option.some({ ...finding, looseUnitsSubstitutable: true })) },
        { verify: () => Effect.succeed(true) },
      );
      expect(
        Match.value(yield* quantityOnly.activate(input)).pipe(
          Match.tag('invalid', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      const impacted = packageOptionPersistenceForScope(
        // @ts-expect-error Only exercised Drizzle chains are mocked.
        mockTransaction(writes),
        scope,
        { verify: () => Effect.succeed(Option.some(finding)) },
        { verify: () => Effect.succeed(false) },
      );
      expect(
        Match.value(yield* impacted.activate(input)).pipe(
          Match.tag('invalid', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(writes).toEqual([]);
    }),
  );

  it.effect('retirement appends history and never substitutes loose quantity', () =>
    Effect.gen(function* retire() {
      const writes: Write[] = [];
      const active = { ...definition, currentOptionRevision: 1, optionState: 'ACTIVE' };
      const service = packageOptionPersistenceForScope(
        // @ts-expect-error Only exercised Drizzle chains are mocked.
        mockTransaction(writes, active),
        scope,
        undefined,
        { verify: () => Effect.succeed(true) },
      );
      const outcome = yield* service.retire({ ...input, expectedOptionRevision: 1 });
      const changed = Match.value(outcome).pipe(
        Match.tag('changed', (value) => value),
        Match.orElse(() => null),
      );
      expect(changed).toMatchObject({ contentRevision: 1, optionRevision: 2, state: 'RETIRED' });
      expect(writes[1]).toEqual([
        packageOptionRoleRevisions,
        expect.objectContaining({ evidenceRefs: finding.evidenceRefs, revision: 2, state: 'RETIRED' }),
      ]);
    }),
  );

  it.effect('reactivation appends a new role revision after fresh validation', () =>
    Effect.gen(function* reactivate() {
      const writes: Write[] = [];
      const retired = { ...definition, currentOptionRevision: 2, optionState: 'RETIRED' };
      let verified = 0;
      const service = packageOptionPersistenceForScope(
        // @ts-expect-error Only exercised Drizzle chains are mocked.
        mockTransaction(writes, retired),
        scope,
        {
          verify: () => {
            verified += 1;
            return Effect.succeed(Option.some(finding));
          },
        },
        { verify: () => Effect.succeed(true) },
      );
      const outcome = yield* service.activate({ ...input, expectedOptionRevision: 2 });
      const changed = Match.value(outcome).pipe(
        Match.tag('changed', (value) => value),
        Match.orElse(() => null),
      );
      expect(changed).toMatchObject({ contentRevision: 1, optionRevision: 3, state: 'ACTIVE' });
      expect(verified).toBe(1);
      expect(writes[1]).toEqual([
        packageOptionRoleRevisions,
        expect.objectContaining({ revision: 3, state: 'ACTIVE' }),
      ]);
    }),
  );

  it.effect('rejects a stale role revision before consulting external evidence', () =>
    Effect.gen(function* stale() {
      const writes: Write[] = [];
      const service = packageOptionPersistenceForScope(
        // @ts-expect-error Only exercised Drizzle chains are mocked.
        mockTransaction(writes),
        scope,
        {
          verify: () => {
            throw new Error('Stale operation must not validate a role');
          },
        },
        { verify: () => Effect.succeed(true) },
      );
      const outcome = yield* service.activate({ ...input, expectedOptionRevision: 2 });
      const staleOutcome = Match.value(outcome).pipe(
        Match.tag('stale', (value) => value),
        Match.orElse(() => null),
      );
      expect(staleOutcome).toMatchObject({ actualContentRevision: 1, actualOptionRevision: 0 });
      expect(writes).toEqual([]);
    }),
  );
});
