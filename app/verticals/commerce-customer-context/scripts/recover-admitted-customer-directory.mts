#!/usr/bin/env node
import { NodeRuntime } from '@effect/platform-node';
import {
  ActionAuthorizationPreflightDatabase,
  ActionAuthorizationPreflightDatabaseLive,
  CorePersistenceLive,
  DatabaseConfig,
  parseDatabaseConnectionPair,
} from '@app/core-runtime';
import type { ActionAuthorizationPreflightDatabaseService } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Cause, Config, Console, Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { CoreDatabase } from '../../../packages/core-runtime/src/db/client.ts';
import { ReadEnrollmentOwnerOperationInputSchema } from '../shared/enrollment-contracts.ts';
import { attemptUnavailable } from '../src/enrollment/attempts/errors.ts';
import { readRetailEnrollmentRegistration } from '../src/enrollment/attempts/registration-persistence.ts';
import {
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  RETAIL_CUSTOMER_DIRECTORY_TRANSITION_KEY,
} from '../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  commerceEnrollmentOwnerAttemptStoreForRun,
} from '../src/enrollment/orchestration/owner-transition-production.ts';
import { CommerceEnrollmentOwnerTransactionRunnerLive } from '../src/enrollment/orchestration/owner-transaction-runner.ts';
import {
  AdmittedCustomerDirectoryRecoveryError,
  AdmittedCustomerDirectoryRecoveryRuntime,
  DirectoryRecoveryCoreEvidenceSchema,
  DirectoryRecoveryReasonSchema,
  DirectoryRecoveryReportSchema,
  DirectoryRecoveryRequestSchema,
  recoverAdmittedCustomerDirectory,
  withCustomerDirectoryRecoveryDeadline,
} from './recover-admitted-customer-directory-program.mts';
import type { DirectoryRecoveryRequest } from './recover-admitted-customer-directory-program.mts';
import { RecoveryModeSchema, RecoverySourceRevisionSchema } from './recover-admitted-retail-profile-program.mts';
import { claimRetailProfileWithAtomicApproval } from './recover-admitted-retail-profile.mts';

const unavailable = () => new AdmittedCustomerDirectoryRecoveryError({ reason: 'evidence-unavailable' });
const configurationInvalid = () => new AdmittedCustomerDirectoryRecoveryError({ reason: 'configuration-invalid' });

/** Transaction READ ONLY also enforces the check contract inside native SELECT routines. */
const readOnlyDatabase = (
  database: ActionAuthorizationPreflightDatabaseService,
): ActionAuthorizationPreflightDatabaseService => ({
  transaction: (body) =>
    database.transaction((transaction) =>
      transaction.execute(sql`set transaction read only`, 'objects').pipe(Effect.andThen(body(transaction))),
    ),
});

const makeCustomerDirectoryRecoveryRuntime = Effect.fn('CustomerDirectoryRecovery.makeRuntime')(
  function* makeCustomerDirectoryRecoveryRuntime(mode: typeof RecoveryModeSchema.Type) {
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
    const runnerFor = (preflight: ActionAuthorizationPreflightDatabaseService) =>
      Layer.build(
        CommerceEnrollmentOwnerTransactionRunnerLive.pipe(
          Layer.provide(Layer.succeed(ActionAuthorizationPreflightDatabase, preflight)),
        ),
      ).pipe(
        Effect.mapError(unavailable),
        Effect.map((context) => Context.get(context, CommerceEnrollmentOwnerTransactionRunner)),
      );
    const runner = yield* runnerFor(mode === 'check' ? readDatabase : database);
    const readRunner = yield* runnerFor(readDatabase);
    const observe = Effect.fn('CustomerDirectoryRecovery.observe')(function* observe(
      request: DirectoryRecoveryRequest,
    ) {
      const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId: request.tenantId }, readRunner.run);
      const attempt = yield* store
        .read({ portalEnrollmentAttemptId: request.attemptId, tenantId: request.tenantId })
        .pipe(Effect.mapError(unavailable));
      const readOperation = (transitionKey: string) =>
        Schema.decodeUnknownEffect(ReadEnrollmentOwnerOperationInputSchema)({
          ownerModuleKey: PARTY_REGISTRY_OWNER_MODULE_KEY,
          portalEnrollmentAttemptId: request.attemptId,
          tenantId: request.tenantId,
          transitionKey,
        }).pipe(Effect.flatMap(store.readOwnerOperation), Effect.mapError(unavailable));
      const operation = yield* readOperation(RETAIL_CUSTOMER_DIRECTORY_TRANSITION_KEY);
      const partyOperation = yield* readOperation(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY);
      const rows = yield* readDatabase
        .transaction((transaction) =>
          transaction.execute(
            sql`select
              authority.revision as "authorityRevision",
              authority.phase = 'active' as "authorityActive",
              authority.durable_work_admission = 'closed' as "admissionClosed",
              authority.valid_until > clock_timestamp() as "authorityFresh",
              exists (
                select 1 from core.application_composition_durable_work work
                where work.owner_module_key = 'commerce.customer-context'
                  and work.original_revision = ${request.compositionRevision}
                  and work.work_id = ${`enrollment-operation:${request.tenantId}:${request.attemptId}:${request.ownerInvocationId}`}
              ) as "durablePresent"
              from core.application_composition_authority authority
              where authority.authority_key = 'active'`,
            'objects',
          ),
        )
        .pipe(Effect.mapError(unavailable));
      const [core] = yield* Schema.decodeUnknownEffect(Schema.Tuple([DirectoryRecoveryCoreEvidenceSchema]))(rows).pipe(
        Effect.mapError(unavailable),
      );
      if (attempt.targetLegalEntityId === undefined) {
        return yield* unavailable();
      }
      const registration = yield* readRunner
        .run({ legalEntityId: attempt.targetLegalEntityId, tenantId: request.tenantId }, (transaction) =>
          readRetailEnrollmentRegistration(transaction, request.attemptId),
        )
        .pipe(Effect.mapError(unavailable));
      return { attempt, core, operation, partyOperation, registration };
    });
    return {
      observe,
      store: (observation) => {
        const store = commerceEnrollmentOwnerAttemptStoreForRun(
          observation.attempt.targetLegalEntityId === undefined
            ? { tenantId: observation.attempt.tenantId }
            : { legalEntityId: observation.attempt.targetLegalEntityId, tenantId: observation.attempt.tenantId },
          runner.run,
        );
        return {
          ...store,
          // The same approved native fence the profile recovery uses: exact rows, closed admission.
          claimTransition: (input) =>
            coreDatabase.executor
              .transaction((transaction) => claimRetailProfileWithAtomicApproval(transaction, observation, input))
              .pipe(Effect.mapError(() => attemptUnavailable('The exact approved owner fence did not commit'))),
        };
      },
    } satisfies typeof AdmittedCustomerDirectoryRecoveryRuntime.Service;
  },
);

export const runCustomerDirectoryRecoveryCommand = Effect.gen(function* runCustomerDirectoryRecoveryCommand() {
  const configuration = yield* Config.all({
    approval: Config.option(Config.String('ONTOS_STAGE_PROFILE_RECOVERY_APPROVAL_SHA256')),
    environment: Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'),
    mode: Config.schema(RecoveryModeSchema, 'ONTOS_STAGE_PROFILE_RECOVERY_MODE').pipe(Config.withDefault('check')),
    request: Config.schema(
      Schema.fromJsonString(DirectoryRecoveryRequestSchema),
      'ONTOS_STAGE_PROFILE_RECOVERY_REQUEST_JSON',
    ),
    sourceRevision: Config.schema(RecoverySourceRevisionSchema, 'ONTOS_STAGE_PROFILE_RECOVERY_SOURCE_REVISION'),
  }).pipe(Effect.mapError(configurationInvalid));
  if (configuration.environment !== 'stage') {
    return yield* configurationInvalid();
  }
  return yield* recoverAdmittedCustomerDirectory({
    approvalSha256: Option.getOrUndefined(configuration.approval),
    mode: configuration.mode,
    request: configuration.request,
    sourceRevision: configuration.sourceRevision,
  });
});

const failureReportSchema = Schema.fromJsonString(
  Schema.Struct({
    reason: DirectoryRecoveryReasonSchema,
    schemaVersion: Schema.Literal(1),
    status: Schema.Literals(['blocked', 'unknown']),
  }),
);
const configuredMode = Config.schema(RecoveryModeSchema, 'ONTOS_STAGE_PROFILE_RECOVERY_MODE').pipe(
  Config.withDefault('check'),
);
const runtimeLayer = Layer.effect(
  AdmittedCustomerDirectoryRecoveryRuntime,
  configuredMode.pipe(Effect.flatMap(makeCustomerDirectoryRecoveryRuntime)),
);

if (import.meta.main) {
  const program = configuredMode.pipe(
    Effect.mapError(configurationInvalid),
    Effect.flatMap((mode) =>
      withCustomerDirectoryRecoveryDeadline(
        Effect.scoped(
          Layer.build(
            Layer.effectDiscard(
              runCustomerDirectoryRecoveryCommand.pipe(
                Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(DirectoryRecoveryReportSchema))),
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
          Option.isSome(observed) && Schema.is(AdmittedCustomerDirectoryRecoveryError)(observed.value)
            ? observed.value
            : new AdmittedCustomerDirectoryRecoveryError({ reason: 'unknown' });
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
