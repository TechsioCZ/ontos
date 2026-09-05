import { Schema } from 'effect';
import { CounterpartyRefSchema } from '../resources/counterparty.ts';
import { PartyRefSchema } from '../resources/party.ts';

const BoundedTitleSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const TenantIdSchema = Schema.String.check(Schema.isUUID());
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID());

export const PartySearchQuerySchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
);

export const CurrentCounterpartyRoleSchema = Schema.Literals(['CUSTOMER', 'SUPPLIER']);
export type CurrentCounterpartyRole = typeof CurrentCounterpartyRoleSchema.Type;

export const SearchLegalEntityContextSchema = Schema.Struct({
  legalEntityId: LegalEntityIdSchema,
  tenantId: TenantIdSchema,
});
export type SearchLegalEntityContext = typeof SearchLegalEntityContextSchema.Type;

export const PartySearchResultSchema = Schema.Struct({
  archived: Schema.Boolean,
  matchedViaAlias: Schema.Boolean,
  ref: PartyRefSchema,
  title: BoundedTitleSchema,
});
export type PartySearchResult = typeof PartySearchResultSchema.Type;

export const CounterpartyCollisionSchema = Schema.Struct({
  counterpartyRefs: Schema.Array(CounterpartyRefSchema),
  kind: Schema.Literal('CANONICAL_PARTY_COUNTERPARTY_COLLISION'),
});
export type CounterpartyCollision = typeof CounterpartyCollisionSchema.Type;

export const CounterpartySearchResultSchema = Schema.Struct({
  collision: Schema.optionalKey(CounterpartyCollisionSchema),
  currentRoles: Schema.Array(CurrentCounterpartyRoleSchema),
  legalEntity: SearchLegalEntityContextSchema,
  party: Schema.Struct({
    archived: Schema.Boolean,
    matchedViaAlias: Schema.Boolean,
    ref: PartyRefSchema,
    title: BoundedTitleSchema,
  }),
  ref: CounterpartyRefSchema,
});
export type CounterpartySearchResult = typeof CounterpartySearchResultSchema.Type;
