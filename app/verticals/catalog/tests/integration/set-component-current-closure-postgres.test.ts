import { Crypto, Effect, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';
import { executeSelectionEvidenceWithAuthorization } from '../../src/api/selection-evidence-client.ts';
import { GovernVariantAllowedValuesActionAlreadyCommittedProblemSchema } from '../../shared/apis/govern-variant-allowed-values-action.ts';
import {
  SelectionEvidenceAuthenticationProblemSchema,
  SelectionEvidenceForbiddenProblemSchema,
  SelectionEvidenceUnavailableProblemSchema,
} from '../../shared/apis/selection-evidence.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  makeSetComponentFixture,
  setComponentTestServices,
} from '../support/set-component-current-closure-receiver.fixture.ts';

for (const configuration of ['OMITTED', 'SELECTED'] as const) {
  it.live(
    `accepts ${configuration} optional component measurements sharing one Unit through public Set evidence`,
    () =>
      Effect.gen(function* sharedMeasuredUnit() {
        const owner = yield* makeSetComponentFixture({ configuration });
        const before = yield* owner.observeOuter();
        expect((yield* owner.nativeRead(owner.selected)).evidence).toMatchObject({ status: 'VALID' });
        expect((yield* owner.read(owner.componentA.selected)).evidence).toMatchObject({ status: 'VALID' });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const current = yield* owner.read();
          expect(current.evidence).toMatchObject({ selection: owner.selected, status: 'VALID' });
          expect(current.missingRoles).toEqual([]);
          assert('basis' in current.evidence);
          const componentId = owner.createPayload.revision.components[0]?.componentId;
          const units = current.evidence.basis.filter(
            ({ role, subject }) => role === 'UNIT' && subject?.componentId === componentId,
          );
          expect(units).toHaveLength(configuration === 'SELECTED' ? 1 : 0);
          if (configuration === 'SELECTED') {
            expect(units[0]?.source).toEqual(owner.componentA.selected.configuration?.choices[1]?.unit);
          }
        }
        expect(yield* owner.observeOuter()).toEqual(before);
      }).pipe(Effect.scoped, Effect.provide(setComponentTestServices)),
    120_000,
  );
}

it.live(
  'propagates actual component allowance invalidity through pinned Set without changing outer history',
  () =>
    Effect.gen(function* componentAllowance() {
      const owner = yield* makeSetComponentFixture();
      const before = yield* owner.observeOuter();
      const initial = yield* owner.read();
      expect(initial.evidence).toMatchObject({ status: 'VALID' });
      expect(initial.missingRoles).toEqual([]);
      assert('basis' in initial.evidence);
      const componentIds = owner.createPayload.revision.components.map(({ componentId }) => componentId);
      const actualComponentIds = [
        ...new Set(
          initial.evidence.basis.flatMap(({ subject }) => (subject === undefined ? [] : [subject.componentId])),
        ),
      ];
      expect(actualComponentIds).toHaveLength(componentIds.length);
      expect(actualComponentIds).toEqual(expect.arrayContaining(componentIds));
      expect(
        initial.evidence.basis
          .filter(({ subject }) => subject !== undefined)
          .every(({ subject }) =>
            Schema.toEquivalence(CatalogSelectionSchema)(
              { ...owner.selected, setComposition: subject?.composition },
              owner.selected,
            ),
          ),
      ).toBe(true);
      for (const component of [owner.componentA, owner.componentB]) {
        expect(
          initial.evidence.basis.some(
            ({ role, source, subject }) =>
              role === 'PRODUCT_TYPE' &&
              subject !== undefined &&
              source.resourceRef.resourceId === component.productTypeRef.resourceId &&
              source.revisionId !== undefined,
          ),
        ).toBe(true);
      }
      const request = (credential: string) =>
        Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(
          Effect.flatMap((correlation) =>
            executeSelectionEvidenceWithAuthorization(
              { purpose: 'PRICING', selection: owner.selected },
              credential,
              correlation,
              { baseUrl: owner.baseUrl, compositionRevision: owner.composition.composition.revision },
            ),
          ),
          Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch),
        );
      expect(
        Schema.is(SelectionEvidenceAuthenticationProblemSchema)(yield* request('Bearer invalid').pipe(Effect.flip)),
      ).toBe(true);
      expect(
        Schema.is(SelectionEvidenceAuthenticationProblemSchema)(
          yield* request(yield* owner.authorization(owner.fixture.manager, 'pricing')).pipe(Effect.flip),
        ),
      ).toBe(true);
      const consumedAssertion = yield* owner.authorization();
      expect((yield* request(consumedAssertion)).evidence).toMatchObject({ status: 'VALID' });
      expect(
        Schema.is(SelectionEvidenceAuthenticationProblemSchema)(yield* request(consumedAssertion).pipe(Effect.flip)),
      ).toBe(true);
      const key = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
      expect(yield* owner.restrict([], 1, 1, key)).toMatchObject({ allowanceRevision: 2, changed: true });
      expect(
        Schema.is(GovernVariantAllowedValuesActionAlreadyCommittedProblemSchema)(
          yield* owner.restrict([], 1, 1, key).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect((yield* owner.observeAllowance()).events.map(({ allowanceRevision }) => allowanceRevision)).toEqual([
        1, 2,
      ]);
      expect((yield* owner.nativeRead(owner.selected)).evidence).toMatchObject({ status: 'INVALID' });
      expect((yield* owner.read()).evidence).toMatchObject({ status: 'INVALID' });
      expect((yield* owner.read(owner.componentA.selected)).evidence).toMatchObject({ status: 'INVALID' });
      expect((yield* owner.read(owner.componentB.selected)).evidence).toMatchObject({ status: 'VALID' });
      expect(yield* owner.observeOuter()).toEqual(before);
      expect(
        Schema.is(SelectionEvidenceForbiddenProblemSchema)(
          yield* owner.read(owner.selected, owner.fixture.denied).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(
        Schema.is(SelectionEvidenceForbiddenProblemSchema)(
          yield* owner
            .read(owner.selected, { ...owner.fixture.manager, legalEntityId: owner.fixture.legalEntityId })
            .pipe(Effect.flip),
        ),
      ).toBe(true);
      const foreignTenant = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
      const foreign = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        productRef: { ...owner.selected.productRef, tenantId: foreignTenant },
        variantRef: { ...owner.selected.variantRef, tenantId: foreignTenant },
      });
      expect(Schema.is(SelectionEvidenceUnavailableProblemSchema)(yield* owner.read(foreign).pipe(Effect.flip))).toBe(
        true,
      );
    }).pipe(Effect.scoped, Effect.provide(setComponentTestServices)),
  120_000,
);

it.live(
  'carries a real inherited component correction into Current source tokens without editing the Set',
  () =>
    Effect.gen(function* inheritedCorrection() {
      const owner = yield* makeSetComponentFixture();
      const outer = yield* owner.observeOuter();
      const before = yield* owner.read();
      expect(before.evidence).toMatchObject({ status: 'VALID' });
      assert('basis' in before.evidence);
      const inherited = before.evidence.basis.filter(
        ({ role, subject }) => role === 'INHERITED_VALUE' && subject !== undefined,
      );
      expect(inherited.length).toBeGreaterThan(0);
      yield* owner.correctInherited();
      const after = yield* owner.read();
      expect(after.evidence).toMatchObject({ status: 'VALID' });
      assert('basis' in after.evidence);
      const changed = after.evidence.basis.filter(
        ({ role, subject }) => role === 'INHERITED_VALUE' && subject !== undefined,
      );
      expect(changed).not.toEqual(inherited);
      expect(
        changed.some((fact) =>
          inherited.some(
            (old) =>
              old.source.resourceRef.resourceId === fact.source.resourceRef.resourceId &&
              fact.source.revision === old.source.revision + 1,
          ),
        ),
      ).toBe(true);
      expect(yield* owner.observeOuter()).toEqual(outer);
    }).pipe(Effect.scoped, Effect.provide(setComponentTestServices)),
  120_000,
);

it.live(
  'rejects a Set after a real component Type revision requires an absent staged value',
  () =>
    Effect.gen(function* componentTypeChange() {
      const owner = yield* makeSetComponentFixture();
      const outer = yield* owner.observeOuter();
      expect((yield* owner.read()).evidence).toMatchObject({ status: 'VALID' });
      expect(yield* owner.reviseType()).toMatchObject({ revision: owner.componentA.typeRevision + 1 });
      expect((yield* owner.nativeRead(owner.selected)).evidence).toMatchObject({
        reason: 'Set component Current proof: COMPONENT_TYPE_VALUE_AXIS_UNVERIFIABLE',
        status: 'INVALID',
      });
      expect((yield* owner.read()).evidence).toMatchObject({
        reason: 'Set component Current proof: COMPONENT_TYPE_VALUE_AXIS_UNVERIFIABLE',
        status: 'INVALID',
      });
      expect((yield* owner.read(owner.componentA.selected)).evidence).toMatchObject({
        reason: 'Current Product Type requirements are invalid',
        status: 'INVALID',
      });
      expect((yield* owner.read(owner.componentB.selected)).evidence).toMatchObject({ status: 'VALID' });
      expect(yield* owner.observeOuter()).toEqual(outer);
    }).pipe(Effect.scoped, Effect.provide(setComponentTestServices)),
  120_000,
);
