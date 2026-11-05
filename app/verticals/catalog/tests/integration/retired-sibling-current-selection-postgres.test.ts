import { Crypto, Effect, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import {
  SelectionEvidenceForbiddenProblemSchema,
  SelectionEvidenceUnavailableProblemSchema,
} from '../../shared/apis/selection-evidence.ts';
import { RetireVariantResultSchema } from '../../shared/actions/retire-variant.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { requireExecutionResult } from '../support/action-execution-result.ts';
import { makeRetiredSiblingFixture, retiredSiblingTestServices } from '../support/retired-sibling-receiver.fixture.ts';

it.live(
  'keeps healthy V2 Current after actual V1 retirement with retained direct attributes',
  () =>
    Effect.gen(function* retiredSiblingNative() {
      const {
        alternate,
        deniedAccess,
        fixture,
        nativeRead,
        noDirectProduct,
        observeHistory,
        packageSelection,
        read,
        retire,
        selected,
      } = yield* makeRetiredSiblingFixture();
      expect((yield* read(noDirectProduct.selected)).evidence).toMatchObject({ status: 'VALID' });
      expect((yield* read(noDirectProduct.alternate)).evidence).toMatchObject({ status: 'VALID' });
      yield* retire(noDirectProduct.selected);
      expect((yield* read(noDirectProduct.alternate)).evidence).toMatchObject({ status: 'VALID' });
      // v2: the one access gate decides this read (O62), so the principal with no assignment is
      // named on the fixture's own per-request owner seam (see `live-access-authority`).
      deniedAccess.deny(fixture.denied.principalId, 'commerce.catalog.selection-evidence.read');
      expect(
        Schema.is(SelectionEvidenceForbiddenProblemSchema)(yield* read(alternate, fixture.denied).pipe(Effect.flip)),
      ).toBe(true);
      const foreignTenantId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
      const foreignSelection = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        productRef: { ...alternate.productRef, tenantId: foreignTenantId },
        variantRef: { ...alternate.variantRef, tenantId: foreignTenantId },
      });
      expect(
        Schema.is(SelectionEvidenceUnavailableProblemSchema)(yield* read(foreignSelection).pipe(Effect.flip)),
      ).toBe(true);
      const before = yield* observeHistory();
      expect(before.valueSets.some((set) => set.variantId === noDirectProduct.selected.variantRef.resourceId)).toBe(
        false,
      );
      expect(before.valueSets.some((set) => set.variantId === selected.variantRef.resourceId)).toBe(true);
      expect((yield* read(selected)).evidence).toMatchObject({ status: 'VALID' });
      expect((yield* read(alternate)).evidence).toMatchObject({ status: 'VALID' });
      expect((yield* read(packageSelection)).evidence).toMatchObject({ status: 'VALID' });
      const retired = yield* requireExecutionResult(RetireVariantResultSchema, retire());
      expect(retired.variant).toMatchObject({ lifecycle: 'RETIRED', variantRef: selected.variantRef });
      expect((yield* nativeRead(alternate)).evidence).toMatchObject({ status: 'VALID' });
      const healthy = yield* read(alternate);
      expect(healthy.evidence).toMatchObject({ status: 'VALID' });
      assert('basis' in healthy.evidence);
      expect(healthy.evidence.basis.find((fact) => fact.role === 'VARIANT')?.source.resourceRef).toEqual(
        alternate.variantRef,
      );
      expect((yield* read(selected)).evidence).toMatchObject({ status: 'INVALID' });
      expect((yield* read(packageSelection)).evidence).toMatchObject({ status: 'INVALID' });
      const after = yield* observeHistory();
      expect(after.valueSets).toEqual(before.valueSets);
      expect(after.valueRevisions).toEqual(before.valueRevisions);
      expect(after.valueItems).toEqual(before.valueItems);
      expect(after.definitions).toEqual(before.definitions);
      expect(after.revisions.filter((row) => row.variantId !== selected.variantRef.resourceId)).toEqual(
        before.revisions.filter((row) => row.variantId !== selected.variantRef.resourceId),
      );
      expect(after.revisions.filter((row) => row.variantId === selected.variantRef.resourceId)).toHaveLength(
        before.revisions.filter((row) => row.variantId === selected.variantRef.resourceId).length + 1,
      );
    }).pipe(Effect.scoped, Effect.provide(retiredSiblingTestServices)),
  120_000,
);
