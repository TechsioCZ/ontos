import { Schema } from 'effect';

import { PartyOfficialIdentifierRefSchema } from '../resources/party-official-identifier.ts';
import { PartyRefSchema } from '../resources/party.ts';
import { AresAppliedEvidenceSchema } from './ares-application.ts';
import { CanonicalUtcTimestampJsonSchema } from './canonical-utc-timestamp.ts';

export { OfficialIdentifierClaimConflict } from './identifier-errors/claim-conflict.ts';
export { OfficialIdentifierInvalid } from './identifier-errors/invalid.ts';

const OfficialIdentifierTypeSchema = Schema.Literals(['ICO', 'CZ_DIC']);

export const isValidCzechIco = (value: string): boolean => {
  if (!/^[0-9]{8}$/u.test(value)) {
    return false;
  }
  const weights = [8, 7, 6, 5, 4, 3, 2] as const;
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  return Number(value[7]) === (11 - (sum % 11)) % 10;
};

export const OfficialIdentifierInputSchema = Schema.Struct({
  identifierType: OfficialIdentifierTypeSchema,
  namespace: Schema.optionalKey(Schema.Never),
  value: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
}).check(
  Schema.makeFilter((input) => {
    const value = input.value.trim().toUpperCase();
    if (input.identifierType === 'ICO') {
      return /^[0-9]{1,8}$/u.test(value) && isValidCzechIco(value.padStart(8, '0'))
        ? undefined
        : 'invalid ICO format or checksum';
    }
    return /^CZ[0-9]{8,10}$/u.test(value) ? undefined : 'invalid CZ_DIC format';
  }),
);
export type OfficialIdentifierInput = typeof OfficialIdentifierInputSchema.Type;

export interface NormalizedOfficialIdentifier extends Omit<OfficialIdentifierInput, 'value' | 'namespace'> {
  readonly namespace: 'CZ:DIC' | 'CZ:ICO';
  readonly normalizedValue: string;
}

export const normalizeOfficialIdentifier = (input: OfficialIdentifierInput): NormalizedOfficialIdentifier => {
  const normalizedValue =
    input.identifierType === 'ICO' ? input.value.trim().padStart(8, '0') : input.value.trim().toUpperCase();
  return {
    identifierType: input.identifierType,
    namespace: input.identifierType === 'ICO' ? 'CZ:ICO' : 'CZ:DIC',
    normalizedValue,
  };
};

export const OfficialIdentifierAssertionStateSchema = Schema.Literals([
  'ACTIVE',
  'ENDED',
  'SUPERSEDED',
  'RETRACTED',
  'DISPUTED',
]);

/** Retained ICO digits must normalize to the canonical value they were asserted with. */
const originalDigitsIssue = (assertion: {
  readonly identifierType: string;
  readonly normalizedValue?: string;
  readonly originalInputDigits?: string | null;
}): string | undefined =>
  assertion.originalInputDigits === undefined ||
  assertion.originalInputDigits === null ||
  (assertion.identifierType === 'ICO' && assertion.originalInputDigits.padStart(8, '0') === assertion.normalizedValue)
    ? undefined
    : 'original ICO digits must normalize to the asserted canonical value';

const officialIdentifierAssertionFields = {
  externalEvidence: Schema.optionalKey(Schema.toEncoded(Schema.OptionFromNullOr(AresAppliedEvidenceSchema))),
  identifierType: OfficialIdentifierTypeSchema,
  namespace: Schema.String,
  normalizedValue: Schema.String,
  // Additive V1 evidence: omitted by older producers; NULL means no retained source proof.
  originalInputDigits: Schema.optionalKey(
    Schema.toEncoded(Schema.OptionFromNullOr(Schema.String.check(Schema.isPattern(/^[0-9]{1,8}$/u)))),
  ),
  officialIdentifierRef: PartyOfficialIdentifierRefSchema,
  partyRef: PartyRefSchema,
  recordedAt: CanonicalUtcTimestampJsonSchema,
  state: OfficialIdentifierAssertionStateSchema,
  validFrom: CanonicalUtcTimestampJsonSchema,
  validTo: Schema.toEncoded(Schema.OptionFromNullOr(CanonicalUtcTimestampJsonSchema)),
};

export const OfficialIdentifierAssertionSchema = Schema.Struct(officialIdentifierAssertionFields).check(
  Schema.makeFilter(originalDigitsIssue),
);
export type OfficialIdentifierAssertion = typeof OfficialIdentifierAssertionSchema.Type;
/**
 * An official identifier as a read answers it: the value is a governed field class, so a caller
 * without the value capability receives the assertion without it (O17, O58).
 */
export const OfficialIdentifierAssertionViewSchema = Schema.Struct({
  ...officialIdentifierAssertionFields,
  normalizedValue: Schema.optionalKey(Schema.String),
}).check(Schema.makeFilter(originalDigitsIssue));
