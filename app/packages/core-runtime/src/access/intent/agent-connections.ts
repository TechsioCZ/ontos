import { and, eq, sql } from 'drizzle-orm';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import {
  accessAgentConnections,
  accessConsentSnapshots,
  accessScopes,
  principalCompanyMemberships,
  principals,
} from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { readLatestAgentOperatorCommand } from '../../modules/actions/agent-operator-command.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { stableUuid } from '../catalog/stable-id.ts';
import { AccessScopeIdSchema, AgentConnectionIdSchema, AgentIdSchema, PrincipalIdSchema } from '../ids.ts';
import type { AccessScopeId, AgentConnectionId, AgentId, LegalEntityId, PrincipalId } from '../ids.ts';
import { ConsentCeilingSchema } from '../model.ts';
import type { ConsentCeiling, LifecycleStatus } from '../model.ts';
import { AgentConnectionRefused } from './agent-connection-refused.ts';
import type { AgentConnectionRefusal } from './agent-connection-refused.ts';
import type { AccessIntentError } from './errors.ts';

import { intentConflict, intentUnavailable } from './errors.ts';
import type { AccessIntentDatabase } from './persistence.ts';
import { asDate, durable, runScoped } from './persistence.ts';

export { AgentConnectionRefused, AgentConnectionRefusalSchema } from './agent-connection-refused.ts';
export type { AgentConnectionRefusal } from './agent-connection-refused.ts';

/*
 * The credential-bound agent connection (D13): the one row through which an agent acts. An operator consents
 * "Za agenta" for one OAuth grant, and that consent is written here as the connection (agent, operator, company
 * scope, period) with its consent ceiling at revision 1. The engine reads the row fresh on every decision and admits
 * the agent only while it is active, names exactly the agent, the operator and the scope of the request, is inside its
 * period and is at the revision the credential carries.
 *
 * The connection of a grant has an id derived from the grant id, so a grant binds exactly one connection and no other
 * grant can ever name it; the OAuth transport still carries the id it read from this row, never the grant id itself.
 * A connection never reopens: ending a grant ends its connection for good, and a new consent is a new grant.
 */

/** The connection of one OAuth grant: derived, so a retried consent writes the same row instead of a second one. */
export const agentConnectionIdOfGrant = (grantId: string): AgentConnectionId =>
  AgentConnectionIdSchema.make(stableUuid(`ontos.access.agent-connection.v1\u0000${grantId}`));

const CONNECTION_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_agent_connections_pkey',
  'access_connections_tenant_id_uk',
  'access_consent_snapshots_pk',
]);

export interface OpenAgentConnection {
  readonly agentId: AgentId;
  /** The consent ceiling: what the operator lets the agent use through this connection (intersected by the engine). */
  readonly ceiling: ConsentCeiling;
  readonly connectionId: AgentConnectionId;
  readonly legalEntityId: LegalEntityId;
  readonly validUntil: Date;
}

/** The live facts of one connection, as the OAuth transport carries them. */
export interface AgentConnectionState {
  readonly agentId: AgentId;
  readonly connectionId: AgentConnectionId;
  readonly principalId: PrincipalId;
  readonly revision: number;
  readonly scopeId: AccessScopeId;
  readonly status: LifecycleStatus;
  readonly validUntil: Date;
}

export interface AgentConnectionStoreService {
  /**
   * Opens the connection the scoped person consents to as the operator of `agentId` in the scope's company. In ONE
   * transaction it share-locks and proves: the agent is an active agent with an active directory membership of that
   * company, and the scoped person is one of the agent's current operators (the latest committed operator command).
   * Then it writes the active connection and its consent at revision 1. The same connection id again is a retry: an
   * active row of the same agent, operator and scope is answered as it is; any other existing row is refused.
   */
  readonly open: (
    scope: OperationalScope,
    input: OpenAgentConnection,
  ) => Effect.Effect<AgentConnectionState, AgentConnectionRefused | AccessIntentError>;
  /** The row the transport reads to carry its exact id and revision; none when the grant has no connection. */
  readonly read: (
    scope: OperationalScope,
    connectionId: AgentConnectionId,
  ) => Effect.Effect<Option.Option<AgentConnectionState>, AccessIntentError>;
  /** Ends the connection for good (idempotent): the engine refuses it from the next decision on. */
  readonly revoke: (scope: OperationalScope, connectionId: AgentConnectionId) => Effect.Effect<void, AccessIntentError>;
}

export class AgentConnectionStore extends Context.Service<AgentConnectionStore, AgentConnectionStoreService>()(
  '@app/core-runtime/access/intent/agent-connections/AgentConnectionStore',
) {}

const refused = (code: AgentConnectionRefusal, reason: string) => new AgentConnectionRefused({ code, reason });

const stateColumns = {
  agentId: accessAgentConnections.agentId,
  connectionId: accessAgentConnections.connectionId,
  principalId: accessAgentConnections.principalId,
  revision: accessAgentConnections.revision,
  scopeId: accessAgentConnections.scopeId,
  status: accessAgentConnections.status,
  validUntil: accessAgentConnections.validUntil,
};

interface StateRow {
  readonly agentId: string;
  readonly connectionId: string;
  readonly principalId: string;
  readonly revision: number;
  readonly scopeId: string;
  readonly status: LifecycleStatus;
  readonly validUntil: Date | string;
}

const stateOf = (row: StateRow): AgentConnectionState => ({
  agentId: AgentIdSchema.make(row.agentId),
  connectionId: AgentConnectionIdSchema.make(row.connectionId),
  principalId: PrincipalIdSchema.make(row.principalId),
  revision: row.revision,
  scopeId: AccessScopeIdSchema.make(row.scopeId),
  status: row.status,
  validUntil: asDate(row.validUntil),
});

const readRow = (transaction: CoreTransaction, scope: OperationalScope, connectionId: AgentConnectionId) =>
  transaction
    .select(stateColumns)
    .from(accessAgentConnections)
    .where(
      and(eq(accessAgentConnections.tenantId, scope.tenantId), eq(accessAgentConnections.connectionId, connectionId)),
    )
    .limit(1)
    .pipe(Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), stateOf)));

/** The active agent with an active directory row of the company, share-locked like a People admission (S2). */
const agentIsActiveInCompany = Effect.fn('AgentConnectionStore.agentIsActiveInCompany')(function* agentActive(
  transaction: CoreTransaction,
  scope: OperationalScope,
  agentId: AgentId,
  legalEntityId: LegalEntityId,
) {
  yield* transaction.execute(sql`select set_config('ontos.legal_entity_id', ${legalEntityId}, true)`, 'objects');
  const rows = yield* transaction
    .select({ principalId: principalCompanyMemberships.principalId })
    .from(principalCompanyMemberships)
    .innerJoin(
      principals,
      and(
        eq(principals.tenantId, principalCompanyMemberships.tenantId),
        eq(principals.principalId, principalCompanyMemberships.principalId),
      ),
    )
    .where(
      and(
        eq(principalCompanyMemberships.tenantId, scope.tenantId),
        eq(principalCompanyMemberships.legalEntityId, legalEntityId),
        eq(principalCompanyMemberships.principalId, agentId),
        eq(principalCompanyMemberships.status, 'active'),
        eq(principals.kind, 'agent'),
        eq(principals.status, 'active'),
      ),
    )
    .for('share');
  yield* transaction.execute(
    sql`select set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true)`,
    'objects',
  );
  return rows.length === 1;
});

/**
 * The one transaction of `open`: the company scope, an existing row (a retry), the active agent of the company and the
 * consenting operator, then the connection and its consent at revision 1. A refusal is answered, never thrown, so the
 * transaction commits nothing for it.
 */
const openInTransaction = Effect.fn('AgentConnectionStore.openInTransaction')(function* openInTransaction(params: {
  readonly ceiling: ConsentCeiling;
  readonly input: OpenAgentConnection;
  readonly operator: PrincipalId;
  readonly scope: OperationalScope;
  readonly transaction: CoreTransaction;
}) {
  const { ceiling, input, operator, scope, transaction } = params;
  const [companyScope] = yield* transaction
    .select({ scopeId: accessScopes.scopeId })
    .from(accessScopes)
    .where(and(eq(accessScopes.tenantId, scope.tenantId), eq(accessScopes.legalEntityId, input.legalEntityId)))
    .limit(1);
  if (companyScope === undefined) {
    return Option.some(refused('agent_connection_scope_missing', 'The company has no access scope'));
  }
  const existing = yield* readRow(transaction, scope, input.connectionId);
  if (Option.isSome(existing)) {
    const row = existing.value;
    const same =
      row.status === 'active' &&
      row.agentId === input.agentId &&
      row.principalId === operator &&
      row.scopeId === companyScope.scopeId;
    return same
      ? Option.none()
      : Option.some(refused('agent_connection_ended', 'This connection already exists and never reopens'));
  }
  if (!(yield* agentIsActiveInCompany(transaction, scope, input.agentId, input.legalEntityId))) {
    return Option.some(refused('agent_connection_agent_inactive', 'The agent is not an active agent of this company'));
  }
  // The operators are the agent's latest committed operator command, read under the agent's row lock that every
  // operator change also takes, so a concurrent removal either waits for this consent or refuses it.
  yield* transaction
    .select({ principalId: principals.principalId })
    .from(principals)
    .where(and(eq(principals.tenantId, scope.tenantId), eq(principals.principalId, input.agentId)))
    .for('share');
  const operators = yield* readLatestAgentOperatorCommand(transaction, scope.tenantId, input.agentId).pipe(
    Effect.mapError((cause) => intentUnavailable('The operators of the agent could not be read', cause)),
  );
  if (operators === null || !operators.desiredOperatorPrincipalIds.includes(operator)) {
    return Option.some(refused('agent_connection_not_operator', 'Only an operator of the agent connects it'));
  }
  const now = yield* DateTime.nowAsDate;
  yield* transaction.insert(accessAgentConnections).values({
    agentId: input.agentId,
    ceilingJson: ceiling,
    connectionId: input.connectionId,
    principalId: operator,
    revision: 1,
    scopeId: companyScope.scopeId,
    status: 'active',
    tenantId: scope.tenantId,
    validFrom: now,
    validUntil: input.validUntil,
  });
  yield* transaction.insert(accessConsentSnapshots).values({
    ceilingJson: ceiling,
    connectionId: input.connectionId,
    grantedAt: now,
    grantedBy: operator,
    revision: 1,
    tenantId: scope.tenantId,
  });
  return Option.none();
});

export const makeAgentConnectionStore = (database: AccessIntentDatabase): AgentConnectionStoreService => {
  const open = Effect.fn('AgentConnectionStore.open')(function* openConnection(
    scope: OperationalScope,
    input: OpenAgentConnection,
  ) {
    const ceiling = yield* Schema.decodeUnknownEffect(ConsentCeilingSchema)(input.ceiling).pipe(
      Effect.mapError((cause) => intentUnavailable('The consent ceiling is not a valid ceiling', cause)),
    );
    if (scope.legalEntityId !== input.legalEntityId) {
      return yield* refused(
        'agent_connection_scope_missing',
        'The connection is opened in the consenting company only',
      );
    }
    const operator = PrincipalIdSchema.make(scope.principalId);
    const outcome = yield* runScoped(database, scope, CONNECTION_CONSTRAINTS, (transaction) =>
      openInTransaction({ ceiling, input, operator, scope, transaction }).pipe(durable(CONNECTION_CONSTRAINTS)),
    );
    if (Option.isSome(outcome)) {
      return yield* outcome.value;
    }
    const written = yield* runScoped(database, scope, CONNECTION_CONSTRAINTS, (transaction) =>
      readRow(transaction, scope, input.connectionId).pipe(durable(CONNECTION_CONSTRAINTS)),
    );
    return yield* Effect.fromOption(written).pipe(
      Effect.catchTag('NoSuchElementError', () =>
        Effect.fail(intentConflict('access_intent_write_refused', 'The connection was not written')),
      ),
    );
  });

  const read = Effect.fn('AgentConnectionStore.read')(function* readConnection(
    scope: OperationalScope,
    connectionId: AgentConnectionId,
  ) {
    return yield* runScoped(database, scope, CONNECTION_CONSTRAINTS, (transaction) =>
      readRow(transaction, scope, connectionId).pipe(durable(CONNECTION_CONSTRAINTS)),
    );
  });

  const revoke = Effect.fn('AgentConnectionStore.revoke')(function* revokeConnection(
    scope: OperationalScope,
    connectionId: AgentConnectionId,
  ) {
    yield* runScoped(database, scope, CONNECTION_CONSTRAINTS, (transaction) =>
      transaction
        .update(accessAgentConnections)
        .set({ status: 'revoked' })
        .where(
          and(
            eq(accessAgentConnections.tenantId, scope.tenantId),
            eq(accessAgentConnections.connectionId, connectionId),
            eq(accessAgentConnections.status, 'active'),
          ),
        )
        .pipe(durable(CONNECTION_CONSTRAINTS)),
    );
  });

  return Object.freeze({ open, read, revoke });
};

export const AgentConnectionStoreLive = Layer.effect(
  AgentConnectionStore,
  Effect.gen(function* agentConnectionStoreLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeAgentConnectionStore({ enrollment, executor: database.executor });
  }),
);
