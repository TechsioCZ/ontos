import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { SQL } from 'drizzle-orm';
import { Effect, Exit, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';
import type { ConfigurationUnitPersistence } from '../../src/persistence/configuration-unit-persistence.ts';

import {
  productConfigurationChoiceOptions,
  productConfigurationChoices,
  productConfigurationCompatibilityRules,
  productConfigurationDefinitionRevisions,
  productConfigurationDefinitions,
  productConfigurationMeasuredRules,
  productConfigurationOptionAllowances,
  productConfigurationRevisionActivations,
  products,
} from '../../src/database/schema.ts';
import {
  inspectProductConfigurationPublishInput,
  productConfigurationPersistenceForScope,
} from '../../src/persistence/product-configuration-persistence.ts';
import type { PublishProductConfigurationInput } from '../../src/persistence/product-configuration-persistence.ts';

const input: PublishProductConfigurationInput = {
  actionInvocationId: '11111111-1111-4111-8111-111111111111',
  choices: [
    {
      choiceKey: 'mount',
      kind: 'SINGLE_CHOICE',
      label: 'Mount',
      meaning: 'Mounting type',
      options: [
        { label: 'A', meaning: 'A mounting part', optionKey: 'A' },
        { label: 'B', meaning: 'B mounting part', optionKey: 'B' },
      ],
      required: true,
    },
    {
      choiceKey: 'length',
      kind: 'MEASURED_VALUE',
      label: 'Length',
      meaning: 'Cut length',
      required: true,
      unitId: '55555555-5555-4555-8555-555555555555',
    },
  ],
  compatibilityRules: [
    {
      choiceKey: 'mount',
      evidenceRefs: ['product-engineering:42'],
      kind: 'CONDITIONAL_MAXIMUM',
      maximum: '100',
      maximumInclusive: true,
      optionKey: 'A',
      otherChoiceKey: 'length',
      ruleId: '66666666-6666-4666-8666-666666666666',
    },
  ],
  definitionId: '44444444-4444-4444-8444-444444444444',
  effectiveFrom: new Date('2026-09-18T00:00:00Z'),
  evidenceRefs: ['product-engineering:42'],
  expectedRevision: 0,
  measuredRules: [
    {
      choiceKey: 'length',
      evidenceRefs: ['product-engineering:42'],
      maximum: '120',
      maximumInclusive: true,
      minimum: '0',
      minimumInclusive: false,
      step: '0.5',
      stepBase: '0',
    },
  ],
  optionAllowances: [
    { allowed: true, choiceKey: 'mount', evidenceRefs: ['product-engineering:42'], optionKey: 'A' },
    { allowed: false, choiceKey: 'mount', evidenceRefs: ['product-engineering:42'], optionKey: 'B' },
  ],
  principalId: '22222222-2222-4222-8222-222222222222',
  productId: '33333333-3333-4333-8333-333333333333',
  reason: 'Verified product configuration',
};

describe('Product Configuration publication input', () => {
  it('accepts an explicit, bounded Product-level rule snapshot', () => {
    expect(inspectProductConfigurationPublishInput(input)).toBeNull();
  });

  it('does not interpret an absent option decision as unrestricted', () => {
    expect(
      inspectProductConfigurationPublishInput({ ...input, optionAllowances: input.optionAllowances.slice(0, 1) }),
    ).toContain('explicit Product-level allowance');
  });

  it('distinguishes a confirmed unbounded measured rule from a missing rule', () => {
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        measuredRules: [{ choiceKey: 'length', evidenceRefs: ['product-engineering:42'] }],
      }),
    ).toBeNull();
    expect(inspectProductConfigurationPublishInput({ ...input, measuredRules: [] })).toContain(
      'explicit Product-level rule',
    );
  });

  it('rejects a step without its reference base and duplicate identities', () => {
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        measuredRules: [{ choiceKey: 'length', evidenceRefs: ['product-engineering:42'], step: '0.5' }],
      }),
    ).toContain('bounds or step');
    expect(
      inspectProductConfigurationPublishInput({ ...input, choices: [...input.choices, input.choices[0]] }),
    ).toContain('unique');
  });

  it('compares decimal bounds exactly beyond JavaScript safe integers', () => {
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        measuredRules: [
          {
            choiceKey: 'length',
            evidenceRefs: ['product-engineering:42'],
            maximum: '9007199254740992',
            maximumInclusive: true,
            minimum: '9007199254740993',
            minimumInclusive: true,
          },
        ],
      }),
    ).toContain('bounds or step');
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        measuredRules: [
          {
            choiceKey: 'length',
            evidenceRefs: ['product-engineering:42'],
            step: '0.00000000000000000000000001',
            stepBase: '0',
          },
        ],
      }),
    ).toBeNull();
  });

  it('rejects empty and contradictory measured intervals while allowing disjoint variant ranges', () => {
    for (const minimumInclusive of [false, true]) {
      expect(
        inspectProductConfigurationPublishInput({
          ...input,
          measuredRules: [
            {
              choiceKey: 'length',
              evidenceRefs: ['range'],
              maximum: '100.0',
              maximumInclusive: false,
              minimum: '100',
              minimumInclusive,
            },
          ],
        }),
      ).toContain('bounds or step');
    }
    const [productRule] = input.measuredRules;
    const narrowVariant = {
      choiceKey: 'length',
      evidenceRefs: ['variant range'],
      minimum: '121',
      minimumInclusive: true,
      variantId: 'black',
    } as const;
    expect(
      inspectProductConfigurationPublishInput({ ...input, measuredRules: [productRule, narrowVariant] }),
    ).toContain('contradictory');
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        measuredRules: [productRule, { ...narrowVariant, minimum: '120', minimumInclusive: false }],
      }),
    ).toContain('contradictory');
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        measuredRules: [
          productRule,
          { ...narrowVariant, minimum: '121', variantId: 'black' },
          {
            choiceKey: 'length',
            evidenceRefs: ['white range'],
            maximum: '90',
            maximumInclusive: true,
            variantId: 'white',
          },
        ],
      }),
    ).toContain('contradictory');
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        measuredRules: [
          productRule,
          { ...narrowVariant, minimum: '100' },
          {
            choiceKey: 'length',
            evidenceRefs: ['white range'],
            maximum: '90',
            maximumInclusive: true,
            variantId: 'white',
          },
        ],
      }),
    ).toBeNull();
  });

  it('rejects a forbidden pair that cannot coexist on one Single Choice', () => {
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        compatibilityRules: [
          {
            choiceKey: 'mount',
            evidenceRefs: ['conflict'],
            kind: 'FORBIDDEN_PAIR',
            optionKey: 'A',
            otherChoiceKey: 'mount',
            otherOptionKey: 'B',
            ruleId: 'same-choice-distinct-options',
          },
        ],
      }),
    ).toContain('operands');
  });

  it('rejects incompatible layered step lattices and bounded lattices with no member', () => {
    const product = { choiceKey: 'length', evidenceRefs: ['product'], step: '2', stepBase: '0' };
    const variant = { choiceKey: 'length', evidenceRefs: ['variant'], step: '2', stepBase: '1', variantId: 'black' };
    expect(inspectProductConfigurationPublishInput({ ...input, measuredRules: [product, variant] })).toContain(
      'contradictory',
    );
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        measuredRules: [
          { ...product, maximum: '3.5', maximumInclusive: true, minimum: '3', minimumInclusive: true },
          { ...variant, step: '4', stepBase: '0' },
        ],
      }),
    ).toContain('contradictory');
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        measuredRules: [
          { ...product, maximum: '5', maximumInclusive: true, minimum: '3', minimumInclusive: true },
          { ...variant, step: '4', stepBase: '0' },
        ],
      }),
    ).toBeNull();
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        measuredRules: [
          { ...product, maximum: '0.5', maximumInclusive: false, minimum: '0.3', minimumInclusive: false, step: '0.2' },
          { ...variant, step: '0.3', stepBase: '0.1' },
        ],
      }),
    ).toBeNull();
  });

  it('rejects unsupported compatibility operands and missing evidence', () => {
    expect(
      inspectProductConfigurationPublishInput({
        ...input,
        compatibilityRules: [{ ...input.compatibilityRules[0], otherChoiceKey: 'unknown' }],
      }),
    ).toContain('operands');
    expect(inspectProductConfigurationPublishInput({ ...input, evidenceRefs: [] })).toContain('evidence');
  });
});

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:configuration-test:run:1',
    authMethod: 'system',
    principalId: input.principalId,
    tenantId: '99999999-9999-4999-8999-999999999999',
  }),
  correlationId: 'configuration-test',
};

const confirmedUnit: Pick<ConfigurationUnitPersistence, 'readCurrent'> = {
  readCurrent: (unitId, assessedAt) =>
    Effect.succeed({
      assessedAt,
      revision: {
        dimension: 'length',
        effectiveFrom: new Date('2026-09-01T00:00:00Z'),
        evidenceRefs: ['owner:unit:1'],
        lifecycleState: 'ACTIVE',
        meaning: 'Centimetre',
        ref: Schema.decodeUnknownSync(CatalogResourceRefSchema)({
          moduleId: 'commerce.catalog',
          resourceId: unitId,
          resourceType: 'commerce.catalog.unit',
          tenantId: scope.tenantId,
        }),
        revision: 1,
      },
      status: 'CONFIRMED',
    }),
};

type Table =
  | typeof productConfigurationChoiceOptions
  | typeof productConfigurationChoices
  | typeof productConfigurationCompatibilityRules
  | typeof productConfigurationDefinitionRevisions
  | typeof productConfigurationDefinitions
  | typeof productConfigurationMeasuredRules
  | typeof productConfigurationOptionAllowances
  | typeof productConfigurationRevisionActivations
  | typeof products;
type WriteValue =
  | typeof productConfigurationDefinitions.$inferInsert
  | typeof productConfigurationDefinitionRevisions.$inferInsert
  | typeof productConfigurationRevisionActivations.$inferInsert
  | typeof productConfigurationChoices.$inferInsert
  | typeof productConfigurationChoiceOptions.$inferInsert
  | typeof productConfigurationOptionAllowances.$inferInsert
  | typeof productConfigurationMeasuredRules.$inferInsert
  | typeof productConfigurationCompatibilityRules.$inferInsert;
const empty = Effect.succeed([]);
const locked = (table: Table) => ({
  limit: () => Effect.succeed(table === products ? [{ lifecycleState: 'ACTIVE' }] : []),
});
const filtered = (table: Table) => ({ for: () => locked(table), limit: () => empty });
const fixture = (writes: object[]) => ({
  insert: (table: Table) => ({
    values: (value: WriteValue | readonly WriteValue[]) => {
      writes.push([table, value]);
      return empty;
    },
  }),
  select: () => ({ from: (table: Table) => ({ where: () => filtered(table) }) }),
});

describe('Product Configuration private publication', () => {
  it.effect('publishes the first exact snapshot only with an owner impact proof', () =>
    Effect.gen(function* publishFirst() {
      const writes: object[] = [];
      // @ts-expect-error Mock covers this scoped Drizzle chain.
      const withoutProof = productConfigurationPersistenceForScope(fixture(writes), scope);
      const failed = yield* Effect.exit(withoutProof.publish(input));
      expect(Exit.isFailure(failed)).toBe(true);
      expect(writes).toEqual([]);

      const withProof = productConfigurationPersistenceForScope(
        // @ts-expect-error Mock covers this scoped Drizzle chain.
        fixture(writes),
        scope,
        { verify: () => Effect.succeed(true) },
        confirmedUnit,
      );
      const forged = yield* withProof.publish({ ...input, principalId: scope.tenantId });
      expect('reason' in forged ? forged.reason : null).toContain('trusted operation scope');
      expect(writes).toEqual([]);
      const outcome = yield* withProof.publish(input);
      expect('revision' in outcome ? outcome.revision : null).toBe(1);
      expect(writes.map((write) => (Array.isArray(write) ? write[0] : null))).toEqual([
        productConfigurationDefinitions,
        productConfigurationDefinitionRevisions,
        productConfigurationRevisionActivations,
        productConfigurationChoices,
        productConfigurationChoiceOptions,
        productConfigurationChoices,
        productConfigurationOptionAllowances,
        productConfigurationOptionAllowances,
        productConfigurationMeasuredRules,
        productConfigurationCompatibilityRules,
      ]);
    }),
  );
});

const boundValues = (condition: SQL) =>
  condition.toQuery({
    escapeName: (name) => name,
    escapeParam: () => '?',
    escapeString: (value) => value,
  }).params;

const updateFixtureRows = (
  rows: Map<Table, WriteValue[]>,
  table: Table,
  patch: { currentRevision: number },
  condition: SQL,
) => {
  const values = boundValues(condition);
  const existing = (rows.get(table) ?? []).filter((row) => values.every((value) => Object.values(row).includes(value)));
  rows.set(
    table,
    (rows.get(table) ?? []).map((row) =>
      existing.includes(row) ? { ...row, currentRevision: patch.currentRevision } : row,
    ),
  );
  return Effect.succeed(existing.map((row) => ({ ...row, currentRevision: patch.currentRevision })));
};

const statefulFixture = () => {
  const rows = new Map<Table, WriteValue[]>();
  const loaded = (table: Table, condition: SQL) => {
    const candidates = table === products ? [{ lifecycleState: 'ACTIVE' }] : (rows.get(table) ?? []);
    const values = boundValues(condition);
    return Effect.succeed(
      candidates.filter(
        (row) =>
          table === products ||
          (values.every((value) => Object.values(row).includes(value)) &&
            (table !== productConfigurationChoices || ('revision' in row && row.revision === values[2]))),
      ),
    );
  };
  const filter = (table: Table, condition: SQL) =>
    Object.assign(loaded(table, condition), {
      for: () => ({ limit: () => loaded(table, condition) }),
      limit: () => loaded(table, condition),
    });
  return {
    rows,
    transaction: {
      insert: (table: Table) => ({
        values: (value: WriteValue | readonly WriteValue[]) => {
          rows.set(table, [...(rows.get(table) ?? []), ...(Array.isArray(value) ? value : [value])]);
          return empty;
        },
      }),
      select: () => ({ from: (table: Table) => ({ where: (condition: SQL) => filter(table, condition) }) }),
      update: (table: Table) => ({
        set: (patch: { currentRevision: number }) => ({
          where: (condition: SQL) => ({
            returning: updateFixtureRows.bind(null, rows, table, patch, condition),
          }),
        }),
      }),
    },
  };
};

describe('Product Configuration effectiveness timeline', () => {
  it.effect('keeps a future publication non-Current until inclusive effectiveFrom and replays exactly', () =>
    Effect.gen(function* futureAndReplay() {
      const state = statefulFixture();
      const service = productConfigurationPersistenceForScope(
        // @ts-expect-error Fixture implements the exercised owner-scoped Drizzle operations.
        state.transaction,
        scope,
        {
          verify: () => Effect.succeed(true),
        },
        confirmedUnit,
      );
      const first = yield* service.publish(input);
      expect('revision' in first ? first.revision : null).toBe(1);
      const before = yield* service.readCurrent({
        at: new Date('2026-09-17T23:59:59.999Z'),
        definitionId: input.definitionId,
        productId: input.productId,
      });
      expect(Option.isNone(before)).toBe(true);
      const atStart = yield* service.readCurrent({
        at: input.effectiveFrom,
        definitionId: input.definitionId,
        productId: input.productId,
      });
      expect(Option.isSome(atStart)).toBe(true);
      if (Option.isSome(atStart)) {
        expect(atStart.value.ruleCombination).toBe('CONJUNCTION_ONLY');
      }
      const replay = yield* service.publish(input);
      expect('revision' in replay ? replay.revision : null).toBe(1);
      expect(state.rows.get(productConfigurationDefinitionRevisions)).toHaveLength(1);
      const conflict = yield* service.publish({
        ...input,
        choices: [{ ...input.choices[0], label: 'New label' }, input.choices[1]],
      });
      expect('reason' in conflict ? conflict.reason : null).toContain('different Configuration rule snapshot');
    }),
  );

  it.effect('supersedes at the next effective instant while preserving earlier replay', () =>
    Effect.gen(function* supersession() {
      const state = statefulFixture();
      const service = productConfigurationPersistenceForScope(
        // @ts-expect-error Fixture implements the exercised owner-scoped Drizzle operations.
        state.transaction,
        scope,
        {
          verify: () => Effect.succeed(true),
        },
        confirmedUnit,
      );
      yield* service.publish(input);
      const second = {
        ...input,
        actionInvocationId: '77777777-7777-4777-8777-777777777777',
        choices: [{ ...input.choices[0], label: 'New mount' }, input.choices[1]],
        effectiveFrom: new Date('2026-09-19T00:00:00Z'),
        expectedRevision: 1,
      };
      const published = yield* service.publish(second);
      expect('revision' in published ? published.revision : null).toBe(2);
      const earlier = yield* service.readCurrent({
        at: input.effectiveFrom,
        definitionId: input.definitionId,
        productId: input.productId,
      });
      expect(Option.isSome(earlier)).toBe(true);
      if (Option.isSome(earlier)) {
        expect(earlier.value.revision).toBe(1);
        expect(earlier.value.effectiveTo).toEqual(second.effectiveFrom);
      }
      const later = yield* service.readCurrent({
        at: second.effectiveFrom,
        definitionId: input.definitionId,
        productId: input.productId,
      });
      expect(Option.isSome(later) && later.value.revision).toBe(2);
      const replay = yield* service.publish(input);
      expect('revision' in replay ? replay.revision : null).toBe(1);
      expect(state.rows.get(productConfigurationDefinitionRevisions)).toHaveLength(2);
      const losingPublisher = yield* service.publish({
        ...second,
        actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      expect('actualRevision' in losingPublisher ? losingPublisher.actualRevision : null).toBe(2);
      expect(state.rows.get(productConfigurationDefinitionRevisions)).toHaveLength(2);
    }),
  );

  it.effect('fails closed on mismatched activation evidence and missing impact proof', () =>
    Effect.gen(function* corruptedHistory() {
      const state = statefulFixture();
      const service = productConfigurationPersistenceForScope(
        // @ts-expect-error Fixture implements the exercised owner-scoped Drizzle operations.
        state.transaction,
        scope,
        {
          verify: () => Effect.succeed(true),
        },
        confirmedUnit,
      );
      yield* service.publish(input);
      const activations = state.rows.get(productConfigurationRevisionActivations);
      expect(activations).toHaveLength(1);
      const activation = activations?.[0];
      if (activation === undefined) {
        return;
      }
      state.rows.set(productConfigurationRevisionActivations, [
        { ...activation, reason: 'Conflicting activation evidence' },
      ]);
      const failed = yield* Effect.exit(
        service.readCurrent({ at: input.effectiveFrom, definitionId: input.definitionId, productId: input.productId }),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      const noProof = productConfigurationPersistenceForScope(
        // @ts-expect-error Fixture implements the exercised owner-scoped Drizzle operations.
        state.transaction,
        scope,
        { verify: () => Effect.succeed(false) },
        confirmedUnit,
      );
      const result = yield* Effect.exit(
        noProof.publish({
          ...input,
          actionInvocationId: '88888888-8888-4888-8888-888888888888',
          effectiveFrom: new Date('2026-09-20T00:00:00Z'),
          expectedRevision: 1,
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(state.rows.get(productConfigurationDefinitionRevisions)).toHaveLength(1);
    }),
  );

  it.effect('refuses to read or extend a timeline with damaged non-Current revision evidence', () =>
    Effect.gen(function* damagedHistory() {
      const state = statefulFixture();
      const service = productConfigurationPersistenceForScope(
        // @ts-expect-error Fixture implements the exercised owner-scoped Drizzle operations.
        state.transaction,
        scope,
        { verify: () => Effect.succeed(true) },
        confirmedUnit,
      );
      yield* service.publish(input);
      const second = {
        ...input,
        actionInvocationId: '77777777-7777-4777-8777-777777777777',
        effectiveFrom: new Date('2026-09-19T00:00:00Z'),
        expectedRevision: 1,
      };
      yield* service.publish(second);
      const revisions = state.rows.get(productConfigurationDefinitionRevisions);
      const first = revisions?.[0];
      if (first === undefined || revisions === undefined) {
        return;
      }
      state.rows.set(productConfigurationDefinitionRevisions, [
        { ...first, reason: 'Damaged historical evidence' },
        ...revisions.slice(1),
      ]);
      for (const at of [new Date('2026-09-17T00:00:00Z'), second.effectiveFrom]) {
        const result = yield* Effect.exit(
          service.readCurrent({ at, definitionId: input.definitionId, productId: input.productId }),
        );
        expect(Exit.isFailure(result)).toBe(true);
      }
      const third = yield* Effect.exit(
        service.publish({
          ...second,
          actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          effectiveFrom: new Date('2026-09-20T00:00:00Z'),
          expectedRevision: 2,
        }),
      );
      expect(Exit.isFailure(third)).toBe(true);
      expect(state.rows.get(productConfigurationDefinitionRevisions)).toHaveLength(2);
    }),
  );

  it.effect('does not issue Current choice evidence from a retired Definition revision', () =>
    Effect.gen(function* retiredRevision() {
      const state = statefulFixture();
      const service = productConfigurationPersistenceForScope(
        // @ts-expect-error Fixture implements the exercised owner-scoped Drizzle operations.
        state.transaction,
        scope,
        {
          verify: () => Effect.succeed(true),
        },
        confirmedUnit,
      );
      yield* service.publish(input);
      const rows = state.rows.get(productConfigurationDefinitionRevisions);
      const published = rows?.[0];
      if (published === undefined) {
        return;
      }
      state.rows.set(productConfigurationDefinitionRevisions, [{ ...published, state: 'RETIRED' }]);
      const result = yield* Effect.exit(
        service.readCurrent({ at: input.effectiveFrom, definitionId: input.definitionId, productId: input.productId }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect('pins the published Unit revision and fails closed after its Current meaning changes', () =>
    Effect.gen(function* pinnedUnit() {
      const state = statefulFixture();
      const service = productConfigurationPersistenceForScope(
        // @ts-expect-error Fixture implements the exercised owner-scoped Drizzle operations.
        state.transaction,
        scope,
        {
          verify: () => Effect.succeed(true),
        },
        confirmedUnit,
      );
      yield* service.publish(input);
      const storedChoice = state.rows
        .get(productConfigurationChoices)
        ?.find((row) => 'choiceKey' in row && row.choiceKey === 'length');
      expect(storedChoice).toMatchObject({ unitId: input.choices[1]?.unitId, unitRevision: 1 });

      const changedUnit: Pick<ConfigurationUnitPersistence, 'readCurrent'> = {
        readCurrent: (unitId, at) =>
          confirmedUnit
            .readCurrent(unitId, at)
            .pipe(
              Effect.map((current) =>
                current.status === 'CONFIRMED'
                  ? { ...current, revision: { ...current.revision, meaning: 'New meaning', revision: 2 } }
                  : current,
              ),
            ),
      };
      // @ts-expect-error Fixture implements the exercised owner-scoped Drizzle operations.
      const stale = productConfigurationPersistenceForScope(state.transaction, scope, undefined, changedUnit);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            stale.readCurrent({
              at: input.effectiveFrom,
              definitionId: input.definitionId,
              productId: input.productId,
            }),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect('does not publish against a retired Configuration Unit', () =>
    Effect.gen(function* retiredUnit() {
      const writes: object[] = [];
      const service = productConfigurationPersistenceForScope(
        // @ts-expect-error Fixture implements the exercised owner-scoped Drizzle operations.
        fixture(writes),
        scope,
        {
          verify: () => Effect.succeed(true),
        },
        { readCurrent: () => Effect.succeed({ status: 'RETIRED' }) },
      );
      expect(Exit.isFailure(yield* Effect.exit(service.publish(input)))).toBe(true);
      expect(writes).toEqual([]);
    }),
  );
});
