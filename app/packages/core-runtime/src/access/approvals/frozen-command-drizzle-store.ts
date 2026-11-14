import { and, eq } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Effect, Layer, Option, Result, Schema } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { CommandDigestSchema } from '../ids.ts';

import { isDatabaseIntegrityRefusal, isDatabaseUnavailableFailure } from '../../database/driver-failure.ts';
import { isPostgresUniqueViolation } from '../../database/postgres-failure.ts';
import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import { accessFrozenCommands } from '../../db/schema.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { FrozenCommandSchema } from './command.ts';
import { ApprovalStorageConflictError, ApprovalStorageUnavailableError } from './errors.ts';
import type { FrozenCommandDatabase, FrozenCommandRecord, FrozenCommandStore } from './frozen-command.ts';
import {
  FrozenCommandConflictErrorSchema,
  FrozenCommandIntegrityErrorSchema,
  FrozenCommandRecordSchema,
  FrozenCommands,
  verifyFrozenCommand,
} from './frozen-command.ts';

const conflict = (reason: string) => new ApprovalStorageConflictError({ code: 'approval_storage_conflict', reason });
const unavailable = (reason: string) =>
  new ApprovalStorageUnavailableError({ code: 'approval_storage_unavailable', reason });
const frozenConflict = () =>
  FrozenCommandConflictErrorSchema.make({
    code: 'frozen_command_conflict',
    reason: 'A command was already frozen for this proposal',
  });
const integrity = () =>
  FrozenCommandIntegrityErrorSchema.make({
    code: 'frozen_command_integrity',
    reason: 'The stored command is not a valid frozen command',
  });

const FROZEN_STORE_UNAVAILABLE = 'The frozen-command store is unavailable';
const sqlFailure = (failure: SqlError | EffectDrizzleQueryError) => {
  if (isPostgresUniqueViolation(failure, new Set(['access_frozen_commands_pk']))) {
    return frozenConflict();
  }
  if (isDatabaseIntegrityRefusal(failure)) {
    return conflict('PostgreSQL refused the frozen command binding');
  }
  return unavailable(
    isDatabaseUnavailableFailure(failure)
      ? FROZEN_STORE_UNAVAILABLE
      : 'The frozen-command store could not settle the write',
  );
};

/** A command is only persisted for the request's tenant, never the tenant named by a caller. */
const checkScope = (scope: OperationalScope, record: FrozenCommandRecord) =>
  scope.tenantId === record.tenantId
    ? Effect.void
    : Effect.fail(conflict('The frozen command belongs to another tenant'));

/** Rechecking the digest on both sides of the database is mandatory, not just a runner convention. */
const checked = (record: FrozenCommandRecord) =>
  Result.match(verifyFrozenCommand(record), {
    onFailure: (failure) => Effect.fail(failure),
    onSuccess: (verified) => Effect.succeed(verified),
  });

const decodeRow = (row: {
  readonly actionKey: string;
  readonly capabilityKey: string;
  readonly commandDigest: string;
  readonly commandJson: unknown;
  readonly createdAt: Date;
  readonly proposalId: string;
  readonly scopeId: string;
  readonly tenantId: string;
}) => {
  const metadata = Schema.decodeUnknownResult(FrozenCommandRecordSchema)(row);
  const command = Schema.decodeUnknownResult(FrozenCommandSchema, { onExcessProperty: 'error' })(row.commandJson);
  const digest = Schema.decodeResult(CommandDigestSchema)(row.commandDigest);
  if (Result.isFailure(metadata) || Result.isFailure(command) || Result.isFailure(digest)) {
    return Effect.fail(integrity());
  }
  if (row.capabilityKey !== command.success.capabilityKey) {
    return Effect.fail(integrity());
  }
  return checked({
    ...metadata.success,
    command: command.success,
    commandDigest: digest.success,
    frozenAt: row.createdAt,
  });
};

/** The live PostgreSQL repository, scoped afresh on every call (O66). */
export const makeDrizzleFrozenCommandStore = (database: FrozenCommandDatabase): FrozenCommandStore => {
  const appendInTransaction: FrozenCommandStore['appendInTransaction'] = Effect.fn(
    'frozenCommands.appendInTransaction',
  )(function* appendFrozenInTransaction(scope, record, transaction) {
    yield* checkScope(scope, record);
    yield* checked(record);
    yield* installOperationalScope(transaction, scope, database.enrollment).pipe(
      Effect.catchTag('OperationContextUnavailable', () =>
        Effect.fail(unavailable('The tenant scope could not be installed')),
      ),
    );
    yield* transaction
      .insert(accessFrozenCommands)
      .values({
        actionKey: record.actionKey,
        capabilityKey: record.command.capabilityKey,
        commandDigest: record.commandDigest,
        commandJson: record.command,
        proposalId: record.proposalId,
        scopeId: record.scopeId,
        tenantId: record.tenantId,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTag('EffectDrizzleQueryError', (failure) => Effect.fail(sqlFailure(failure))),
      );
  });

  const loadInTransaction = Effect.fn('frozenCommands.loadInTransaction')(function* loadInTransaction(
    transaction: CoreTransaction,
    scope: OperationalScope,
    input: Parameters<FrozenCommandStore['load']>[1],
  ) {
    yield* installOperationalScope(transaction, scope, database.enrollment).pipe(
      Effect.catchTag('OperationContextUnavailable', () =>
        Effect.fail(unavailable('The tenant scope could not be installed')),
      ),
    );
    const [row] = yield* transaction
      .select({
        actionKey: accessFrozenCommands.actionKey,
        capabilityKey: accessFrozenCommands.capabilityKey,
        commandDigest: accessFrozenCommands.commandDigest,
        commandJson: accessFrozenCommands.commandJson,
        createdAt: accessFrozenCommands.createdAt,
        proposalId: accessFrozenCommands.proposalId,
        scopeId: accessFrozenCommands.scopeId,
        tenantId: accessFrozenCommands.tenantId,
      })
      .from(accessFrozenCommands)
      .where(
        and(
          eq(accessFrozenCommands.tenantId, scope.tenantId),
          eq(accessFrozenCommands.scopeId, input.scopeId),
          eq(accessFrozenCommands.proposalId, input.proposalId),
        ),
      );
    return row === undefined ? Option.none<FrozenCommandRecord>() : Option.some(yield* decodeRow(row));
  });
  const append: FrozenCommandStore['append'] = (scope, record) =>
    database.executor
      .transaction((transaction) => appendInTransaction(scope, record, transaction))
      .pipe(Effect.catchTag('SqlError', (failure) => Effect.fail(sqlFailure(failure))));

  const load: FrozenCommandStore['load'] = (scope, input) =>
    database.executor
      .transaction((transaction) => loadInTransaction(transaction, scope, input))
      .pipe(
        Effect.catchTags({
          EffectDrizzleQueryError: () => Effect.fail(unavailable(FROZEN_STORE_UNAVAILABLE)),
          SqlError: () => Effect.fail(unavailable(FROZEN_STORE_UNAVAILABLE)),
        }),
      );
  return Object.freeze({ append, appendInTransaction, load });
};

/** The frozen-command repository over the process's Core pool; every call names its request scope. */
export const FrozenCommandsLive: Layer.Layer<FrozenCommands, never, CoreDatabase | DatabaseIdentityEnrollmentContext> =
  Layer.effect(
    FrozenCommands,
    Effect.gen(function* frozenCommandsLayer() {
      const database = yield* CoreDatabase;
      const enrollment = yield* DatabaseIdentityEnrollmentContext;
      return makeDrizzleFrozenCommandStore({ enrollment, executor: database.executor });
    }),
  );
