import { Match, Schema } from 'effect';

import { PartyContactPointRefSchema } from '../resources/party-contact-point.ts';
import { PartyRefSchema } from '../resources/party.ts';
import { AresAppliedEvidenceSchema } from './ares-application.ts';
import { normalizeContactPhone } from './contact-phone-normalization.ts';
import { PartyContactPointInvalid } from './contact-point-errors.ts';
import { IsoTimestampSchema } from './identity-contracts.ts';

const TrimmedTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const OptionalTrimmedTextSchema = Schema.optionalKey(TrimmedTextSchema);
const RegistryKeySchema = TrimmedTextSchema.pipe(Schema.brand('RegistryKey'), Schema.decodeTo(TrimmedTextSchema));
const EndedByActionInvocationIdSchema = TrimmedTextSchema.pipe(
  Schema.brand('EndedByActionInvocationId'),
  Schema.decodeTo(TrimmedTextSchema),
);
const EndedByPrincipalIdSchema = TrimmedTextSchema.pipe(
  Schema.brand('EndedByPrincipalId'),
  Schema.decodeTo(TrimmedTextSchema),
);
export const ContactPointTimestampSchema = IsoTimestampSchema;

export const ContactPointTypeSchema = Schema.Literals(['EMAIL', 'PHONE', 'ADDRESS']);

const AddressPurposeSchema = Schema.Literals(['REGISTERED', 'BILLING', 'DELIVERY', 'CORRESPONDENCE']);

const ContactPointLifecycleStateSchema = Schema.Literals(['ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED']);

export const ContactPointPrivacyClassificationSchema = Schema.Literals(['PUBLIC', 'BUSINESS_SENSITIVE', 'PERSONAL']);
export type ContactPointPrivacyClassification = typeof ContactPointPrivacyClassificationSchema.Type;

export const ContactPointProvenanceSchema = Schema.Struct({
  authoritative: Schema.Boolean,
  evidenceReference: Schema.optionalKey(TrimmedTextSchema),
  externalEvidence: Schema.optionalKey(AresAppliedEvidenceSchema),
  method: Schema.Literals([
    'MANUAL_CONFIRMATION',
    'DECLARED_BY_PARTY',
    'DOCUMENT_REVIEW',
    'PROVIDER_OBSERVATION',
    'MIGRATION',
  ]),
  source: Schema.Literals(['USER_ASSERTION', 'PARTY_DECLARATION', 'EXTERNAL_EVIDENCE', 'MIGRATION_DATASET']),
});
export type ContactPointProvenance = typeof ContactPointProvenanceSchema.Type;
const ContactPointProvenanceHistorySchema = Schema.Struct({
  ...ContactPointProvenanceSchema.fields,
  evidenceReferences: Schema.optionalKey(Schema.Array(TrimmedTextSchema).check(Schema.isMaxLength(33))),
});

const EmailValueSchema = Schema.Trim.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
);

export const EmailContactPointInputSchema = Schema.Struct({
  preferred: Schema.Boolean,
  type: Schema.Literal('EMAIL'),
  value: EmailValueSchema,
});

const PhoneValueSchema = Schema.Trim.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(100),
  Schema.isPattern(/^\+?[()0-9 .-]+$/u),
);
const CountryCodeSchema = Schema.Trim.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(2),
  Schema.isPattern(/^[A-Za-z]{2}$/u),
);
const PhoneSharedFields = {
  extension: Schema.optionalKey(
    Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(12), Schema.isPattern(/^[0-9]+$/u)),
  ),
  preferred: Schema.Boolean,
  type: Schema.Literal('PHONE'),
} as const;
export const PhoneContactPointInputSchema = Schema.Union([
  Schema.Struct({
    ...PhoneSharedFields,
    countryCode: Schema.optionalKey(CountryCodeSchema),
    value: PhoneValueSchema.check(Schema.isPattern(/^\+[() .-]*[1-9]/u)),
  }),
  Schema.Struct({
    ...PhoneSharedFields,
    countryCode: CountryCodeSchema,
    value: PhoneValueSchema.check(Schema.isPattern(/^[0-9(]/u)),
  }),
]);

const StructuredAddressSchema = Schema.Struct({
  addressLine1: OptionalTrimmedTextSchema,
  addressLine2: OptionalTrimmedTextSchema,
  city: OptionalTrimmedTextSchema,
  countryCode: CountryCodeSchema,
  postalCode: OptionalTrimmedTextSchema,
  region: OptionalTrimmedTextSchema,
});
export type StructuredAddress = typeof StructuredAddressSchema.Type;

export const AddressPurposeAssignmentSchema = Schema.Struct({
  preferred: Schema.Boolean,
  purpose: AddressPurposeSchema,
  registryContext: Schema.optionalKey(
    Schema.Struct({
      jurisdiction: TrimmedTextSchema,
      registryKey: RegistryKeySchema,
    }),
  ),
});
export type AddressPurposeAssignment = typeof AddressPurposeAssignmentSchema.Type;

export const AddressPurposeTargetSchema = Schema.Struct({
  purpose: AddressPurposeSchema,
  registryContext: Schema.optionalKey(
    Schema.Struct({
      jurisdiction: TrimmedTextSchema,
      registryKey: RegistryKeySchema,
    }),
  ),
});
export type AddressPurposeTarget = typeof AddressPurposeTargetSchema.Type;

export const AddressContactPointInputSchema = Schema.Struct({
  address: StructuredAddressSchema,
  purposes: Schema.Array(AddressPurposeAssignmentSchema).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  type: Schema.Literal('ADDRESS'),
});

export const ContactPointInputSchema = Schema.Union([
  EmailContactPointInputSchema,
  PhoneContactPointInputSchema,
  AddressContactPointInputSchema,
]);
export type ContactPointInput = typeof ContactPointInputSchema.Type;

export const ContactPointEndSchema = Schema.Struct({
  effectiveEnd: ContactPointTimestampSchema,
  endedByActionInvocationId: EndedByActionInvocationIdSchema,
  endedByPrincipalId: EndedByPrincipalIdSchema,
  provenance: Schema.Struct({
    evidenceReferences: Schema.Array(TrimmedTextSchema).check(Schema.isMaxLength(32)),
    method: ContactPointProvenanceSchema.fields.method,
    source: ContactPointProvenanceSchema.fields.source,
  }),
  reason: TrimmedTextSchema,
  recordedAt: ContactPointTimestampSchema,
});

const EmailContactPointValueSchema = Schema.Struct({
  displayValue: EmailValueSchema,
  lookupValue: EmailValueSchema,
  preferred: Schema.Boolean,
  type: Schema.Literal('EMAIL'),
});
const PhoneContactPointValueSchema = Schema.Struct({
  countryCode: Schema.Union([CountryCodeSchema, Schema.Null]),
  displayValue: PhoneValueSchema,
  extension: Schema.Union([TrimmedTextSchema, Schema.Null]),
  lookupValue: Schema.String.check(Schema.isPattern(/^\+[1-9][0-9]{6,14}$/u)),
  preferred: Schema.Boolean,
  type: Schema.Literal('PHONE'),
});
export const AddressContactPointValueSchema = Schema.Struct({
  address: Schema.Struct({
    addressLine1: Schema.Union([TrimmedTextSchema, Schema.Null]),
    addressLine2: Schema.Union([TrimmedTextSchema, Schema.Null]),
    city: Schema.Union([TrimmedTextSchema, Schema.Null]),
    countryCode: CountryCodeSchema,
    postalCode: Schema.Union([TrimmedTextSchema, Schema.Null]),
    region: Schema.Union([TrimmedTextSchema, Schema.Null]),
  }),
  purposes: Schema.Array(
    Schema.Struct({
      ...AddressPurposeAssignmentSchema.fields,
      current: Schema.Boolean,
      end: Schema.Union([ContactPointEndSchema, Schema.Null]),
      provenance: ContactPointProvenanceHistorySchema,
      recordedAt: ContactPointTimestampSchema,
      revision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
      state: ContactPointLifecycleStateSchema,
      validFrom: ContactPointTimestampSchema,
      validTo: Schema.Union([ContactPointTimestampSchema, Schema.Null]),
    }),
  ),
  type: Schema.Literal('ADDRESS'),
});
const ContactPointValueSchema = Schema.Union([
  EmailContactPointValueSchema,
  PhoneContactPointValueSchema,
  AddressContactPointValueSchema,
]);

export const PartyContactPointSchema = Schema.Struct({
  contactPointRef: PartyContactPointRefSchema,
  current: Schema.Boolean,
  end: Schema.Union([ContactPointEndSchema, Schema.Null]),
  partyRef: PartyRefSchema,
  privacyClassification: ContactPointPrivacyClassificationSchema,
  provenance: ContactPointProvenanceHistorySchema,
  recordedAt: ContactPointTimestampSchema,
  revision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  state: ContactPointLifecycleStateSchema,
  storedPartyRef: PartyRefSchema,
  validFrom: ContactPointTimestampSchema,
  validTo: Schema.Union([ContactPointTimestampSchema, Schema.Null]),
  value: ContactPointValueSchema,
});
export type PartyContactPoint = typeof PartyContactPointSchema.Type;
/**
 * A contact point as a read answers it: the value is a governed field class, so a caller without the
 * value capability receives the record without it (O17, O58).
 */
export const PartyContactPointViewSchema = Schema.Struct({
  ...PartyContactPointSchema.fields,
  value: Schema.optionalKey(ContactPointValueSchema),
});

export interface NormalizedChannel {
  readonly displayValue: string;
  readonly lookupValue: string;
}

export interface NormalizedPhone extends NormalizedChannel {
  readonly countryCode: null | string;
  readonly extension: null | string;
}

export interface NormalizedAddress {
  readonly addressLine1: null | string;
  readonly addressLine2: null | string;
  readonly city: null | string;
  readonly countryCode: string;
  readonly postalCode: null | string;
  readonly region: null | string;
}

const invalidContactPoint = (reason: string): never => {
  throw new PartyContactPointInvalid({
    code: 'party_contact_point_invalid',
    reason,
  });
};

export const normalizeEmail = (rawValue: string): NormalizedChannel => {
  const displayValue = rawValue.trim();
  const separator = displayValue.lastIndexOf('@');
  if (separator <= 0 || separator === displayValue.length - 1) {
    return invalidContactPoint('EMAIL must contain a mailbox and domain');
  }
  return {
    displayValue,
    lookupValue: `${displayValue.slice(0, separator)}@${displayValue.slice(separator + 1).toLowerCase()}`,
  };
};

/**
 * The one phone rule home is the published `contact-phone-normalization` contract; this owner
 * keeps its own error vocabulary around the shared answer, so Party's durable contact point and
 * every ingress canonicalize identically.
 */
export const normalizePhone = (rawValue: string, rawCountryCode?: string, rawExtension?: string): NormalizedPhone => {
  const normalization = normalizeContactPhone(rawValue, rawCountryCode, rawExtension);
  if (!normalization.ok) {
    return invalidContactPoint(normalization.reason);
  }
  return normalization.normalized;
};

const normalizedOptional = (value: string | undefined): null | string => value?.trim() || null;

export const normalizeAddress = (address: StructuredAddress): NormalizedAddress => {
  const normalized = {
    addressLine1: normalizedOptional(address.addressLine1),
    addressLine2: normalizedOptional(address.addressLine2),
    city: normalizedOptional(address.city),
    countryCode: address.countryCode.trim().toUpperCase(),
    postalCode: normalizedOptional(address.postalCode),
    region: normalizedOptional(address.region),
  };
  if (
    [normalized.addressLine1, normalized.addressLine2, normalized.city, normalized.postalCode].filter(
      (part) => part !== null,
    ).length < 2
  ) {
    return invalidContactPoint('ADDRESS must contain enough structure to identify a usable location');
  }
  return normalized;
};

type NormalizedContactPoint =
  | typeof EmailContactPointValueSchema.Type
  | typeof PhoneContactPointValueSchema.Type
  | Readonly<{
      address: NormalizedAddress;
      purposes: readonly AddressPurposeAssignment[];
      type: 'ADDRESS';
    }>;

export const normalizeContactPointInput = (input: ContactPointInput): NormalizedContactPoint =>
  Match.value(input).pipe(
    Match.discriminatorsExhaustive('type')({
      ADDRESS: (address) => ({
        address: normalizeAddress(address.address),
        purposes: address.purposes,
        type: 'ADDRESS' as const,
      }),
      EMAIL: (email) => ({
        ...normalizeEmail(email.value),
        preferred: email.preferred,
        type: 'EMAIL' as const,
      }),
      PHONE: (phone) => ({
        ...normalizePhone(phone.value, phone.countryCode, phone.extension),
        preferred: phone.preferred,
        type: 'PHONE' as const,
      }),
    }),
  );

export const normalizedAddressKey = (address: StructuredAddress): string => {
  const normalized = normalizeAddress(address);
  return [
    normalized.countryCode,
    normalized.region,
    normalized.city,
    normalized.postalCode,
    normalized.addressLine1,
    normalized.addressLine2,
  ]
    .map((part) => part?.toLocaleUpperCase('und') ?? '')
    .join('|');
};

const assertAddressPurposeAssignment = (
  assignment: AddressPurposeAssignment,
  provenance: ContactPointProvenance,
): void => {
  if (assignment.purpose === 'REGISTERED' && assignment.registryContext !== undefined) {
    const { jurisdiction, registryKey } = assignment.registryContext;
    if (registryKey !== 'ARES' || jurisdiction.toUpperCase() !== 'CZ') {
      return invalidContactPoint('The supported explicit REGISTERED registry context is ARES/CZ');
    }
    if (!provenance.authoritative || provenance.evidenceReference === undefined) {
      return invalidContactPoint('Explicit REGISTERED registry context requires authoritative provenance and evidence');
    }
  } else if (assignment.purpose !== 'REGISTERED' && assignment.registryContext !== undefined) {
    return invalidContactPoint('Registry context belongs only to REGISTERED purpose');
  }
};

export const assertAddressPurposeRules = (
  assignments: readonly AddressPurposeAssignment[],
  provenance: ContactPointProvenance,
): void => {
  const purposeKeys = assignments.map(({ purpose }) => purpose);
  if (new Set(purposeKeys).size !== purposeKeys.length) {
    return invalidContactPoint('ADDRESS purposes must be unique on one Contact Point');
  }
  for (const assignment of assignments) {
    assertAddressPurposeAssignment(assignment, provenance);
  }
};
