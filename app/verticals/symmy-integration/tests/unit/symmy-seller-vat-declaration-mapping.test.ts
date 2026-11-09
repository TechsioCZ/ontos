import { SymmyRouteContextSchema } from '@app/shared-contracts/symmy';
import { ImportSellerVatRegimeDeclarationsPayloadSchema } from '@app/tax/actions/import-seller-vat-regime-declarations';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  decodeSymmySellerVatDeclarationSource,
  mapSymmySellerVatDeclaration,
} from '../../shared/symmy-internal-contracts.ts';

const seller = '50aa3386-3f2a-456a-8ad6-28e402754e26';
const otherSeller = '1dd44237-098e-4afc-825f-f1448fd6f0ee';
const version = 'INTERNAL_C14_SELLER_VAT_DECLARATION_V1';
const start = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-11-01T00:00:00.000Z');
const route = Schema.decodeUnknownSync(SymmyRouteContextSchema)({
  allowedOwnerOperations: [
    {
      entrypointKey: 'commerce.tax.import-seller-vat-regime-declarations',
      moduleId: 'commerce.tax',
      schemaVersion: '1',
    },
  ],
  factFamily: 'SELLER_VAT_REGIME_DECLARATION',
  issuerId: 'fixture-seller-declaration-producer',
  mappingVersion: version,
  principalId: 'b3e8bc14-be85-4d83-acd9-2516b89cff6e',
  route: { integrationRouteId: 'test-seller-declarations', tenantId: '3d46590b-7eae-422c-9643-e5bd5c13403b' },
  routeRevision: '1',
  sellingLegalEntityId: seller,
  sourceNamespace: 'seller-regimes',
});
const source = {
  contractVersion: version,
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  regime: 'VAT_PAYER',
  sellingLegalEntityId: seller,
  sourceRecordId: 'source-declaration-1',
};

it.effect('maps a seller declaration to the public Tax import payload with distinct source and run identities', () =>
  Effect.gen(function* sellerDeclarationMapping() {
    const fact = yield* decodeSymmySellerVatDeclarationSource(source);
    const mapped = yield* mapSymmySellerVatDeclaration(route, start, fact);
    const encoded = yield* Schema.encodeEffect(ImportSellerVatRegimeDeclarationsPayloadSchema)(mapped.payload);
    expect(mapped.record).toMatchObject({ issuerId: route.issuerId, sourceRecordId: source.sourceRecordId });
    expect(encoded.declarations).toEqual([
      {
        effectiveFrom: source.effectiveFrom,
        regime: 'VAT_PAYER',
        sourceRecordRef: mapped.payload.declarations[0].sourceRecordRef,
      },
    ]);
    expect(encoded.migrationRunRef).not.toBe(encoded.declarations[0].sourceRecordRef);
    expect(DateTime.formatIso(mapped.payload.migrationStartedAt)).toBe('2026-11-01T00:00:00.000Z');
    expect(yield* mapSymmySellerVatDeclaration(route, start, fact)).toEqual(mapped);
  }),
);

it.effect('rejects a seller outside the admitted company or a different operation version', () =>
  Effect.gen(function* foreignSellerOrOperation() {
    const otherFact = yield* decodeSymmySellerVatDeclarationSource({ ...source, sellingLegalEntityId: otherSeller });
    const wrongSeller = yield* Effect.flip(mapSymmySellerVatDeclaration(route, start, otherFact));
    expect(wrongSeller).toMatchObject({ reason: 'seller_scope_mismatch' });
    const wrongVersion = Schema.decodeUnknownSync(SymmyRouteContextSchema)({
      ...route,
      allowedOwnerOperations: [{ ...route.allowedOwnerOperations[0], schemaVersion: '2' }],
    });
    const fact = yield* decodeSymmySellerVatDeclarationSource(source);
    const denied = yield* Effect.flip(mapSymmySellerVatDeclaration(wrongVersion, start, fact));
    expect(denied).toMatchObject({ reason: 'route_not_allowed' });
  }),
);

it.effect('rejects a product VAT rate and missing effective date without substituting the migration start', () =>
  Effect.gen(function* missingExplicitSellerFact() {
    const hint = yield* Effect.flip(decodeSymmySellerVatDeclarationSource({ ...source, vat_rate: 21 }));
    expect(Schema.isSchemaError(hint)).toBe(true);
    const { contractVersion, regime, sellingLegalEntityId, sourceRecordId } = source;
    const undated = yield* Effect.flip(
      decodeSymmySellerVatDeclarationSource({
        contractVersion,
        regime,
        sellingLegalEntityId,
        sourceRecordId,
      }),
    );
    expect(Schema.isSchemaError(undated)).toBe(true);
  }),
);
