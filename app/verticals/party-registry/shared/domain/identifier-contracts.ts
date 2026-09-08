import { Schema } from 'effect';

import { PartyOfficialIdentifierRefSchema } from '../resources/party-official-identifier.ts';
import { PartyRefSchema } from '../resources/party.ts';
import { AresAppliedEvidenceSchema } from './ares-application.ts';
import { CanonicalUtcTimestampJsonSchema } from './canonical-utc-timestamp.ts';

export { OfficialIdentifierClaimConflict } from './identifier-errors/claim-conflict.ts';
export { OfficialIdentifierInvalid } from './identifier-errors/invalid.ts';

const OfficialIdentifierTypeSchema = Schema.Literals(['ICO', 'CZ_DIC']);
export const IdentifierVerificationSchema = Schema.Literals([
  'UNVERIFIED',
  'VERIFIED',
  'REJECTED',
]);
export type IdentifierVerification = typeof IdentifierVerificationSchema.Type;

const isValidCzechIco = (value: string): boolean => {
  if (!/^[0-9]{8}$/u.test(value)) {
    return false;
  }
  const weights = [8, 7, 6, 5, 4, 3, 2] as const;
  const sum = weights.reduce(
    (total, weight, index) => total + Number(value[index]) * weight,
    0
  );
  return Number(value[7]) === (11 - (sum % 11)) % 10;
};

export const OfficialIdentifierInputSchema = Schema.Struct({
  identifierType: OfficialIdentifierTypeSchema,
  namespace: Schema.optionalKey(Schema.Never),
  value: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  verification: IdentifierVerificationSchema,
}).check(
  Schema.makeFilter((input) => {
    const value = input.value.trim().toUpperCase();
    if (input.identifierType === 'ICO') {
      return /^[0-9]{1,8}$/u.test(value) &&
        isValidCzechIco(value.padStart(8, '0'))
        ? undefined
        : 'invalid ICO format or checksum';
    }
    return /^CZ[0-9]{8,10}$/u.test(value) ? undefined : 'invalid CZ_DIC format';
  })
);
export type OfficialIdentifierInput = typeof OfficialIdentifierInputSchema.Type;

export interface NormalizedOfficialIdentifier extends Omit<
  OfficialIdentifierInput,
  'value' | 'namespace'
> {
  readonly namespace: 'CZ:DIC' | 'CZ:ICO';
  readonly normalizedValue: string;
}

export const normalizeOfficialIdentifier = (
  input: OfficialIdentifierInput
): NormalizedOfficialIdentifier => {
  const normalizedValue =
    input.identifierType === 'ICO'
      ? input.value.trim().padStart(8, '0')
      : input.value.trim().toUpperCase();
  return {
    identifierType: input.identifierType,
    namespace: input.identifierType === 'ICO' ? 'CZ:ICO' : 'CZ:DIC',
    normalizedValue,
    verification: input.verification,
  };
};

export const qualifiesForExclusiveClaim = (
  identifier: NormalizedOfficialIdentifier,
  partyType: 'ORGANIZATION' | 'PERSON' | 'UNRESOLVED',
  matchRuleVersion: string
): boolean =>
  matchRuleVersion === 'party-exact-claims.v1' &&
  identifier.verification === 'VERIFIED' &&
  partyType === 'ORGANIZATION';

export const qualifyingClaimKey = (
  input: OfficialIdentifierInput,
  partyType: 'ORGANIZATION' | 'PERSON' | 'UNRESOLVED',
  matchRuleVersion: string
): string | undefined => {
  const normalized = normalizeOfficialIdentifier(input);
  return qualifiesForExclusiveClaim(normalized, partyType, matchRuleVersion)
    ? [
        normalized.identifierType,
        normalized.namespace,
        normalized.normalizedValue,
      ].join('\u0000')
    : undefined;
};

export const OfficialIdentifierAssertionStateSchema = Schema.Literals([
  'ACTIVE',
  'ENDED',
  'SUPERSEDED',
  'RETRACTED',
  'DISPUTED',
]);

export const OfficialIdentifierAssertionSchema = Schema.Struct({
  externalEvidence: Schema.optionalKey(
    Schema.toEncoded(Schema.OptionFromNullOr(AresAppliedEvidenceSchema))
  ),
  identifierType: OfficialIdentifierTypeSchema,
  namespace: Schema.String,
  normalizedValue: Schema.String,
  officialIdentifierRef: PartyOfficialIdentifierRefSchema,
  partyRef: PartyRefSchema,
  recordedAt: CanonicalUtcTimestampJsonSchema,
  state: OfficialIdentifierAssertionStateSchema,
  validFrom: CanonicalUtcTimestampJsonSchema,
  validTo: Schema.toEncoded(
    Schema.OptionFromNullOr(CanonicalUtcTimestampJsonSchema)
  ),
  verification: IdentifierVerificationSchema,
});
export type OfficialIdentifierAssertion =
  typeof OfficialIdentifierAssertionSchema.Type;
