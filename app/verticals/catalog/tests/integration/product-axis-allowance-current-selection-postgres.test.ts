import { Crypto, Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';
import { GovernVariantAllowedValuesActionConflictProblemSchema } from '../../shared/apis/govern-variant-allowed-values-action.ts';
import {
  SelectionEvidenceAuthenticationProblemSchema,
  SelectionEvidenceForbiddenProblemSchema,
  SelectionEvidenceUnavailableProblemSchema,
} from '../../shared/apis/selection-evidence.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { executeSelectionEvidenceWithAuthorization } from '../../src/api/selection-evidence-client.ts';
import {
  makeProductAxisAllowanceFixture,
  productAxisAllowanceTestServices,
} from '../support/product-axis-allowance-receiver.fixture.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
it.live('reassesses Product-specific axis allowance restrictions through native Current and public PRICING', () =>
  Effect.gen(function* productAxisAllowanceNative() {
    const {
      alternate,
      baseUrl,
      composition,
      fixture,
      nativeFetch,
      nativeRead,
      observeAllowance,
      observeHistory,
      otherProduct,
      produced,
      read,
      restrict,
      selected,
    } = yield* makeProductAxisAllowanceFixture();
    const history = yield* observeHistory();
    const before = yield* read();
    expect(before.evidence).toMatchObject({ status: 'VALID' });
    expect(otherProduct.attributeDefinitionRef).toEqual(produced.attributeDefinitionRef);
    assert('basis' in before.evidence);
    expect(before.evidence.basis.find(({ role }) => role === 'VARIANT_AXIS')).toMatchObject({
      axisAllowances: [
        {
          allowanceRevision: 1,
          attributeDefinition: { resourceRef: produced.attributeDefinitionRef, revision: produced.definitionRevision },
        },
      ],
      source: { resourceRef: selected.productRef, revision: 1 },
    });
    expect((yield* read(alternate)).evidence).toMatchObject({ status: 'VALID' });
    expect(yield* restrict(['gloss'], 1)).toMatchObject({ allowanceRevision: 2, changed: true });
    expect((yield* nativeRead()).evidence).toMatchObject({ status: 'INVALID' });
    expect((yield* read()).evidence).toMatchObject({ status: 'INVALID' });
    const surviving = yield* read(alternate);
    expect(surviving.evidence).toMatchObject({ status: 'VALID' });
    assert('basis' in surviving.evidence);
    expect(surviving.evidence.basis.find(({ role }) => role === 'VARIANT_AXIS')?.axisAllowances).toMatchObject([
      { allowanceRevision: 2, attributeDefinition: { resourceRef: produced.attributeDefinitionRef } },
    ]);
    expect((yield* read(otherProduct.selected)).evidence).toMatchObject({ status: 'VALID' });
    expect(yield* observeHistory()).toEqual(history);
    // Actual writer CAS controls must not append another allowance snapshot.
    const stored = yield* observeAllowance();
    expect(stored.events.map((event) => event.allowanceRevision)).toEqual([1, 2]);
    expect(
      Schema.is(GovernVariantAllowedValuesActionConflictProblemSchema)(yield* restrict(['matte'], 1).pipe(Effect.flip)),
    ).toBe(true);
    expect(
      Schema.is(GovernVariantAllowedValuesActionConflictProblemSchema)(
        yield* restrict(['matte'], 2, 0).pipe(Effect.flip),
      ),
    ).toBe(true);
    expect(yield* observeAllowance()).toEqual(stored);
    expect(yield* restrict([], 2)).toMatchObject({ allowanceRevision: 3, changed: true });
    expect((yield* read()).evidence).toMatchObject({ status: 'INVALID' });
    expect((yield* read(alternate)).evidence).toMatchObject({ status: 'INVALID' });
    expect((yield* read(otherProduct.selected)).evidence).toMatchObject({ status: 'VALID' });
    expect(yield* observeHistory()).toEqual(history);
    const emptied = yield* observeAllowance();
    expect(emptied.events[0]).toEqual(stored.events[0]);
    expect(emptied.values.filter((value) => value.allowanceRevision === 1)).toEqual(
      stored.values.filter((value) => value.allowanceRevision === 1),
    );
    const unauthenticated = yield* executeSelectionEvidenceWithAuthorization(
      { purpose: 'PRICING', selection: selected },
      'Bearer invalid',
      yield* nextId,
      {
        baseUrl,
        compositionRevision: composition.composition.revision,
      },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch), Effect.flip);
    expect(Schema.is(SelectionEvidenceAuthenticationProblemSchema)(unauthenticated)).toBe(true);
    const forbiddenLegalEntity = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
    expect(
      Schema.is(SelectionEvidenceForbiddenProblemSchema)(yield* read(selected, forbiddenLegalEntity).pipe(Effect.flip)),
    ).toBe(true);
    const foreignTenantId = yield* nextId;
    const foreignSelection = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
      productRef: { ...selected.productRef, tenantId: foreignTenantId },
      variantRef: { ...selected.variantRef, tenantId: foreignTenantId },
    });
    expect(Schema.is(SelectionEvidenceUnavailableProblemSchema)(yield* read(foreignSelection).pipe(Effect.flip))).toBe(
      true,
    );
    const denied = yield* read(selected, fixture.denied).pipe(Effect.flip);
    expect(Schema.is(SelectionEvidenceForbiddenProblemSchema)(denied)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(productAxisAllowanceTestServices)),
);
