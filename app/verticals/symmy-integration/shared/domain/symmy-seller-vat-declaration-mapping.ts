import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { qualifySymmySourceRecord, SymmySourceRecordKeySchema } from '@app/shared-contracts/symmy';
import type { SymmyRouteContext } from '@app/shared-contracts/symmy';
import { ImportSellerVatRegimeDeclarationsPayloadSchema } from '@app/tax/actions/import-seller-vat-regime-declarations';
import { Effect, Schema } from 'effect';
import type { DateTime } from 'effect';

import { symmySourceRecordFingerprint } from './symmy-source-record-fingerprint.ts';

const mappingVersion = 'INTERNAL_C14_SELLER_VAT_DECLARATION_V1';
export const symmySellerVatDeclarationOperation = {
  entrypointKey: 'commerce.tax.import-seller-vat-regime-declarations',
  moduleId: 'commerce.tax',
  schemaVersion: '1',
} as const;
const declarationFields = ImportSellerVatRegimeDeclarationsPayloadSchema.fields.declarations.value.fields;

/** The first fixture requires one existing seller declaration with a date supplied by its source. */
export const SymmySellerVatDeclarationSourceSchema = Schema.Struct({
  contractVersion: Schema.Literal(mappingVersion),
  effectiveFrom: Schema.DateTimeUtcFromString,
  reason: declarationFields.reason,
  regime: declarationFields.regime,
  sellingLegalEntityId: LegalEntityIdSchema,
  sourceRecordId: SymmySourceRecordKeySchema.fields.sourceRecordId,
});
export const decodeSymmySellerVatDeclarationSource = Schema.decodeUnknownEffect(SymmySellerVatDeclarationSourceSchema, {
  onExcessProperty: 'error',
});

class SymmySellerVatDeclarationMappingRejected extends Schema.TaggedError<SymmySellerVatDeclarationMappingRejected>()(
  'SymmySellerVatDeclarationMappingRejected',
  { reason: Schema.Literals(['route_not_allowed', 'seller_scope_mismatch']) },
) {}

/** Prepares a single seller import. Keep the admitted run's start fixed across attempts. */
export const mapSymmySellerVatDeclaration = Effect.fn('SymmySellerVatDeclaration.map')(function* mapDeclaration(
  route: Pick<
    SymmyRouteContext,
    | 'allowedOwnerOperations'
    | 'factFamily'
    | 'issuerId'
    | 'mappingVersion'
    | 'route'
    | 'sellingLegalEntityId'
    | 'sourceNamespace'
  >,
  migrationStartedAt: DateTime.Utc,
  source: typeof SymmySellerVatDeclarationSourceSchema.Type,
) {
  if (
    route.factFamily !== 'SELLER_VAT_REGIME_DECLARATION' ||
    route.mappingVersion !== mappingVersion ||
    route.sellingLegalEntityId === undefined ||
    !route.allowedOwnerOperations.some(
      (operation) =>
        operation.moduleId === symmySellerVatDeclarationOperation.moduleId &&
        operation.entrypointKey === symmySellerVatDeclarationOperation.entrypointKey &&
        operation.schemaVersion === symmySellerVatDeclarationOperation.schemaVersion,
    )
  ) {
    return yield* new SymmySellerVatDeclarationMappingRejected({ reason: 'route_not_allowed' });
  }
  if (source.sellingLegalEntityId !== route.sellingLegalEntityId) {
    return yield* new SymmySellerVatDeclarationMappingRejected({ reason: 'seller_scope_mismatch' });
  }

  const record = qualifySymmySourceRecord(route, {
    entityKind: 'SELLER_VAT_REGIME_DECLARATION',
    sourceRecordId: source.sourceRecordId,
  });
  const digest = symmySourceRecordFingerprint(record);
  const declaration = {
    effectiveFrom: source.effectiveFrom,
    regime: source.regime,
    sourceRecordRef: `internal-c14-record:${digest}`,
  };
  const payload = yield* Schema.decodeUnknownEffect(Schema.toType(ImportSellerVatRegimeDeclarationsPayloadSchema))({
    declarations: [source.reason === undefined ? declaration : { ...declaration, reason: source.reason }],
    migrationRunRef: `internal-c14-seller-vat:${digest}`,
    migrationStartedAt,
  });
  return { payload, record };
});
