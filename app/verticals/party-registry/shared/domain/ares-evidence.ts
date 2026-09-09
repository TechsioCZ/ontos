import { DateTime, Option, Schema, SchemaGetter } from 'effect';

const boundedText = (maximumLength: number) =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximumLength));

const validDateOnly = Schema.makeFilter((value: string) => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = daysInMonth[month - 1];
  return maximumDay !== undefined && day >= 1 && day <= maximumDay
    ? undefined
    : 'date must be a valid calendar date in YYYY-MM-DD format';
});

export const AresSubjectLookupIcoSchema = Schema.Trim.check(Schema.isPattern(/^\d{8}$/u)).pipe(
  Schema.brand('AresSubjectLookupIco'),
);

export const AresDicSchema = Schema.Trim.check(Schema.isPattern(/^CZ\d{8,10}$/u), Schema.isMaxLength(12)).pipe(
  Schema.brand('AresDic'),
);
export const AresDateOnlySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u), validDateOnly),
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIsoDateUtc),
  }),
);
export const AresIsoTimestampSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
    Schema.makeFilter((value) => {
      const parsed = DateTime.make(value);
      const canonicalInput = value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
      return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === canonicalInput
        ? undefined
        : 'invalid UTC calendar timestamp';
    }),
  ),
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
  }),
);
export const AresLegalFormCodeSchema = Schema.Trim.check(Schema.isPattern(/^\d{1,10}$/u));

export const AresRegisteredAddressSchema = Schema.Struct({
  buildingNumber: Schema.OptionFromNullOr(boundedText(30)),
  countryCode: Schema.OptionFromNullOr(Schema.Trim.check(Schema.isPattern(/^[A-Z]{2}$/u))),
  formatted: Schema.OptionFromNullOr(boundedText(500)),
  municipality: Schema.OptionFromNullOr(boundedText(200)),
  municipalityPart: Schema.OptionFromNullOr(boundedText(200)),
  orientationNumber: Schema.OptionFromNullOr(boundedText(30)),
  postalCode: Schema.OptionFromNullOr(Schema.Trim.check(Schema.isPattern(/^\d{5}$/u))),
  street: Schema.OptionFromNullOr(boundedText(200)),
});
export type AresRegisteredAddress = typeof AresRegisteredAddressSchema.Type;

const AresSubjectObservationSchema = Schema.Struct({
  businessName: Schema.OptionFromNullOr(boundedText(500)),
  dic: Schema.OptionFromNullOr(AresDicSchema),
  dissolvedOn: Schema.OptionFromNullOr(AresDateOnlySchema),
  establishedOn: Schema.OptionFromNullOr(AresDateOnlySchema),
  ico: AresSubjectLookupIcoSchema,
  legalFormCode: Schema.OptionFromNullOr(AresLegalFormCodeSchema),
  registeredAddress: Schema.OptionFromNullOr(AresRegisteredAddressSchema),
});

export const AresSubjectEvidenceSchema = Schema.Struct({
  cacheAgeSeconds: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  observedAt: AresIsoTimestampSchema,
  provider: Schema.Literal('ares'),
  providerChangedOn: Schema.OptionFromNullOr(AresDateOnlySchema),
  providerRecordRef: Schema.OptionFromNullOr(boundedText(200)),
  queryIco: AresSubjectLookupIcoSchema,
  servedAt: AresIsoTimestampSchema,
  status: Schema.Literal('FOUND'),
  subject: AresSubjectObservationSchema,
}).check(
  Schema.makeFilter((evidence) =>
    DateTime.Order(evidence.servedAt, evidence.observedAt) >= 0
      ? undefined
      : [{ issue: 'servedAt must not precede observedAt', path: ['servedAt'] }],
  ),
);
export type AresSubjectEvidence = typeof AresSubjectEvidenceSchema.Type;
