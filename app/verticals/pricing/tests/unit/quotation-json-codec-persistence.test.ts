import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import type { PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import { PgTypes } from '@effect/sql-pg';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Exit, Option, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { QuotationResultLookupResponseSchema } from '../../shared/apis/quotation-result-lookup.ts';
import {
  QuotationPersistenceUnavailable,
  quotationPersistenceForScope,
} from '../../src/services/quotation-persistence.service.ts';
import {
  issue788IssuedAt,
  makeIssue788CommercialTotal,
  makeIssue788MaterialEvidence,
  makeIssue788Quotation,
} from './support/issue-788-confirmation.fixture.ts';

const tenantId = '73800000-0000-4000-8000-000000000001';
const legalEntityId = '73800000-0000-4000-8000-000000000002';
const principalId = '73800000-0000-4000-8000-000000000003';
const actionInvocationId = '73800000-0000-4000-8000-000000000005';
const commandFingerprint = 'sha256:quotation-json-codec';
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '73800000-0000-4000-8000-000000000006',
    authContextRef: 'better-auth-session:pricing-quotation-codec',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'pricing-quotation-json-codec',
};

const tierObservedAtFixture = '2026-09-28T12:00:00.100Z';
const tierBoundaryFixture = '2026-10-01T00:00:00.000Z';
const tierObservedAtMilliseconds = '2026-09-28T12:00:00.123Z';
const tierObservedAtDate = DateTime.toDateUtc(DateTime.makeUnsafe(tierObservedAtMilliseconds));
const tierBoundaryDate = DateTime.toDateUtc(DateTime.makeUnsafe(tierBoundaryFixture));

const quotationCodec = Schema.toCodecJson(PricingQuotationIssuedSchema);
const encodeQuotation = Schema.encodeEffect(quotationCodec);
const decodeQuotation = Schema.decodeUnknownEffect(quotationCodec);
const sameQuotation = Schema.toEquivalence(PricingQuotationIssuedSchema);

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json);
const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRecordSchema));

/** What the jsonb column keeps: the Quotation after a trip through JSON text. */
const storedJson = Effect.fn('test.quotationStoredJson')(function* storedJsonOf(quotation: PricingQuotationIssued) {
  const text = yield* encodeQuotation(quotation).pipe(Effect.flatMap(encodeJsonText));
  return { record: yield* decodeJsonText(text), text };
});

/** A JSON value with optional non-JSON instants substituted in, for negative payloads. */
type Patched = Date | Schema.Json | readonly Patched[] | { readonly [key: string]: Patched };

/** Replaces every `observedAt` inside a retained Quantity Tier set, returning a fresh copy. */
const patchTierObservedAt = (value: Patched, replacement: Patched, path = ''): Patched => {
  if (Array.isArray(value)) {
    return value.map((item, index) => patchTierObservedAt(item, replacement, `${path}[${index}]`));
  }
  if (Predicate.isObject(value) && !Predicate.isDate(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'observedAt' && path.includes('.tierSet.')
          ? replacement
          : patchTierObservedAt(item, replacement, `${path}.${key}`),
      ]),
    );
  }
  return value;
};

const patchKey = (value: Patched, key: string, replacement: Patched): Patched => {
  if (Array.isArray(value)) {
    return value.map((item) => patchKey(item, key, replacement));
  }
  if (Predicate.isObject(value) && !Predicate.isDate(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, item]) => [
        entryKey,
        entryKey === key ? replacement : patchKey(item, key, replacement),
      ]),
    );
  }
  return value;
};

/** Every DateTime retained by the Quantity Tier sets inside the Quotation's original and evidenced results. */
const retainedTierInstants = (quotation: PricingQuotationIssued): readonly DateTime.DateTime[] =>
  [quotation.quotedResult, quotation.materialEvidence.sourceEvidence.commercialTotal]
    .flatMap((total) => total.sourceEvidence.preRound.lines)
    .flatMap(({ composition }) => {
      const { completenessEvidence } = composition.unitPriceCalculation.input.tierSelection.evidence.input.tierSet;
      return [completenessEvidence.observedAt, completenessEvidence.nextApplicabilityBoundary];
    })
    .filter(Predicate.isNotUndefined);

const makeQuotation = Effect.fn('test.quotationJsonCodecQuotation')(function* makeCodecQuotation() {
  const total = yield* makeIssue788CommercialTotal('900');
  return { quotation: makeIssue788Quotation(total), total };
});

const issuedWith = (quotation: PricingQuotationIssued, issuedAt: string, validatedAt: string) =>
  Schema.decodeUnknownEffect(PricingQuotationIssuedSchema)({
    ...quotation,
    issuedAt,
    materialEvidence: makeIssue788MaterialEvidence(quotation.quotedResult, validatedAt),
  });

describe('Pricing Quotation JSON codec', () => {
  it.effect('round-trips an issued Quotation through JSON text preserving DateTime instants to the millisecond', () =>
    Effect.gen(function* roundTripsQuotation() {
      const { quotation } = yield* makeQuotation();
      const originalInstants = retainedTierInstants(quotation);
      const encoded = yield* encodeQuotation(quotation);
      const { record, text } = yield* storedJson(quotation);
      const decoded = yield* decodeQuotation(record);
      const decodedInstants = retainedTierInstants(decoded);

      expect(originalInstants.length).toBeGreaterThan(0);
      expect(originalInstants.every(DateTime.isDateTime)).toBe(true);
      expect(Schema.is(Schema.Json)(quotation)).toBe(false);
      expect(Schema.is(Schema.Json)(encoded)).toBe(true);
      expect(text).toContain(`"observedAt":"${tierObservedAtFixture}"`);
      expect(text).toContain(`"nextApplicabilityBoundary":"${tierBoundaryFixture}"`);
      expect(decoded).toEqual(quotation);
      expect(sameQuotation(decoded, quotation)).toBe(true);
      expect(decodedInstants.every(DateTime.isDateTime)).toBe(true);
      expect(decodedInstants.map(DateTime.toEpochMillis)).toEqual(originalInstants.map(DateTime.toEpochMillis));
      expect(decodedInstants.map(DateTime.formatIso)).toContain(tierObservedAtFixture);
    }),
  );

  it.effect('preserves an arbitrary millisecond Tier observation instant through the JSON codec', () =>
    Effect.gen(function* preservesMilliseconds() {
      const { quotation } = yield* makeQuotation();
      const { record } = yield* storedJson(quotation);
      const shifted = patchTierObservedAt(record, tierObservedAtMilliseconds);
      const decoded = yield* decodeQuotation(shifted);
      const reencoded = yield* encodeQuotation(decoded).pipe(Effect.flatMap(encodeJsonText));
      const observedMilliseconds = retainedTierInstants(decoded).map(DateTime.toEpochMillis);

      expect(observedMilliseconds).toContain(Date.parse(tierObservedAtMilliseconds));
      expect(observedMilliseconds).not.toContain(Date.parse(tierObservedAtFixture));
      expect(reencoded).toBe(yield* encodeJsonText(shifted));
    }),
  );

  it.effect('is not decodable by the DateTime-typed schema without the JSON codec', () =>
    Effect.gen(function* requiresCodecForJson() {
      const { quotation } = yield* makeQuotation();
      const { record } = yield* storedJson(quotation);

      expect(Option.isNone(Schema.decodeUnknownOption(PricingQuotationIssuedSchema)(record))).toBe(true);
      expect(Option.isSome(Schema.decodeUnknownOption(quotationCodec)(record))).toBe(true);
    }),
  );

  it.effect('rejects Date objects and malformed instant strings where a JSON instant is required', () =>
    Effect.gen(function* rejectsBadInstants() {
      const { quotation } = yield* makeQuotation();
      const { record } = yield* storedJson(quotation);
      const dateFailure = yield* decodeQuotation(patchTierObservedAt(record, tierObservedAtDate)).pipe(Effect.flip);

      expect(String(dateFailure)).toContain('observedAt');
      for (const malformed of ['not-an-instant', '2026-13-45T00:00:00.000Z', '', 1_790_000_000_000, null]) {
        const failure = yield* decodeQuotation(patchTierObservedAt(record, malformed)).pipe(Effect.flip);
        expect(String(failure)).toContain('observedAt');
      }
      const boundaryFailure = yield* decodeQuotation(
        patchKey(record, 'nextApplicabilityBoundary', tierBoundaryDate),
      ).pipe(Effect.flip);
      expect(String(boundaryFailure)).toContain('nextApplicabilityBoundary');
    }),
  );

  it.effect('keeps issuedAt >= operation instant and validatedAt <= issuedAt through the codec', () =>
    Effect.gen(function* preservesIssuanceInstantRule() {
      const { quotation } = yield* makeQuotation();
      const { operationTime } = quotation.quotedResult.decision;
      const laterIssuance = '2026-09-28T12:00:01.250Z';
      const cases = [
        { issuedAt: operationTime, validatedAt: operationTime },
        { issuedAt: laterIssuance, validatedAt: laterIssuance },
        { issuedAt: laterIssuance, validatedAt: '2026-09-28T12:00:01.000Z' },
      ] as const;

      expect(operationTime).toBe(issue788IssuedAt);
      for (const { issuedAt, validatedAt } of cases) {
        const issued = yield* issuedWith(quotation, issuedAt, validatedAt);
        const { record } = yield* storedJson(issued);
        const decoded = yield* decodeQuotation(record);

        expect(decoded).toEqual(issued);
        expect(decoded.issuedAt).toBe(issuedAt);
        expect(decoded.materialEvidence.validatedAt).toBe(validatedAt);
        expect(decoded.issuedAt >= decoded.quotedResult.decision.operationTime).toBe(true);
        expect(decoded.materialEvidence.validatedAt <= decoded.issuedAt).toBe(true);
      }
    }),
  );

  it.effect('rejects a JSON Quotation issued before its evidence was validated', () =>
    Effect.gen(function* rejectsMisorderedInstants() {
      const { quotation } = yield* makeQuotation();
      const { record } = yield* storedJson(quotation);
      const beforeValidation = yield* decodeQuotation({ ...record, issuedAt: '2026-09-28T11:59:59.999Z' }).pipe(
        Effect.flip,
      );

      expect(String(beforeValidation)).toContain('cannot be validated after issuance');
    }),
  );
});

const invokeWith = (respond: (statement: SQL) => Effect.Effect<Schema.Json>) => {
  const statements: SQL[] = [];
  const transaction = scopedRoutineInvokerFromTransaction(
    (statement) => {
      statements.push(statement);
      return Effect.map(respond(statement), (payload) => [{ payload }]);
    },
    { legalEntityId, tenantId },
  );
  return { statements, transaction };
};

describe('Pricing Quotation persistence row shape', () => {
  const dialect = new PgDialect();
  const boundJsonb = (statement: SQL): Effect.Effect<Schema.Json> => {
    const parameter = dialect.sqlToQuery(statement).params.at(-1);
    return PgTypes.isParameter(parameter)
      ? Schema.decodeUnknownEffect(Schema.Json)(parameter.value).pipe(Effect.orDie)
      : Effect.die('Expected the Quotation payload to be bound as a jsonb parameter');
  };

  it.effect('stores the JSON-encoded Quotation as jsonb and decodes the stored row back to an equal Quotation', () =>
    Effect.gen(function* storesThroughCodec() {
      const { quotation } = yield* makeQuotation();
      let storedRow: Schema.Json = null;
      const { statements, transaction } = invokeWith((statement) =>
        boundJsonb(statement).pipe(
          Effect.tap((row) => Effect.sync(() => (storedRow = row))),
          Effect.map((row) => ({ outcome: 'STORED', quotation: row })),
        ),
      );
      const persistence = yield* quotationPersistenceForScope(transaction, scope);

      const stored = yield* persistence.store({ actionInvocationId, commandFingerprint, quotation });
      const queries = statements.map((statement) => dialect.sqlToQuery(statement));

      expect(queries).toHaveLength(1);
      expect(queries.at(0)?.sql).toContain('"pricing"."persist_pricing_quotation_v1"');
      expect(queries.at(0)?.params.slice(0, 5)).toEqual([
        tenantId,
        legalEntityId,
        principalId,
        actionInvocationId,
        commandFingerprint,
      ]);
      expect(yield* encodeJsonText(storedRow)).toContain(`"observedAt":"${tierObservedAtFixture}"`);
      expect(yield* decodeQuotation(storedRow)).toEqual(quotation);
      expect(sameQuotation(stored, quotation)).toBe(true);
      expect(retainedTierInstants(stored).map(DateTime.toEpochMillis)).toEqual(
        retainedTierInstants(quotation).map(DateTime.toEpochMillis),
      );
    }),
  );

  it.effect('reads and invocation-looks-up a stored row back into DateTime-bearing Quotations', () =>
    Effect.gen(function* readsStoredRow() {
      const { quotation } = yield* makeQuotation();
      const { record } = yield* storedJson(quotation);

      const read = invokeWith(() => Effect.succeed({ outcome: 'FOUND', quotation: record }));
      const found = yield* (yield* quotationPersistenceForScope(read.transaction, scope)).read(quotation.quotationRef);
      expect(Option.getOrUndefined(found)).toEqual(quotation);
      expect(retainedTierInstants(Option.getOrThrow(found)).every(DateTime.isDateTime)).toBe(true);

      const lookup = invokeWith(() =>
        Effect.succeed({ actionInvocationId, commandFingerprint, outcome: 'FOUND', quotation: record }),
      );
      const looked = yield* (yield* quotationPersistenceForScope(lookup.transaction, scope)).lookupInvocation(
        actionInvocationId,
      );
      expect(Option.getOrUndefined(looked)).toEqual({ commandFingerprint, quotation });
    }),
  );

  it.effect(
    'treats a stored row with a malformed instant or a changed term as unavailable, never as the Quotation',
    () =>
      Effect.gen(function* rejectsCorruptRows() {
        const { quotation, total } = yield* makeQuotation();
        const { record } = yield* storedJson(quotation);
        const other = yield* storedJson(makeIssue788Quotation(total, 'pricing-quotation:788:other'));
        const corruptInstant = patchTierObservedAt(record, 'not-an-instant');
        const store = { actionInvocationId, commandFingerprint, quotation };

        const corrupt = invokeWith(() =>
          Effect.succeed({ outcome: 'STORED', quotation: Schema.decodeUnknownSync(Schema.Json)(corruptInstant) }),
        );
        const corruptFailure = yield* (yield* quotationPersistenceForScope(corrupt.transaction, scope))
          .store(store)
          .pipe(Effect.flip);
        const changed = invokeWith(() => Effect.succeed({ outcome: 'STORED', quotation: other.record }));
        const changedFailure = yield* (yield* quotationPersistenceForScope(changed.transaction, scope))
          .store(store)
          .pipe(Effect.flip);

        expect(Schema.is(QuotationPersistenceUnavailable)(corruptFailure)).toBe(true);
        expect(Schema.is(QuotationPersistenceUnavailable)(changedFailure)).toBe(true);
        expect(corruptFailure).toHaveProperty('reason', 'Quotation routine returned an invalid result');
        expect(changedFailure).toHaveProperty(
          'reason',
          'Stored Quotation did not preserve the exact immutable issued terms',
        );
      }),
  );
});

describe('Pricing Quotation result lookup response schema', () => {
  const decodeResponse = Schema.decodeUnknownEffect(QuotationResultLookupResponseSchema, {
    onExcessProperty: 'error',
  });
  const encodeResponse = Schema.encodeEffect(QuotationResultLookupResponseSchema);

  it.effect('accepts the codec-encoded Quotation and decodes it to an equal DateTime-bearing Quotation', () =>
    Effect.gen(function* acceptsEncodedQuotation() {
      const { quotation } = yield* makeQuotation();
      const { record } = yield* storedJson(quotation);
      const wire = { actionInvocationId, outcome: 'QUOTATION_RESULT_FOUND', quotation: record };
      const decoded = yield* decodeResponse(wire);
      const reencoded = yield* encodeResponse(decoded).pipe(Effect.flatMap(encodeJsonText));

      expect(decoded).toMatchObject({ actionInvocationId, outcome: 'QUOTATION_RESULT_FOUND' });
      expect(decoded.outcome === 'QUOTATION_RESULT_FOUND' ? decoded.quotation : undefined).toEqual(quotation);
      expect(reencoded).toBe(yield* encodeJsonText(wire));
    }),
  );

  it.effect('rejects unknown or extra fields and a Quotation that is not in codec-encoded form', () =>
    Effect.gen(function* rejectsExtraFields() {
      const { quotation } = yield* makeQuotation();
      const { record } = yield* storedJson(quotation);
      const found = { actionInvocationId, outcome: 'QUOTATION_RESULT_FOUND', quotation: record };
      const rejected = [
        { ...found, unexpected: 'field' },
        { ...found, quotation: { ...record, unexpected: 'field' } },
        { ...found, outcome: 'QUOTATION_RESULT_UNKNOWN' },
        { ...found, quotation },
        { ...found, quotation: patchTierObservedAt(record, tierObservedAtDate) },
        { actionInvocationId, outcome: 'QUOTATION_RESULT_ABSENT', quotation: record },
      ];

      for (const candidate of rejected) {
        expect(Exit.isFailure(yield* decodeResponse(candidate).pipe(Effect.exit))).toBe(true);
      }
    }),
  );
});
