#!/usr/bin/env node
import { NodeRuntime } from '@effect/platform-node';
import {
  ActionAuthorizationPreflightDatabase,
  ActionAuthorizationPreflightDatabaseLive,
  CorePersistenceLive,
  DatabaseConfig,
  parseDatabaseConnectionPair,
  scopedRoutineInvokerFromTransaction,
} from '@app/core-runtime';
import type { ActionAuthorizationPreflightDatabaseService } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Cause, Config, Console, Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { CoreDatabase } from '../../../packages/core-runtime/src/db/client.ts';
import type { CoreTransaction } from '../../../packages/core-runtime/src/db/types.ts';
import type { ClaimEnrollmentTransitionInput } from '../shared/enrollment-contracts.ts';
import { ReadEnrollmentOwnerOperationInputSchema } from '../shared/enrollment-contracts.ts';
import {
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
} from '../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  resolveRetailOwnerCommand,
  retailCustomerProfileActionExecutor,
} from '../src/enrollment/journeys/retail-self-enrollment-profile-owners.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  commerceEnrollmentOwnerAttemptStoreForRun,
} from '../src/enrollment/orchestration/owner-transition-production.ts';

import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../src/enrollment/orchestration/owner-transaction-runner.ts';
import { readRetailProfileByParty } from '../src/persistence/profile-persistence.ts';
import { attemptUnavailable } from '../src/enrollment/attempts/errors.ts';
import {
  AdmittedRetailProfileRecoveryError,
  AdmittedRetailProfileRecoveryRuntime,
  RecoveryCoreEvidenceSchema,
  RecoveryModeSchema,
  RecoveryReportSchema,
  RecoveryReasonSchema,
  RecoveryRequestSchema,
  RecoverySourceRevisionSchema,
  claimApprovedRetailProfileFence,
  recoverAdmittedRetailProfile,
  withRetailProfileRecoveryDeadline,
} from './recover-admitted-retail-profile-program.mts';
import type { RecoveryObservation, RecoveryRequest } from './recover-admitted-retail-profile-program.mts';

const unavailable = () => new AdmittedRetailProfileRecoveryError({ reason: 'evidence-unavailable' });
const configurationInvalid = () => new AdmittedRetailProfileRecoveryError({ reason: 'configuration-invalid' });

/** Transaction READ ONLY also enforces the check contract inside native SELECT routines. */
const readOnlyDatabase = (
  database: ActionAuthorizationPreflightDatabaseService,
): ActionAuthorizationPreflightDatabaseService => ({
  transaction: (body) =>
    database.transaction((transaction) =>
      transaction.execute(sql`set transaction read only`, 'objects').pipe(Effect.andThen(body(transaction))),
    ),
});

/** A typed failure stays inside the real Drizzle transaction so it rolls back native fencing. */
export const claimRetailProfileWithAtomicApproval = Effect.fn('RetailProfileRecovery.atomicClaim')(
  function* claimRetailProfileWithAtomicApproval(
    transaction: CoreTransaction,
    observation: RecoveryObservation,
    input: ClaimEnrollmentTransitionInput,
  ) {
    const scope = { legalEntityId: observation.attempt.targetLegalEntityId, tenantId: observation.attempt.tenantId };
    yield* transaction.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended('ontos.application-composition-authority', 0))`,
      'objects',
    );
    const [authority] = yield* transaction.execute<{ readonly approved: boolean }>(
      sql`select exists (
      select 1 from core.application_composition_authority
      where authority_key = 'active' and revision = ${observation.attempt.compositionRevision}
        and phase = 'active' and durable_work_admission = 'closed' and valid_until > clock_timestamp()
    ) as approved`,
      'objects',
    );
    if (!authority?.approved) {
      return yield* attemptUnavailable('The exact approved owner fence authority is unavailable');
    }
    yield* transaction.execute(
      sql`select set_config('ontos.tenant_id', ${scope.tenantId}, true),
      set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true)`,
      'objects',
    );
    const invoker = scopedRoutineInvokerFromTransaction(
      (statement) => transaction.execute(statement, 'objects'),
      scope,
    );
    const store = commerceEnrollmentOwnerAttemptStoreForRun(scope, (_scope, body) => body(invoker));
    return yield* claimApprovedRetailProfileFence(observation, input, store);
  },
);

const makeRetailProfileRecoveryRuntime = Effect.fn('RetailProfileRecovery.makeRuntime')(
  function* makeRetailProfileRecoveryRuntime(mode: typeof RecoveryModeSchema.Type) {
    // Explicit config parsing never invokes the dotenv-aware default database layer.
    const urls = yield* Config.all({
      DATABASE_ADMIN_URL: Config.Redacted('DATABASE_ADMIN_URL'),
      DATABASE_URL: Config.Redacted('DATABASE_URL'),
    }).pipe(Effect.mapError(configurationInvalid));
    const pair = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(urls.DATABASE_ADMIN_URL),
      DATABASE_URL: Redacted.value(urls.DATABASE_URL),
    }).pipe(Effect.mapError(configurationInvalid));
    if (
      pair.runtime.user !== 'ontos_runtime' ||
      pair.runtime.host !== pair.admin.host ||
      pair.runtime.port !== pair.admin.port ||
      pair.runtime.database !== pair.admin.database
    ) {
      return yield* configurationInvalid();
    }
    const databaseContext = yield* Layer.build(
      ActionAuthorizationPreflightDatabaseLive.pipe(
        Layer.provideMerge(CorePersistenceLive),
        Layer.provide(Layer.succeed(DatabaseConfig, pair.runtime)),
      ),
    ).pipe(Effect.mapError(unavailable));
    const database = Context.get(databaseContext, ActionAuthorizationPreflightDatabase);
    const coreDatabase = Context.get(databaseContext, CoreDatabase);
    const readDatabase = readOnlyDatabase(database);
    const runnerContext = yield* Layer.build(
      CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
        Layer.provide(Layer.succeed(ActionAuthorizationPreflightDatabase, mode === 'check' ? readDatabase : database)),
      ),
    ).pipe(Effect.mapError(unavailable));
    const runner = Context.get(runnerContext, CommerceEnrollmentOwnerTransactionRunner);
    const readRunnerContext = yield* Layer.build(
      CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
        Layer.provide(Layer.succeed(ActionAuthorizationPreflightDatabase, readDatabase)),
      ),
    ).pipe(Effect.mapError(unavailable));
    const readRunner = Context.get(readRunnerContext, CommerceEnrollmentOwnerTransactionRunner);
    const observe = Effect.fn('RetailProfileRecovery.observe')(function* observe(request: RecoveryRequest) {
      const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId: request.tenantId }, readRunner.run);
      const attempt = yield* store
        .read({ portalEnrollmentAttemptId: request.attemptId, tenantId: request.tenantId })
        .pipe(Effect.mapError(unavailable));
      const readOperation = (ownerModuleKey: string, transitionKey: string) =>
        Schema.decodeUnknownEffect(ReadEnrollmentOwnerOperationInputSchema)({
          ownerModuleKey,
          portalEnrollmentAttemptId: request.attemptId,
          tenantId: request.tenantId,
          transitionKey,
        }).pipe(Effect.flatMap(store.readOwnerOperation), Effect.mapError(unavailable));
      const operation = yield* readOperation(
        COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
        ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
      );
      const partyOperation = yield* readOperation(
        PARTY_REGISTRY_OWNER_MODULE_KEY,
        PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
      );
      const rows = yield* readDatabase
        .transaction((transaction) =>
          transaction.execute(
            sql`select
              authority.revision as "authorityRevision",
              authority.phase = 'active' as "authorityActive",
              authority.durable_work_admission = 'closed' as "admissionClosed",
              authority.valid_until > clock_timestamp() as "authorityFresh",
              receipt.action_invocation_id as "receiptId",
              receipt.tenant_id as "receiptTenantId",
              receipt.legal_entity_id as "receiptLegalEntityId",
              receipt.principal_id as "receiptPrincipalId",
              receipt.auth_method as "receiptAuthMethod",
              receipt.action_key as "receiptActionKey",
              receipt.idempotency_key as "receiptIdempotencyKey",
              receipt.request_hash as "receiptRequestHash",
              receipt.status as "receiptStatus",
              receipt.completed_at is not null as "receiptCompleted",
              exists (
                select 1 from core.application_composition_durable_work work
                where work.owner_module_key = 'commerce.customer-context'
                  and work.original_revision = ${request.compositionRevision}
                  and work.work_id = ${`enrollment-operation:${request.tenantId}:${request.attemptId}:${request.ownerInvocationId}`}
              ) as "durablePresent"
              from core.application_composition_authority authority
              cross join core.action_invocations receipt
              where authority.authority_key = 'active'
                and receipt.action_invocation_id = ${request.receiptId}::uuid`,
            'objects',
          ),
        )
        .pipe(Effect.mapError(unavailable));
      const [core] = yield* Schema.decodeUnknownEffect(Schema.Tuple([RecoveryCoreEvidenceSchema]))(rows).pipe(
        Effect.mapError(unavailable),
      );
      if (
        core === undefined ||
        attempt.targetLegalEntityId === undefined ||
        partyOperation.resultReference === undefined
      ) {
        return yield* unavailable();
      }
      const profile = yield* readRunner
        .run({ legalEntityId: attempt.targetLegalEntityId, tenantId: request.tenantId }, (transaction) =>
          readRetailProfileByParty(transaction, partyOperation.resultReference ?? '').pipe(
            Effect.mapError((error) => attemptUnavailable(error.reason, request.attemptId, error)),
          ),
        )
        .pipe(Effect.mapError(unavailable));
      return { attempt, core, operation, partyOperation, profile } satisfies RecoveryObservation;
    });
    return {
      executeProfile: retailCustomerProfileActionExecutor,
      observe,
      resolveCommand: resolveRetailOwnerCommand,
      run: runner.run,
      store: (observation: RecoveryObservation) => {
        const scope = {
          legalEntityId: observation.attempt.targetLegalEntityId,
          tenantId: observation.attempt.tenantId,
        };
        const store = commerceEnrollmentOwnerAttemptStoreForRun(scope, runner.run);
        return {
          ...store,
          claimTransition: (input) =>
            coreDatabase.executor
              .transaction((transaction) => claimRetailProfileWithAtomicApproval(transaction, observation, input))
              .pipe(Effect.mapError(() => attemptUnavailable('The exact approved owner fence did not commit'))),
        };
      },
    } satisfies typeof AdmittedRetailProfileRecoveryRuntime.Service;
  },
);

export const runRetailProfileRecoveryCommand = Effect.gen(function* runRetailProfileRecoveryCommand() {
  const configuration = yield* Config.all({
    approval: Config.option(Config.String('ONTOS_STAGE_PROFILE_RECOVERY_APPROVAL_SHA256')),
    environment: Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    mode: Config.schema(RecoveryModeSchema, 'ONTOS_STAGE_PROFILE_RECOVERY_MODE').pipe(Config.withDefault('check')),
    request: Config.schema(Schema.fromJsonString(RecoveryRequestSchema), 'ONTOS_STAGE_PROFILE_RECOVERY_REQUEST_JSON'),
    sourceRevision: Config.schema(RecoverySourceRevisionSchema, 'ONTOS_STAGE_PROFILE_RECOVERY_SOURCE_REVISION'),
  }).pipe(Effect.mapError(configurationInvalid));
  if (configuration.environment !== 'stage') {
    return yield* configurationInvalid();
  }
  return yield* recoverAdmittedRetailProfile({
    approvalSha256: Option.getOrUndefined(configuration.approval),
    mode: configuration.mode,
    request: configuration.request,
    sourceRevision: configuration.sourceRevision,
  });
});

const failureReportSchema = Schema.fromJsonString(
  Schema.Struct({
    reason: RecoveryReasonSchema,
    schemaVersion: Schema.Literal(1),
    status: Schema.Literals(['blocked', 'unknown']),
  }),
);
const configuredMode = Config.schema(RecoveryModeSchema, 'ONTOS_STAGE_PROFILE_RECOVERY_MODE').pipe(
  Config.withDefault('check'),
);
const runtimeLayer = Layer.effect(
  AdmittedRetailProfileRecoveryRuntime,
  configuredMode.pipe(Effect.flatMap(makeRetailProfileRecoveryRuntime)),
);

if (import.meta.main) {
  const program = configuredMode.pipe(
    Effect.mapError(configurationInvalid),
    Effect.flatMap((mode) =>
      withRetailProfileRecoveryDeadline(
        Effect.scoped(
          Layer.build(
            Layer.effectDiscard(
              runRetailProfileRecoveryCommand.pipe(
                Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(RecoveryReportSchema))),
                Effect.flatMap(Console.log),
              ),
            ).pipe(Layer.provide(runtimeLayer), Layer.provide(FetchHttpClient.layer)),
          ),
        ),
        mode,
      ),
    ),
  );
  NodeRuntime.runMain(
    program.pipe(
      Effect.catchCause((cause) => {
        const observed = Cause.findErrorOption(cause);
        const failure =
          Option.isSome(observed) && Schema.is(AdmittedRetailProfileRecoveryError)(observed.value)
            ? observed.value
            : new AdmittedRetailProfileRecoveryError({ reason: 'unknown' });
        return Schema.encodeEffect(failureReportSchema)({
          reason: failure.reason,
          schemaVersion: 1,
          status: failure.reason === 'unknown' || failure.reason === 'timeout' ? 'unknown' : 'blocked',
        }).pipe(Effect.flatMap(Console.log), Effect.andThen(Effect.fail(failure)));
      }),
    ),
    { disableErrorReporting: true },
  );
}
