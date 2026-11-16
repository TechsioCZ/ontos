import { ImportSymmyRulePayloadSchema } from '@app/assortment/actions/import-symmy-rule';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import type { SymmyOwnerEffectRef } from '@app/shared-contracts/symmy';
import { ImportSellerVatRegimeDeclarationsPayloadSchema } from '@app/tax/actions/import-seller-vat-regime-declarations';
import { Effect, Match, Schema } from 'effect';

import {
  mapSymmyAssortmentRule,
  SymmyAssortmentRuleSourceSchema,
  symmyAssortmentRuleOperation,
} from './symmy-assortment-rule-mapping.ts';
import {
  mapSymmySellerVatDeclaration,
  SymmySellerVatDeclarationSourceSchema,
  symmySellerVatDeclarationOperation,
} from './symmy-seller-vat-declaration-mapping.ts';

const assortmentFixtureRoute = 'assortmentRulesFixtureBatch';
const sellerVatFixtureRoute = 'sellerVatDeclarationsFixtureBatch';
export const SymmyPolicyFixtureRouteKeySchema = Schema.Literals([assortmentFixtureRoute, sellerVatFixtureRoute]);

export const SymmyPolicyFixtureIntentSchema = Schema.Union([
  Schema.TaggedStruct('AssortmentRuleFixture', { source: SymmyAssortmentRuleSourceSchema }),
  Schema.TaggedStruct('SellerVatDeclarationFixture', {
    migrationStartedAt: Schema.DateTimeUtcFromString,
    source: SymmySellerVatDeclarationSourceSchema,
  }),
]);

const MappedAssortmentRuleSchema = Schema.TaggedStruct('AssortmentRuleFixture', {
  payload: ImportSymmyRulePayloadSchema,
});
const MappedSellerVatDeclarationSchema = Schema.TaggedStruct('SellerVatDeclarationFixture', {
  payload: ImportSellerVatRegimeDeclarationsPayloadSchema,
});
type MappedPolicyFixture = typeof MappedAssortmentRuleSchema.Type | typeof MappedSellerVatDeclarationSchema.Type;

class SymmyPolicyFixtureMismatch extends Schema.TaggedError<SymmyPolicyFixtureMismatch>()(
  'SymmyPolicyFixtureMismatch',
  { cause: Schema.optionalKey(Schema.Unknown) },
) {}

export const mapSymmyPolicyFixtureIntent = Effect.fn('SymmyPolicyFixture.mapPinnedIntent')(function* mapPinned(
  ref: SymmyOwnerEffectRef,
  intent: typeof SymmyPolicyFixtureIntentSchema.Type,
  routeKey: string | undefined,
  legalEntityId: string | undefined,
): Effect.fn.Return<MappedPolicyFixture, SymmyPolicyFixtureMismatch> {
  const { record } = ref.occurrence;
  const fixture = Match.value(intent).pipe(
    Match.tags({
      AssortmentRuleFixture: () => ({
        entityKind: 'ASSORTMENT_RULE',
        operation: symmyAssortmentRuleOperation,
        routeKey: assortmentFixtureRoute,
      }),
      SellerVatDeclarationFixture: () => ({
        entityKind: 'SELLER_VAT_REGIME_DECLARATION',
        operation: symmySellerVatDeclarationOperation,
        routeKey: sellerVatFixtureRoute,
      }),
    }),
    Match.exhaustive,
  );
  const { operation } = fixture;
  if (
    routeKey !== fixture.routeKey ||
    ref.originalTarget !== undefined ||
    record.sourceRecordId !== intent.source.sourceRecordId ||
    record.entityKind !== fixture.entityKind ||
    !Schema.is(LegalEntityIdSchema)(legalEntityId) ||
    ref.operation.moduleId !== operation.moduleId ||
    ref.operation.entrypointKey !== operation.entrypointKey ||
    ref.operation.schemaVersion !== operation.schemaVersion
  ) {
    return yield* new SymmyPolicyFixtureMismatch();
  }
  const route = {
    allowedOwnerOperations: [ref.operation] as const,
    factFamily: record.entityKind,
    issuerId: record.issuerId,
    mappingVersion: ref.mappingVersion,
    route: record.route,
    sellingLegalEntityId: legalEntityId,
    sourceNamespace: record.sourceNamespace,
  };
  return yield* Match.value(intent).pipe(
    Match.tags({
      AssortmentRuleFixture: ({ source }) =>
        mapSymmyAssortmentRule(route, source).pipe(
          Effect.map(({ payload }) => MappedAssortmentRuleSchema.make({ payload })),
        ),
      SellerVatDeclarationFixture: ({ migrationStartedAt, source }) =>
        mapSymmySellerVatDeclaration(route, migrationStartedAt, source).pipe(
          Effect.map(({ payload }) => MappedSellerVatDeclarationSchema.make({ payload })),
        ),
    }),
    Match.exhaustive,
    Effect.mapError((cause) => new SymmyPolicyFixtureMismatch({ cause })),
  );
});
