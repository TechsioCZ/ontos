import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import type {
  CurrentSupportedCurrenciesRequest,
  PricingCurrencySubject,
} from '@app/pricing-contracts/current-supported-currencies';
import { Effect, Option, Schema } from 'effect';

const StoredCurrencySupportSchema = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  nextApplicabilityBoundary: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  observedAt: Schema.DateTimeUtcFromString,
  pricingRevision: Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()),
  supportedCurrencies: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u))).check(
    Schema.isMinLength(1),
    Schema.makeFilter((codes) =>
      new Set(codes).size === codes.length ? undefined : 'Stored currencies must be unique',
    ),
  ),
});
const StoredCurrencySupportRowSchema = Schema.Struct({ result: StoredCurrencySupportSchema });
const readCurrentSupportedCurrenciesRoutine = defineScopedRoutine({
  name: 'read_current_supported_currencies',
  ownerModuleKey: 'commerce.pricing',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: StoredCurrencySupportRowSchema,
  routineKey: 'pricing.read-current-supported-currencies',
  schema: 'pricing',
});
const SetCurrencySupportResultSchema = Schema.Struct({
  actualGeneration: Schema.Int,
  changed: Schema.Boolean,
  outcome: Schema.Literals(['APPLIED', 'EFFECTIVE_TIME_CONFLICT', 'REVISION_CONFLICT', 'UNCHANGED']),
  pricingRevision: Schema.OptionFromNullOr(Schema.String),
  supportedCurrencies: Schema.Array(Schema.String),
});
const setSupportedCurrenciesRoutine = defineScopedRoutine({
  name: 'set_supported_currencies',
  ownerModuleKey: 'commerce.pricing',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ result: SetCurrencySupportResultSchema }),
  routineKey: 'pricing.set-supported-currencies',
  schema: 'pricing',
});

const StoredCurrencySupportDomainSchema = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  nextApplicabilityBoundary: Schema.optionalKey(Schema.DateTimeUtc),
  observedAt: Schema.DateTimeUtc,
  pricingRevision: Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()),
  supportedCurrencies: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u))),
});
export type StoredCurrencySupport = typeof StoredCurrencySupportDomainSchema.Type;
export interface CurrencySupportPersistence {
  readonly loadCurrent: (
    input: CurrentSupportedCurrenciesRequest,
  ) => Effect.Effect<Option.Option<StoredCurrencySupport>, CurrencySupportPersistenceUnavailable>;
  readonly setCurrent: (
    command: SetCurrencySupportCommand,
  ) => Effect.Effect<SetCurrencySupportOutcome, CurrencySupportPersistenceUnavailable>;
}
export interface SetCurrencySupportCommand {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
  readonly cartId: string;
  readonly channelId: string;
  readonly contextRevision: string;
  readonly effectiveFrom: string;
  readonly expectedGeneration: number;
  readonly marketId: string;
  readonly reason: string;
  readonly storefrontId: string;
  readonly subject: PricingCurrencySubject;
  readonly supportedCurrencies: readonly string[];
}
const SetCurrencySupportDomainResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  generation: Schema.Int,
  pricingRevision: Schema.String,
  supportedCurrencies: Schema.Array(Schema.String),
});
const SetCurrencySupportOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('applied', { result: SetCurrencySupportDomainResultSchema }),
  Schema.TaggedStruct('unchanged', { result: SetCurrencySupportDomainResultSchema }),
  Schema.TaggedStruct('revision_conflict', {
    actualGeneration: Schema.Int,
    expectedGeneration: Schema.Int,
  }),
  Schema.TaggedStruct('effective_time_conflict', {}),
]);
export type SetCurrencySupportOutcome = typeof SetCurrencySupportOutcomeSchema.Type;

export class CurrencySupportPersistenceUnavailable extends Schema.TaggedError<CurrencySupportPersistenceUnavailable>()(
  'CurrencySupportPersistenceUnavailable',
  { reason: Schema.String },
) {}
const unavailable = (cause: unknown) => {
  const error = new CurrencySupportPersistenceUnavailable({ reason: 'Pricing currency support could not be verified' });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

const decodeSetCurrencySupportOutcome = (
  value: typeof SetCurrencySupportResultSchema.Type | undefined,
  expectedGeneration: number,
): Effect.Effect<SetCurrencySupportOutcome, CurrencySupportPersistenceUnavailable> => {
  if (value === undefined) {
    return Effect.fail(unavailable('Pricing write routine returned no outcome'));
  }
  if (value.outcome === 'REVISION_CONFLICT') {
    return Effect.succeed({
      _tag: 'revision_conflict',
      actualGeneration: value.actualGeneration,
      expectedGeneration,
    });
  }
  if (value.outcome === 'EFFECTIVE_TIME_CONFLICT') {
    return Effect.succeed({ _tag: 'effective_time_conflict' });
  }
  if (Option.isNone(value.pricingRevision)) {
    return Effect.fail(unavailable('Pricing write routine omitted its revision'));
  }
  const result = {
    changed: value.changed,
    generation: value.actualGeneration,
    pricingRevision: value.pricingRevision.value,
    supportedCurrencies: value.supportedCurrencies,
  };
  if (value.outcome === 'APPLIED') {
    return Effect.succeed({ _tag: 'applied', result });
  }
  return Effect.succeed({ _tag: 'unchanged', result });
};
const subjectFingerprint = (subject: CurrentSupportedCurrenciesRequest['subject']) => {
  if (subject.kind === 'GUEST') {
    return `GUEST:${subject.guestSessionRef}:${subject.guestEvidenceRef}`;
  }
  if (subject.authorizationSubject.kind === 'RETAIL') {
    return `PROFILE:RETAIL:${subject.profileRef.resourceId}`;
  }
  return `PROFILE:COUNTERPARTY:${subject.profileRef.resourceId}:${subject.authorizationSubject.counterpartyRef.resourceId}`;
};

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const persistenceForTransaction = (
  transaction: ScopedTransaction,
  _scope: Pick<OperationalScope, 'tenantId' | 'legalEntityId'>,
): CurrencySupportPersistence => ({
  loadCurrent: (input) =>
    transaction
      .invoke(readCurrentSupportedCurrenciesRoutine, [
        {
          cartId: input.cartId,
          channelId: input.channelId,
          contextRevision: input.contextRevision,
          effectiveAt: input.effectiveAt,
          marketId: input.marketId,
          storefrontId: input.storefrontId,
          subjectFingerprint: subjectFingerprint(input.subject),
        },
      ])
      .pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.map(([row]) => {
          if (row === undefined) {
            return Option.none<StoredCurrencySupport>();
          }
          const stored = {
            generation: row.result.generation,
            observedAt: row.result.observedAt,
            pricingRevision: row.result.pricingRevision,
            supportedCurrencies: row.result.supportedCurrencies,
          };
          return Option.some(
            Option.match(row.result.nextApplicabilityBoundary, {
              onNone: () => stored,
              onSome: (boundary) => ({ ...stored, nextApplicabilityBoundary: boundary }),
            }),
          );
        }),
      ),
  setCurrent: (command) =>
    transaction
      .invoke(setSupportedCurrenciesRoutine, [
        {
          ...command,
          subjectFingerprint: subjectFingerprint(command.subject),
        },
      ])
      .pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap(([row]) => decodeSetCurrencySupportOutcome(row?.result, command.expectedGeneration)),
      ),
});
export const currencySupportPersistenceForScope: ReadServiceFactory<CurrencySupportPersistence> = (
  transaction,
  scope,
) => Effect.succeed(persistenceForTransaction(transaction, scope));
