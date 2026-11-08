import { Schema } from 'effect';

import { CounterpartyRefSchema } from '../resources/counterparty.ts';
import { PartyRefSchema } from '../resources/party.ts';

const BoundedTitleSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));

export const PartySearchQuerySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const CurrentCounterpartyRoleSchema = Schema.Literals(['CUSTOMER', 'SUPPLIER']);
export type CurrentCounterpartyRole = typeof CurrentCounterpartyRoleSchema.Type;

const SearchLegalEntityContextSchema = Schema.Struct({
  legalEntityId: Schema.toEncoded(LegalEntityIdSchema),
  tenantId: Schema.toEncoded(TenantIdSchema),
});
export type SearchLegalEntityContext = typeof SearchLegalEntityContextSchema.Type;

export const PartySearchResultSchema = Schema.Struct({
  archived: Schema.Boolean,
  matchedViaAlias: Schema.Boolean,
  ref: PartyRefSchema,
  title: BoundedTitleSchema,
});
export type PartySearchResult = typeof PartySearchResultSchema.Type;
/**
 * A Party search row as the read answers it: the name is a governed field class, so a caller without
 * the identity capability receives the row without its title (O17, O58).
 */
export const PartySearchResultViewSchema = Schema.Struct({
  ...PartySearchResultSchema.fields,
  title: Schema.optionalKey(BoundedTitleSchema),
});

const CounterpartyCollisionSchema = Schema.Struct({
  counterpartyRefs: Schema.Array(CounterpartyRefSchema),
  kind: Schema.Literal('CANONICAL_PARTY_COUNTERPARTY_COLLISION'),
});

const CounterpartySearchPartySchema = Schema.Struct({
  archived: Schema.Boolean,
  matchedViaAlias: Schema.Boolean,
  ref: PartyRefSchema,
  title: BoundedTitleSchema,
});

export const CounterpartySearchResultSchema = Schema.Struct({
  collision: Schema.optionalKey(CounterpartyCollisionSchema),
  currentRoles: Schema.Array(CurrentCounterpartyRoleSchema),
  legalEntity: SearchLegalEntityContextSchema,
  party: CounterpartySearchPartySchema,
  ref: CounterpartyRefSchema,
});
export type CounterpartySearchResult = typeof CounterpartySearchResultSchema.Type;
/**
 * A Counterparty search row as the read answers it: the Party name is a governed field class, so a
 * caller without the identity capability receives the row without the Party title (O17, O58).
 */
export const CounterpartySearchResultViewSchema = Schema.Struct({
  ...CounterpartySearchResultSchema.fields,
  party: Schema.Struct({ ...CounterpartySearchPartySchema.fields, title: Schema.optionalKey(BoundedTitleSchema) }),
});
