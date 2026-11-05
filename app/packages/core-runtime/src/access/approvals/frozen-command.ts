import type { Option } from 'effect';
import { Context, Effect, Layer, Result, Schema } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { AccessScopeId, CommandDigest, ProposalId, TenantId } from '../ids.ts';
import { AccessScopeIdSchema, ProposalIdSchema, TenantIdSchema } from '../ids.ts';
import type { FrozenCommand } from './command.ts';
import { freezeCommand } from './command.ts';
import type { ApprovalStorageConflictError, ApprovalStorageUnavailableError } from './errors.ts';

/**
 * The command a proposal froze, stored so that execution never has to ask a browser for it again.
 *
 * `access_proposals` keeps only the SHA-256 digest of the command (P5, guarantee 5). An approved
 * proposal therefore has no retrievable command of its own, and re-sending a payload at execution
 * would mean running a payload nobody approved. This record is the durable, tenant-bound command:
 * one row per proposal, written in the same transaction as the proposal itself, never updated.
 *
 * The approval is over `command` exactly as `freezeCommand` sees it — capability, payload and
 * target. `actionKey` sits beside the digest rather than inside it: a person approves what the
 * command does, and the entrypoint that carries it out is a request binding execution verifies
 * structurally against the registration (P5, P6).
 */
export interface FrozenCommandRecord {
  /** The owner Action entrypoint that executes this command, e.g. `finance.invoice.issue`. */
  readonly actionKey: ActionKey;
  readonly command: FrozenCommand;
  /** The digest the proposal and its mandate froze; recomputed from `command` on every read. */
  readonly commandDigest: CommandDigest;
  /**
   * When Core froze the command (`core.access_frozen_commands.created_at`). Every reader that shows a
   * person *what* they are approving needs this instant, and it is reported by the store rather than
   * read from an ambient clock, so the answer is the stored one (A2/B5).
   */
  readonly frozenAt?: Date;
  readonly proposalId: ProposalId;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

/** The identity of one stored command: the proposal it belongs to, in its own tenant and scope. */
export interface FrozenCommandScope {
  readonly proposalId: ProposalId;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

/** The owner Action's own key, branded so it can never be confused with another identifier. */
export const ActionKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('ActionKey'),
);
export type ActionKey = typeof ActionKeySchema.Type;

/** A second command for one proposal: a frozen command is written once and never replaced. */
export const FrozenCommandConflictErrorSchema = Schema.TaggedStruct('FrozenCommandConflictError', {
  code: Schema.Literal('frozen_command_conflict'),
  reason: Schema.String,
});
export type FrozenCommandConflictError = typeof FrozenCommandConflictErrorSchema.Type;

/**
 * The stored command no longer hashes to the digest the approval froze. It is a permanent refusal,
 * never a retryable failure: the record cannot be repaired by asking again, and the command it
 * would execute is not the one a person approved (guarantee 5).
 */
export const FrozenCommandIntegrityErrorSchema = Schema.TaggedStruct('FrozenCommandIntegrityError', {
  code: Schema.Literal('frozen_command_integrity'),
  reason: Schema.String,
});
export type FrozenCommandIntegrityError = typeof FrozenCommandIntegrityErrorSchema.Type;

/** The stored shape, decoded before it is trusted: a row is input like any other. */
export const FrozenCommandRecordSchema = Schema.Struct({
  actionKey: ActionKeySchema,
  commandDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  proposalId: ProposalIdSchema,
  scopeId: AccessScopeIdSchema,
  tenantId: TenantIdSchema,
});

const integrity = (reason: string): FrozenCommandIntegrityError => ({
  _tag: 'FrozenCommandIntegrityError',
  code: 'frozen_command_integrity',
  reason,
});

/**
 * Recomputes the digest of a stored command and refuses a record that no longer matches it. The
 * store runs it on write and every reader runs it again, so a corrupted, hand-edited or partially
 * restored row fails closed instead of executing something else.
 *
 * A stored command that cannot be canonicalised at all — a lone surrogate, a non-finite number, a
 * smuggled excess property — is the same integrity refusal: the digest cannot be re-derived, so the
 * record is not trustworthy.
 */
export const verifyFrozenCommand = (
  record: FrozenCommandRecord,
): Result.Result<FrozenCommandRecord, FrozenCommandIntegrityError> => {
  const recomputed = freezeCommand(record.command);
  if (Result.isFailure(recomputed)) {
    return Result.fail(integrity(`The stored command cannot be canonicalised: ${recomputed.failure.reason}`));
  }
  if (recomputed.success !== record.commandDigest) {
    return Result.fail(integrity('The stored command does not hash to the digest the approval froze'));
  }
  return Result.succeed(record);
};

/**
 * The durable frozen commands of this deployment. Both ends take the caller's `OperationalScope`
 * per call (O66), so a tenant is never bound to an instance and never taken from a command body.
 *
 * `appendInTransaction` is the only shape proposal creation may use: the proposal row and its
 * frozen command share one transaction, so a proposal whose command cannot be retrieved is never
 * stored. `append` exists for a caller that already owns a scope but no transaction; it opens
 * exactly one, and it is never the path a proposal takes.
 */
export interface FrozenCommandStore {
  readonly append: (
    scope: OperationalScope,
    record: FrozenCommandRecord,
  ) => Effect.Effect<
    void,
    | FrozenCommandConflictError
    | FrozenCommandIntegrityError
    | ApprovalStorageConflictError
    | ApprovalStorageUnavailableError
  >;
  readonly appendInTransaction: (
    scope: OperationalScope,
    record: FrozenCommandRecord,
    transaction: CoreTransaction,
  ) => Effect.Effect<
    void,
    | FrozenCommandConflictError
    | FrozenCommandIntegrityError
    | ApprovalStorageConflictError
    | ApprovalStorageUnavailableError
  >;
  /** A missing record is `None`; an unreadable one is retryable unavailability, never a refusal. */
  readonly load: (
    scope: OperationalScope,
    input: { readonly proposalId: ProposalId; readonly scopeId: AccessScopeId },
  ) => Effect.Effect<Option.Option<FrozenCommandRecord>, FrozenCommandIntegrityError | ApprovalStorageUnavailableError>;
}

export class FrozenCommands extends Context.Service<FrozenCommands, FrozenCommandStore>()(
  '@app/core-runtime/access/approvals/frozen-command/FrozenCommands',
) {}

/** What a store builder needs from the deployment's client; a store never holds a transaction. */
export interface FrozenCommandDatabase {
  readonly executor: CoreDatabaseExecutor;
}

/** The layer the deployment binds; the drizzle implementation lives beside the approvals store. */
export const makeFrozenCommandsLayer = (
  build: (database: FrozenCommandDatabase) => FrozenCommandStore,
): Layer.Layer<FrozenCommands, never, CoreDatabase> =>
  Layer.effect(
    FrozenCommands,
    Effect.gen(function* frozenCommandsLayer() {
      const database = yield* CoreDatabase;
      return build(database);
    }),
  );
