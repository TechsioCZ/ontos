import { and, eq } from 'drizzle-orm';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Array as Arr } from 'effect';

import { recoverSqlTransactionError } from '../../actions/repository.ts';
import { readVerifiedGatewayScopeAssertion } from '../../auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../../db/client.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import { principals } from '../../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { DecisionReason } from '../model.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import type { PrincipalId, TenantId } from '../ids.ts';
import { PrincipalIdSchema, TenantIdSchema } from '../ids.ts';

/**
 * The principal kinds `core.principals` holds. v2 has exactly one acting subject kind — a verified
 * human — plus agents once a credential carries their connection and consent; every other kind is a
 * trusted workload with its own owner-local classification (O29, O46, O67-Q5).
 */
export const ACCESS_PRINCIPAL_KINDS = ['agent', 'human', 'integration', 'service', 'system'] as const;
export type AccessPrincipalKind = (typeof ACCESS_PRINCIPAL_KINDS)[number];

/** Kinds that never take part in a v2 decision: they are workloads, not people or agents (O29). */
export const WORKLOAD_PRINCIPAL_KINDS = ['integration', 'service', 'system'] as const;

export const isWorkloadPrincipalKind = (kind: AccessPrincipalKind): boolean =>
  WORKLOAD_PRINCIPAL_KINDS.some((workload) => workload === kind);

const AccessPrincipalKindSchema = Schema.Literals(ACCESS_PRINCIPAL_KINDS);
const decodePrincipalKind = Schema.decodeUnknownOption(AccessPrincipalKindSchema);

/** The acting principal of one request, always named inside its own tenant scope (O66). */
export interface PrincipalKindQuery {
  readonly principalId: PrincipalId;
  readonly scope: OperationalScope;
  readonly tenantId: TenantId;
}

/**
 * Reads `core.principals.kind`. The kind is a fact of Core's identity rows, never a caller flag
 * (O64): the seam asks for it instead of trusting what the request claims about itself.
 */
export interface AccessPrincipalKinds {
  /**
   * `transaction` is a transaction the caller already owns (O75). A mandate claim or a parked owner
   * proposal decides inside the owner Action's transaction, so its kind read must be that
   * transaction's: a second connection would answer about another instant, and on one connection
   * PostgreSQL refuses an inner transaction outright. A caller with no transaction leaves it out and
   * the read opens one of its own in the request's scope.
   */
  readonly readKind: (
    query: PrincipalKindQuery,
    transaction?: CoreTransaction,
  ) => Effect.Effect<Option.Option<AccessPrincipalKind>, AccessDecisionUnavailable>;
}

/** The runtime binds the identity reader through this service tag. */
export class AccessPrincipalKindSource extends Context.Service<AccessPrincipalKindSource, AccessPrincipalKinds>()(
  '@app/core-runtime/access/enforcement/actor/AccessPrincipalKindSource',
) {}

/** The Core executor the reader is built over; the caller owns the pool and its deadlines. */
export interface AccessPrincipalKindDatabase {
  readonly executor: CoreDatabaseExecutor;
}

/**
 * One row, inside the request's own tenant scope. Row-level security decides which tenant the read
 * can see, so a principal id from another tenant answers nothing rather than someone else's kind.
 */
const selectKind = (
  transaction: Pick<CoreTransaction, 'select'>,
  query: Pick<PrincipalKindQuery, 'principalId' | 'tenantId'>,
) =>
  transaction
    .select({ kind: principals.kind })
    .from(principals)
    .where(and(eq(principals.tenantId, query.tenantId), eq(principals.principalId, query.principalId)))
    .limit(1);

const kindsIn = (transaction: CoreTransaction, query: PrincipalKindQuery) =>
  installOperationalScope(transaction, query.scope).pipe(Effect.andThen((scoped) => selectKind(scoped, query)));

const principalKindUnavailable = (cause?: unknown) =>
  accessDecisionUnavailable('The acting principal could not be read from Core identity', cause);

/**
 * An owner may restrict a gateway carrier to an exact Core principal kind. Only its verified
 * gateway actor is observable here, through the already scoped owner transaction.
 */
export const readScopedGatewayPrincipalKind = Effect.fn('AccessPrincipalKinds.readScopedGatewayKind')(
  function* readScopedGatewayPrincipalKind(transaction: ScopedTransactionExecutor, scope: OperationalScope) {
    if (
      transaction.scope.tenantId !== scope.tenantId ||
      transaction.scope.legalEntityId !== scope.legalEntityId ||
      readVerifiedGatewayScopeAssertion(scope) === undefined
    ) {
      return yield* principalKindUnavailable();
    }
    const [row] = yield* selectKind(transaction, {
      principalId: PrincipalIdSchema.make(scope.principalId),
      tenantId: TenantIdSchema.make(scope.tenantId),
    }).pipe(Effect.mapError(principalKindUnavailable));
    return row === undefined ? Option.none<AccessPrincipalKind>() : decodePrincipalKind(row.kind);
  },
);

/** The same query, in the caller's own transaction when it has one and in a fresh one otherwise. */
const readKindEffect = Effect.fn('AccessPrincipalKinds.readKind')(function* readKind(
  database: AccessPrincipalKindDatabase,
  query: PrincipalKindQuery,
  transaction?: CoreTransaction,
) {
  const rows = yield* transaction === undefined
    ? database.executor.transaction((opened) => kindsIn(opened, query))
    : kindsIn(transaction, query);
  const [row] = rows;
  return row === undefined ? Option.none<AccessPrincipalKind>() : decodePrincipalKind(row.kind);
});

export const makeDrizzleAccessPrincipalKinds = (database: AccessPrincipalKindDatabase): AccessPrincipalKinds => ({
  readKind: (query, transaction) =>
    readKindEffect(database, query, transaction).pipe(
      recoverSqlTransactionError,
      Effect.mapError(principalKindUnavailable),
    ),
});

export const AccessPrincipalKindSourceLive: Layer.Layer<AccessPrincipalKindSource, never, CoreDatabase> = Layer.effect(
  AccessPrincipalKindSource,
  Effect.gen(function* accessPrincipalKindSourceLive() {
    const database = yield* CoreDatabase;
    return makeDrizzleAccessPrincipalKinds(database);
  }),
);

/** The one actor a v2 decision can be asked for in this wave: a verified human (O46, O67-Q5). */
export interface GateActor {
  readonly kind: AccessPrincipalKind;
  readonly principalId: PrincipalId;
}

/**
 * Either the actor, a refusal, or unavailable identity. Plain optional fields keep every outcome
 * explicit without tag inspection (the same shape the engine's own actor resolution uses).
 */
export interface GateActorResolution {
  readonly actor?: GateActor;
  readonly refusal?: Arr.NonEmptyReadonlyArray<DecisionReason>;
  /** The identity row could not be read, so no safe answer exists: UNAVAILABLE, never a denial. */
  readonly unavailable?: true;
  /** The actor is a trusted workload, admissible only on a carrier that declares `accessWorkload`. */
  readonly workload?: true;
}

/** How a request's actor may be resolved: a workload is read only where a carrier declares it (O59). */
export interface GateActorQuery {
  /**
   * Whether a workload kind is resolved as an actor instead of being refused here. The enforcement
   * seam sets it when a carrier is under enforcement, so it can decide the path and the refusal code
   * itself (an `admin` declaration refuses a workload as an agent, O81). A caller without a carrier
   * (company selection) leaves it false, because v2 never grants a workload (O29, O46).
   */
  readonly admitWorkloads?: boolean;
}

/** A refusal that happens before the engine is asked still says exactly why. */
export const seamlessRefusal = (code: string): Arr.NonEmptyReadonlyArray<DecisionReason> => [{ code }];

/**
 * The acting principal kind of a request. An agent is always refused because it needs a connection
 * id and consent revision that no transport carries yet (O46, O67-Q5). A workload has no v2
 * authority either; it is resolved as an actor only when the caller admits workloads, so the seam can
 * admit it through its owner's classification on an `accessWorkload` carrier or refuse it with the
 * code its carrier deserves (O29, O59, O67-Q4, O81).
 */
export const resolveGateActor = (
  principalKinds: AccessPrincipalKinds,
  scope: OperationalScope,
  query: GateActorQuery = {},
): Effect.Effect<GateActorResolution> =>
  principalKinds
    .readKind({
      principalId: PrincipalIdSchema.make(scope.principalId),
      scope,
      tenantId: TenantIdSchema.make(scope.tenantId),
    })
    .pipe(
      Effect.option,
      Effect.map((read): GateActorResolution => {
        if (Option.isNone(read)) {
          return { unavailable: true };
        }
        const kind = Option.getOrUndefined(read.value);
        if (kind === undefined) {
          // No identity row of a known kind: nothing v2 could ever grant to it, so it is refused.
          return { refusal: seamlessRefusal('deny.principal_kind_forbidden') };
        }
        if (kind === 'human') {
          return { actor: { kind, principalId: PrincipalIdSchema.make(scope.principalId) } };
        }
        if (kind === 'agent') {
          return { refusal: seamlessRefusal('deny.agent_forbidden') };
        }
        return query.admitWorkloads === true
          ? { actor: { kind, principalId: PrincipalIdSchema.make(scope.principalId) }, workload: true }
          : { refusal: seamlessRefusal('deny.workload_forbidden') };
      }),
    );
