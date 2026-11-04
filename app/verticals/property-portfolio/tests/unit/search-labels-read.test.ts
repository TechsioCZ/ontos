import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessDecision, OperationalScope } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import type { ReadTestOwnerQuery } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Context, Crypto, DateTime, Effect, Exit, Layer, Predicate, Schema } from 'effect';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { expect, it, rs } from 'effect-rstest';
import { SearchLabelsRequestSchema, SearchLabelsResponseSchema } from '../../shared/apis/search-labels.ts';
import { searchLabelsRead } from '../../src/api/search-labels.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const otherId = '20000000-0000-4000-8000-000000000002';
const propertyRef = {
  moduleId: 'property.portfolio',
  resourceId: '40000000-0000-4000-8000-000000000601',
  resourceType: 'property.portfolio.property',
  tenantId,
} as const;
const unitRef = {
  ...propertyRef,
  resourceId: '40000000-0000-4000-8000-000000000602',
  resourceType: 'property.portfolio.unit',
} as const;
const scope = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:property-label-test',
  authMethod: 'session',
  correlationId: 'property-label-test',
  legalEntityId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
const property = {
  address: 'Parková 12',
  archived: false,
  archiveValid: true,
  code: 'PARK',
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  name: 'Parková zahrada',
  propertyRef,
};
const unit = { archived: false, archiveValid: true, code: 'A101', name: 'Západní byt', propertyRef, unitRef };
// In select-column order: the scripted native driver feeds Drizzle's real row mapper.
const ownerRow = (properties: readonly object[] = [property], units: readonly object[] = [unit], revision = 42) => ({
  legalEntityId,
  properties,
  revision,
  sourceValid: true,
  tenantId,
  units,
});
interface ScenarioOptions {
  readonly deniedResourceIds?: readonly string[];
  readonly moduleDecision?: ContextAccessDecision;
  readonly operationScope?: OperationalScope;
  readonly resourceDecision?: ContextAccessDecision;
  readonly resources?: 'malformed' | 'incomplete';
  readonly rows?: readonly object[];
  readonly unavailable?: boolean;
}
const scenario = <Value, Failure, Requirements>(
  run: (
    harness: Effect.Success<ReturnType<typeof makeReadTestHarness>>,
    resources: readonly object[],
  ) => Effect.Effect<Value, Failure, Requirements>,
  options: ScenarioOptions = {},
) =>
  Effect.scoped(
    Effect.gen(function* readScenario() {
      const cryptoServices = yield* Layer.build(NodeCrypto.layer);
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () =>
          options.unavailable === true
            ? Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'scripted owner unavailable' }) }))
            : Effect.succeed(options.rows ?? [ownerRow()]),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T09:00:00.000Z')),
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope: options.operationScope ?? scope,
      }).pipe(Effect.provideService(Crypto.Crypto, Context.get(cryptoServices, Crypto.Crypto)));
      const access = Context.get(yield* Layer.build(harness.layer), ContextAccess);
      const resourceChecks: object[] = [];
      const moduleCheck = rs
        .spyOn(access, 'modules')
        .mockImplementation(({ moduleIds }) =>
          Effect.succeed(moduleIds.map((key) => ({ decision: options.moduleDecision ?? 'allowed', key }))),
        );
      const resourceCheck = rs.spyOn(access, 'resources').mockImplementation((input) => {
        resourceChecks.push(input);
        const decisions = input.resources.map((ref) => ({
          decision:
            options.deniedResourceIds?.includes(ref.resourceId) === true
              ? 'denied'
              : (options.resourceDecision ?? 'allowed'),
          key:
            options.resources === 'malformed' ? 'foreign-key' : `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
        }));
        return Effect.succeed(options.resources === 'incomplete' ? decisions.slice(1) : decisions);
      });
      return yield* run(harness, resourceChecks).pipe(
        Effect.provideService(ContextAccess, access),
        Effect.ensuring(
          Effect.sync(() => {
            resourceCheck.mockRestore();
            moduleCheck.mockRestore();
          }),
        ),
      );
    }),
  );
interface LabelReadTestInput {
  readonly legalEntityId?: string;
  readonly query?: string;
  readonly refs: readonly unknown[];
  readonly tenantId?: string;
}
const defaultInput = { refs: [propertyRef, unitRef] };
const read = (
  harness: Effect.Success<ReturnType<typeof makeReadTestHarness>>,
  input: LabelReadTestInput = defaultInput,
  principal: OperationalScope = scope,
) =>
  harness.runtime.runRead({
    input,
    principal,
    registration: searchLabelsRead,
    transport: { correlationId: scope.correlationId },
  });
const fails = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>, tag: string) =>
  effect.pipe(
    Effect.flip,
    Effect.tap((failure) => Effect.sync(() => expect(Predicate.isTagged(failure, tag)).toBe(true))),
    Effect.asVoid,
  );

it.effect('returns only safe labels and the actual owner revision through the governed lifecycle', () =>
  scenario(
    (harness, resourceChecks) =>
      Effect.gen(function* safeLabels() {
        const result = yield* read(harness);
        expect(result).toEqual({
          labels: [
            { address: property.address, code: property.code, ref: propertyRef, title: property.name },
            { code: unit.code, propertyRef, ref: unitRef, title: unit.name },
          ],
          revision: 42,
        });
        expect(Schema.is(SearchLabelsResponseSchema)(result)).toBe(true);
        expect(resourceChecks).toEqual([
          expect.objectContaining({
            legalEntityId,
            resources: [propertyRef, unitRef],
            tenantId,
          }),
        ]);
        expect(harness.snapshot().evidenceWrites).toBe(1);
        const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(SearchLabelsResponseSchema))(result);
        expect(serialized).not.toContain('PRIVATE');
      }),
    {
      rows: [
        ownerRow(
          [{ ...property, note: 'PRIVATE NOTE', responsiblePerson: 'PRIVATE PERSON' }],
          [{ ...unit, note: 'PRIVATE UNIT NOTE', parentCode: 'PRIVATE PARENT CODE' }],
        ),
      ],
    },
  ),
);

const assertBoundedQuery = (query: ReadTestOwnerQuery) => {
  expect(query.scope).toEqual({ legalEntityId, tenantId });
  expect(query.params).toContain(tenantId);
  expect(query.params).toContain(legalEntityId);
  expect(query.params).toContain(propertyRef.resourceId);
  expect(query.params).toContain(unitRef.resourceId);
  expect(query.sql).toContain('"property_portfolio"."state"');
  expect(query.sql).toMatch(/"state"\."tenant_id" = \$\d+/u);
  expect(query.sql).toMatch(/"state"\."legal_entity_id" = \$\d+/u);
  expect(query.sql).toContain("p.value->'propertyRef'->>'resourceId' in (");
  expect(query.sql).toContain("u.value->'unitRef'->>'resourceId' in (");
  expect(query.sql).toContain('limit 101');
  expect(query.sql).not.toContain('500');
  expect(query.params).not.toContain(500);
  expect(query.sql).not.toContain('"core"');
  expect(query.sql).not.toMatch(
    /select\s+\*|'note'|'responsiblePerson'|'assets'|'archive'\s*,\s*\w+\.value->'archive'/u,
  );
};
it.effect(
  'looks up exact requested IDs, including IDs beyond a first-500 snapshot, with no full payload selection',
  () =>
    scenario((harness) =>
      Effect.gen(function* boundedLookup() {
        const result = yield* read(harness, { refs: [propertyRef, unitRef, propertyRef, unitRef] });
        expect(result.labels).toHaveLength(2);
        const queries = harness.snapshot().ownerQueries;
        expect(queries).toHaveLength(1);
        const [query] = queries;
        expect(query).toBeDefined();
        if (query !== undefined) {
          assertBoundedQuery(query);
          // Property ID occurs once; Unit ID twice, for the exact Unit and its parent lookup, never once per duplicate.
          expect(query.params.filter((value) => value === propertyRef.resourceId)).toHaveLength(1);
          expect(query.params.filter((value) => value === unitRef.resourceId)).toHaveLength(2);
        }
      }),
    ),
);

it.effect('suppresses archived properties, archived units and units with an archived or absent parent', () =>
  Effect.gen(function* archiveCases() {
    for (const rows of [
      [ownerRow([{ ...property, archived: true }])],
      [ownerRow([property], [{ ...unit, archived: true }])],
      [ownerRow([])],
    ]) {
      yield* scenario(
        (harness) =>
          Effect.gen(function* archivedRead() {
            const result = yield* read(harness, { refs: [unitRef] });
            expect(result).toEqual({ labels: [], revision: 42 });
          }),
        { rows },
      );
    }
    yield* scenario(
      (harness) =>
        Effect.gen(function* archivedPropertyRead() {
          expect(yield* read(harness, { refs: [propertyRef] })).toEqual({ labels: [], revision: 42 });
        }),
      { rows: [ownerRow([{ ...property, archived: true }], [])] },
    );
  }),
);

it.effect('does not distinguish a resource denial from a missing exact reference', () =>
  Effect.gen(function* deniedAndMissing() {
    const denied = yield* scenario((harness) => read(harness), { resourceDecision: 'denied' });
    const missing = yield* scenario((harness) => read(harness), { rows: [ownerRow([], [])] });
    expect(denied).toEqual(missing);
    expect(denied).toEqual({ labels: [], revision: 42 });
  }),
);

it.effect('returns the current parent association but no denied parent label through an allowed unit', () =>
  scenario(
    (harness) =>
      Effect.gen(function* mixedDecisions() {
        const result = yield* read(harness);
        expect(result).toEqual({
          labels: [{ code: unit.code, propertyRef, ref: unitRef, title: unit.name }],
          revision: 42,
        });
      }),
    { deniedResourceIds: [propertyRef.resourceId] },
  ),
);

const movedParentRef = { ...propertyRef, resourceId: '40000000-0000-4000-8000-000000000603' };
const movedParent = {
  ...property,
  address: 'Nová 22',
  code: 'SECOND',
  name: 'Druhá budova',
  propertyRef: movedParentRef,
};

it.effect('updates Unit parent identity after a move even when the old parent remains independently readable', () => {
  const rows = [ownerRow()];
  return scenario(
    (harness, resourceChecks) =>
      Effect.gen(function* movedAssociation() {
        const before = yield* read(harness, { refs: [unitRef] });
        expect(before).toEqual({
          labels: [{ code: unit.code, propertyRef, ref: unitRef, title: unit.name }],
          revision: 42,
        });
        rows[0] = ownerRow([property, movedParent], [{ ...unit, propertyRef: movedParentRef }], 43);
        const after = yield* read(harness, { refs: [propertyRef, unitRef] });
        expect(after).toEqual({
          labels: [
            { address: property.address, code: property.code, ref: propertyRef, title: property.name },
            { code: unit.code, propertyRef: movedParentRef, ref: unitRef, title: unit.name },
          ],
          revision: 43,
        });
        const currentUnit = after.labels.find((label) => 'propertyRef' in label);
        expect(currentUnit?.propertyRef).toEqual(movedParentRef);
        expect(currentUnit?.propertyRef).not.toEqual(propertyRef);
        // Neither the readable old parent nor the current association grants the new parent's label.
        expect(after.labels.some((label) => label.ref.resourceId === movedParentRef.resourceId)).toBe(false);
        rows[0] = ownerRow([movedParent], [], 43);
        const currentParent = yield* read(harness, { refs: [movedParentRef] });
        expect(currentParent).toEqual({
          labels: [
            { address: movedParent.address, code: movedParent.code, ref: movedParentRef, title: movedParent.name },
          ],
          revision: 43,
        });
        expect(resourceChecks).toEqual([
          expect.objectContaining({ resources: [unitRef] }),
          expect.objectContaining({ resources: [propertyRef, unitRef] }),
          expect.objectContaining({ resources: [movedParentRef] }),
        ]);
        expect(harness.snapshot().ownerQueries).toHaveLength(3);
      }),
    { rows },
  );
});

it.effect(
  'keeps the current parent ref under Unit permission without inheriting permission to read that parent',
  () => {
    const rows = [ownerRow([movedParent], [{ ...unit, propertyRef: movedParentRef }], 72)];
    return scenario(
      (harness, resourceChecks) =>
        Effect.gen(function* deniedCurrentParent() {
          const result = yield* read(harness, { refs: [unitRef] });
          expect(result).toEqual({
            labels: [{ code: unit.code, propertyRef: movedParentRef, ref: unitRef, title: unit.name }],
            revision: 72,
          });
          // A separate current parent lookup must independently authorize the parent, and remains denied.
          rows[0] = ownerRow([movedParent], [], 72);
          expect(yield* read(harness, { refs: [movedParentRef] })).toEqual({ labels: [], revision: 72 });
          expect(resourceChecks).toEqual([
            expect.objectContaining({ resources: [unitRef] }),
            expect.objectContaining({ resources: [movedParentRef] }),
          ]);
        }),
      { deniedResourceIds: [movedParentRef.resourceId], rows },
    );
  },
);

it.effect('requires typed current parent association on a Unit response without fabricating a revision', () =>
  Effect.gen(function* associationContract() {
    for (const parent of [undefined, { ...propertyRef, resourceType: 'property.portfolio.unit' }]) {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(SearchLabelsResponseSchema)({
          labels: [{ code: unit.code, propertyRef: parent, ref: unitRef, title: unit.name }],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }
    const decoded = yield* Schema.decodeUnknownEffect(SearchLabelsResponseSchema)({
      labels: [{ code: unit.code, propertyRef, ref: unitRef, title: unit.name }],
    });
    expect(decoded).toEqual({ labels: [{ code: unit.code, propertyRef, ref: unitRef, title: unit.name }] });
  }),
);

it.effect('accepts 100 distinct exact references and retrieves each by ID', () => {
  const refs = Array.from({ length: 100 }, (_, index) => ({
    ...propertyRef,
    resourceId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  }));
  return scenario(
    (harness) =>
      Effect.gen(function* hundredExactRefs() {
        const result = yield* read(harness, { refs });
        expect(result.labels.map((label) => label.ref)).toEqual(refs);
        const [query] = harness.snapshot().ownerQueries;
        expect(query).toBeDefined();
        for (const ref of refs) {
          expect(query?.params).toContain(ref.resourceId);
        }
      }),
    {
      rows: [
        ownerRow(
          refs.map((ref) => ({ ...property, propertyRef: ref })),
          [],
        ),
      ],
    },
  );
});

it.effect('fails module denial and uncertainty before any owner SQL, never treating either as labels', () =>
  Effect.gen(function* moduleCases() {
    for (const moduleDecision of ['denied', 'unavailable'] as const) {
      yield* scenario(
        (harness) =>
          Effect.gen(function* moduleGate() {
            yield* fails(
              read(harness),
              moduleDecision === 'denied' ? 'ReadPermissionDenied' : 'ReadPermissionUnavailable',
            );
            expect(harness.snapshot().ownerQueries).toEqual([]);
          }),
        { moduleDecision },
      );
    }
  }),
);

it.effect('fails honestly for resource uncertainty and malformed or incomplete permission decisions', () =>
  Effect.gen(function* resourceFailures() {
    for (const options of [
      { resourceDecision: 'unavailable' as const },
      { resources: 'malformed' as const },
      { resources: 'incomplete' as const },
    ]) {
      yield* scenario((harness) => fails(read(harness), 'ReadHandlerUnavailable'), options);
    }
  }),
);

it.effect('returns no foreign-tenant labels without reading storage, and requires a trusted selected company', () =>
  Effect.gen(function* scopeCases() {
    yield* scenario((harness) =>
      Effect.gen(function* foreignInput() {
        expect(yield* read(harness, { refs: [{ ...propertyRef, tenantId: otherId }] })).toEqual({ labels: [] });
        expect(harness.snapshot().ownerQueries).toEqual([]);
      }),
    );
    const { legalEntityId: _company, ...unselected } = scope;
    void _company;
    yield* scenario(
      (harness) =>
        Effect.gen(function* missingCompany() {
          const exit = yield* Effect.exit(read(harness, defaultInput, unselected));
          expect(Exit.isFailure(exit)).toBe(true);
          expect(harness.snapshot().ownerQueries).toEqual([]);
        }),
      { operationScope: unselected },
    );
  }),
);

it.effect('rejects foreign company/tenant driver rows, malformed authority and duplicate/unrequested identities', () =>
  Effect.gen(function* badAuthority() {
    for (const row of [
      { ...ownerRow(), tenantId: otherId },
      { ...ownerRow(), legalEntityId: otherId },
      { ...ownerRow(), sourceValid: false },
      { ...ownerRow(), revision: -1 },
      { ...ownerRow(), properties: 'malformed' },
      ownerRow([{ ...property, name: null }]),
      ownerRow([{ ...property, archiveValid: false }]),
      ownerRow([{ ...property, propertyRef: { ...propertyRef, tenantId: otherId } }]),
      ownerRow([{ ...property, legalEntityRef: { ...property.legalEntityRef, resourceId: otherId } }]),
      ownerRow([property, property]),
      ownerRow([property], [unit, unit]),
      ownerRow([property], [{ ...unit, propertyRef: { ...propertyRef, tenantId: otherId } }]),
      ownerRow([property], [{ ...unit, unitRef: { ...unitRef, resourceId: otherId } }]),
    ]) {
      yield* scenario((harness) => fails(read(harness), 'ReadHandlerUnavailable'), { rows: [row] });
    }
  }),
);

it.effect('does not manufacture an owner revision for absent state and does not hide storage unavailability', () =>
  Effect.gen(function* absentOrUnavailable() {
    expect(yield* scenario((harness) => read(harness), { rows: [] })).toEqual({ labels: [] });
    yield* scenario((harness) => fails(read(harness), 'ReadHandlerUnavailable'), { unavailable: true });
  }),
);

it.effect(
  'validates exact typed refs, bounds input at 100, rejects query/scope payloads and deduplicates within the bound',
  () =>
    Effect.gen(function* inputContract() {
      for (const input of [
        { refs: Array.from({ length: 101 }, () => propertyRef) },
        { query: 'PRIVATE SEARCH TEXT', refs: [propertyRef] },
        { refs: [propertyRef], tenantId },
        { legalEntityId, refs: [propertyRef] },
        { refs: [{ ...propertyRef, resourceType: 'property.portfolio.asset' }] },
        { refs: [{ ...propertyRef, moduleId: 'party.registry' }] },
        { refs: [{ ...propertyRef, resourceId: 'invalid' }] },
      ]) {
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              Schema.decodeUnknownEffect(SearchLabelsRequestSchema, { onExcessProperty: 'error' })(input),
            ),
          ),
        ).toBe(true);
        yield* scenario((harness) =>
          Effect.gen(function* invalidInput() {
            yield* fails(read(harness, input), 'ReadInputValidationError');
            expect(harness.snapshot().ownerQueries).toEqual([]);
          }),
        );
      }
      yield* scenario(
        (harness) =>
          Effect.gen(function* hundredDuplicateRefs() {
            const result = yield* read(harness, { refs: Array.from({ length: 100 }, () => propertyRef) });
            expect(result.labels).toHaveLength(1);
          }),
        { rows: [ownerRow([property], [])] },
      );
      yield* scenario((harness) =>
        Effect.gen(function* emptyInput() {
          expect(yield* read(harness, { refs: [] })).toEqual({ labels: [] });
          expect(harness.snapshot().ownerQueries).toEqual([]);
        }),
      );
    }),
);

it.effect('rechecks the current principal and owner on every request, without a query/result cache', () =>
  scenario((harness) =>
    Effect.gen(function* noCache() {
      const first = yield* read(harness);
      const access = Context.get(yield* Layer.build(harness.layer), ContextAccess);
      const denial = rs.spyOn(access, 'resources').mockImplementation(({ resources }) =>
        Effect.succeed(
          resources.map((ref) => ({
            decision: 'denied' as const,
            key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
          })),
        ),
      );
      const second = yield* read(harness).pipe(Effect.ensuring(Effect.sync(() => denial.mockRestore())));
      expect(first.labels).toHaveLength(2);
      expect(second.labels).toEqual([]);
      expect(harness.snapshot().ownerQueries).toHaveLength(2);
      expect(harness.snapshot().evidenceWrites).toBe(2);
      expect(Predicate.isTagged(second, 'ReadHandlerUnavailable')).toBe(false);
    }),
  ),
);
