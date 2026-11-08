import { Context, Crypto, Effect, Layer } from 'effect';

import { recoverSqlTransactionError } from '../../actions/repository.ts';
import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import { accessDecisionLogs } from '../../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { AccessDecision, DecisionCapabilityPolicy } from '../decision/contract.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessScopeId, PrincipalId, RecordKey } from '../ids.ts';
import type { AccessMode, ActorContext, DecisionOutcome, DecisionReason } from '../model.ts';

/**
 * "Proč?" evidence: the decisions that have to be explainable afterwards. The row is append-only and
 * names the exact scope it was taken in, so a later question is answered without re-deciding
 * anything (CUTOVER-PLAN §3.1 step 9). The request correlation id comes from the scope itself.
 */
/**
 * The calling module of a delegated request (D6): the app that made the call and the service principal
 * its module key is bound to. Recorded beside the subject, so one row names both identities.
 */
export interface AccessDecisionDelegation {
  readonly appId: string;
  readonly principalId: string;
}

export interface AccessDecisionLogEntry {
  readonly actor: ActorContext;
  readonly admissionDeadline?: Date;
  readonly capability: DecisionCapabilityPolicy;
  readonly decidedAt: Date;
  /** The calling module, when the subject in `actor` was reached through a delegated call. */
  readonly delegation?: AccessDecisionDelegation;
  readonly mode: AccessMode;
  /**
   * The person who asked about `actor` when the two differ (O86): an administrator explaining
   * somebody else's decision is recorded as the asker, never as the subject that was evaluated.
   */
  readonly onBehalfOfPrincipalId?: PrincipalId;
  readonly outcome: DecisionOutcome;
  readonly reasons: readonly DecisionReason[];
  readonly scope: OperationalScope;
  readonly scopeId: AccessScopeId;
  readonly target?: RecordKey;
}

export interface AccessDecisionLogWriter {
  /**
   * `transaction` is a transaction the caller already owns (O75): a decision taken inside an owner
   * Action's transaction must write its evidence in that transaction, so a rollback leaves no row for
   * an act that never happened. A caller with no transaction leaves it out and the row opens its own.
   */
  readonly record: (
    entry: AccessDecisionLogEntry,
    transaction?: CoreTransaction,
  ) => Effect.Effect<void, AccessDecisionUnavailable>;
}

/** The runtime binds the evidence writer through this service tag. */
export class AccessDecisionLog extends Context.Service<AccessDecisionLog, AccessDecisionLogWriter>()(
  '@app/core-runtime/access/enforcement/decision-log/AccessDecisionLog',
) {}

/**
 * Which decisions are recorded: every denial and every approval request, and the allowed work that
 * is sensitive or critical. A routine allow writes nothing, and an unavailable engine is not
 * evidence of anything a person did — it is a retryable failure, not a decision.
 */
export const shouldRecordDecision = (
  decision: AccessDecision,
  capability: Pick<DecisionCapabilityPolicy, 'risk'>,
): boolean => decision.outcome !== 'UNAVAILABLE' && (decision.outcome !== 'ALLOWED' || capability.risk !== 'routine');

/**
 * A delegated request always leaves its evidence row (D6), routine allows included, because the row is
 * the only record that a module acted for the subject. An unavailable answer is still not evidence.
 */
export const shouldRecordDelegatedDecision = (decision: AccessDecision): boolean => decision.outcome !== 'UNAVAILABLE';

/** The Core executor the writer is built over; the caller owns the pool and its deadlines. */
export interface AccessDecisionLogDatabase {
  /** The enrolled database identities whose scope authority the installed scope is verified against. */
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly executor: CoreDatabaseExecutor;
}

const logUnavailable = (cause: unknown) =>
  accessDecisionUnavailable('The decision could not be recorded as evidence', cause);

/** One evidence row, written in the scope the decision was taken in; the id is minted here. */
const recordEffect = Effect.fn('AccessDecisionLog.record')(function* recordDecisionLog(
  database: AccessDecisionLogDatabase,
  crypto: Crypto.Crypto,
  entry: AccessDecisionLogEntry,
  transaction?: CoreTransaction,
) {
  const decisionLogId = yield* crypto
    .randomUUIDv4()
    .pipe(
      Effect.mapError((cause) =>
        accessDecisionUnavailable('An identifier for this decision record could not be generated', cause),
      ),
    );
  const insert = (opened: CoreTransaction) =>
    installOperationalScope(opened, entry.scope, database.enrollment).pipe(
      Effect.andThen(() =>
        opened.insert(accessDecisionLogs).values({
          actorJson: entry.actor,
          actorPrincipalId: entry.actor.principalId,
          admissionDeadline: entry.admissionDeadline ?? null,
          capabilityKey: entry.capability.capabilityKey,
          correlationId: entry.scope.correlationId,
          decidedAt: entry.decidedAt,
          decisionLogId,
          delegateAppId: entry.delegation?.appId ?? null,
          delegatePrincipalId: entry.delegation?.principalId ?? null,
          mode: entry.mode,
          onBehalfOfPrincipalId: entry.onBehalfOfPrincipalId ?? null,
          outcome: entry.outcome,
          reasonsJson: entry.reasons,
          scopeId: entry.scopeId,
          scopeTarget: entry.target ?? null,
          tenantId: entry.scope.tenantId,
        }),
      ),
    );
  yield* transaction === undefined ? database.executor.transaction(insert) : insert(transaction);
});

export const makeDrizzleAccessDecisionLog = (
  database: AccessDecisionLogDatabase,
  crypto: Crypto.Crypto,
): AccessDecisionLogWriter => ({
  record: (entry, transaction) =>
    recordEffect(database, crypto, entry, transaction).pipe(
      recoverSqlTransactionError,
      Effect.mapError(logUnavailable),
      Effect.asVoid,
    ),
});

export const AccessDecisionLogLive: Layer.Layer<
  AccessDecisionLog,
  never,
  CoreDatabase | Crypto.Crypto | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  AccessDecisionLog,
  Effect.gen(function* accessDecisionLogLive() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeDrizzleAccessDecisionLog({ enrollment, executor: database.executor }, yield* Crypto.Crypto);
  }),
);
