import type { ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { defineScopedRoutine } from '@app/core-runtime';
import type {
  RegisterStorefrontApplicationPayload,
  ReviseStorefrontApplicationPayload,
} from '../../shared/action-contracts.ts';
import { StorefrontApplicationResourceIdSchema } from '../../shared/resources/storefront-application.ts';
import { Effect, Schema } from 'effect';

const positiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const uuid = Schema.String.check(Schema.isUUID());
const ActionInvocationIdSchema = uuid.pipe(Schema.brand('StorefrontActionInvocationId'), Schema.decodeTo(uuid));
const PrincipalIdSchema = uuid.pipe(Schema.brand('StorefrontPrincipalId'), Schema.decodeTo(uuid));

const ConflictOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('application_already_registered', {}),
  Schema.TaggedStruct('application_not_found', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: positiveRevision }),
  Schema.TaggedStruct('retired_lifecycle_terminal', {}),
]);
const RegisterOutcomeSchema = Schema.Union([
  ConflictOutcomeSchema,
  Schema.TaggedStruct('created', {
    changed: Schema.Literal(true),
    generation,
    revision: Schema.Literal(1),
    storefrontApplicationId: StorefrontApplicationResourceIdSchema,
  }),
  Schema.TaggedStruct('reused', {
    changed: Schema.Literal(false),
    generation,
    revision: Schema.Literal(1),
    storefrontApplicationId: StorefrontApplicationResourceIdSchema,
  }),
]);
const ReviseOutcomeSchema = Schema.Union([
  ConflictOutcomeSchema,
  Schema.TaggedStruct('revised', {
    changed: Schema.Literal(true),
    generation,
    previousRevision: positiveRevision,
    revision: positiveRevision,
    storefrontApplicationId: StorefrontApplicationResourceIdSchema,
  }),
  Schema.TaggedStruct('reused', {
    changed: Schema.Literal(false),
    generation,
    previousRevision: positiveRevision,
    revision: positiveRevision,
    storefrontApplicationId: StorefrontApplicationResourceIdSchema,
  }),
]);

const MutationRowSchema = Schema.Struct({ payload: Schema.Unknown });
const parameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'input', type: 'jsonb' },
] as const;
const registerRoutine = defineScopedRoutine({
  name: 'register_storefront_application',
  ownerModuleKey: 'commerce.storefront-registry',
  parameters,
  resultSchema: MutationRowSchema,
  routineKey: 'storefront-administration.register',
  schema: 'storefront_registry',
});
const reviseRoutine = defineScopedRoutine({
  name: 'revise_storefront_application',
  ownerModuleKey: 'commerce.storefront-registry',
  parameters,
  resultSchema: MutationRowSchema,
  routineKey: 'storefront-administration.revise',
  schema: 'storefront_registry',
});

export class StorefrontAdministrationPersistenceUnavailable extends Schema.TaggedError<StorefrontAdministrationPersistenceUnavailable>()(
  'StorefrontAdministrationPersistenceUnavailable',
  {
    code: Schema.Literal('storefront_administration_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

const CommandContextSchema = Schema.Struct({
  actionInvocationId: ActionInvocationIdSchema,
  principalId: PrincipalIdSchema,
  recordedAt: Schema.toEncoded(Schema.DateTimeUtcFromString),
});
type CommandContext = typeof CommandContextSchema.Type;
type RegisterCommand = RegisterStorefrontApplicationPayload & CommandContext;
type ReviseCommand = ReviseStorefrontApplicationPayload & CommandContext;
type RegisterStorefrontApplicationOutcome = typeof RegisterOutcomeSchema.Type;
type ReviseStorefrontApplicationOutcome = typeof ReviseOutcomeSchema.Type;

export interface StorefrontAdministrationPersistence {
  readonly register: (
    command: RegisterCommand,
  ) => Effect.Effect<RegisterStorefrontApplicationOutcome, StorefrontAdministrationPersistenceUnavailable>;
  readonly revise: (
    command: ReviseCommand,
  ) => Effect.Effect<ReviseStorefrontApplicationOutcome, StorefrontAdministrationPersistenceUnavailable>;
}

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const unavailable = (cause: unknown): StorefrontAdministrationPersistenceUnavailable => {
  const failure = new StorefrontAdministrationPersistenceUnavailable({
    code: 'storefront_administration_persistence_unavailable',
    reason: 'Storefront administration persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const invoke = <A, I extends object>(
  transaction: ScopedTransaction,
  routine: typeof registerRoutine,
  input: I,
  schema: Schema.Decoder<A>,
): Effect.Effect<A, StorefrontAdministrationPersistenceUnavailable> =>
  transaction.invoke(routine, [input]).pipe(
    Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
    Effect.flatMap(([row]) =>
      row === undefined
        ? Effect.fail(unavailable(`The ${routine.routineKey} routine returned no outcome`))
        : Schema.decodeUnknownEffect(schema)(row.payload).pipe(Effect.mapError(unavailable)),
    ),
  );

const forTransaction = (transaction: ScopedTransaction): StorefrontAdministrationPersistence => ({
  register: (command) => invoke(transaction, registerRoutine, command, RegisterOutcomeSchema),
  revise: (command) => invoke(transaction, reviseRoutine, command, ReviseOutcomeSchema),
});

export const storefrontAdministrationPersistenceForScope: ReadServiceFactory<StorefrontAdministrationPersistence> = (
  transaction,
) => Effect.succeed(forTransaction(transaction));
