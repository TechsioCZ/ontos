import {
  loadDatabaseConnectionPair,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import type { TestAccessOutcome } from '@app/core-runtime/testing/access-gate';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { PgClient } from '@effect/sql-pg';
import { DateTime, Effect, Layer, Redacted, Schema } from 'effect';

import type { MessageHistoryDetailRequest } from '../../shared/apis/message-history-detail.ts';
import type { MessageHistoryListRequestSchema } from '../../shared/apis/message-history-list.ts';
import { messageHistoryDetailRead } from '../../src/api/message-history-detail.read.ts';
import { messageHistoryListRead } from '../../src/api/message-history-list.read.ts';
import { SourceScopeVisibility } from '../../src/domain/access/source-visibility.ts';
import { SourceScopeVisibilityUnavailable } from '../../src/domain/access/source-visibility-errors.ts';
import type { SourceVisibility, SourceVisibilityQuery } from '../../src/domain/access/source-visibility.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';

/**
 * TEST-ONLY wiring of the public history Reads through Core's REAL Read lifecycle (scripted access gate, scope installation,
 * module state, evidence) over REAL owner SQL on native PostgreSQL as the runtime role, with the row-level security of the
 * Tenant installed exactly as the lifecycle asks. The access gate is a SCRIPT, not SpiceDB, and the source-owner visibility
 * port is a labelled double: this proves the lifecycle and the owner's queries, never an authorization graph.
 */

const COMPOSITION_REVISION = 'a'.repeat(64);
/**
 * The Read runs a century after every row was written: a retention window that elapsed during the read must neither hide nor
 * remove anything, because no read branches on time (ACC-12, AC-08).
 */
const READ_TIME = DateTime.toDateUtc(DateTime.makeUnsafe('2126-11-19T12:00:00Z'));

/** One runtime-role connection, as `ontos_runtime`: the Tenant of every statement is installed in its own transaction. */
export const nativeRuntimeClient = loadDatabaseConnectionPair().pipe(
  Effect.flatMap(({ runtime }) => PgClient.makeClient({ url: Redacted.make(runtime.connectionString) })),
  Effect.orDie,
);

type NativeRuntimeClient = Effect.Success<typeof nativeRuntimeClient>;

interface OwnerQuery {
  readonly params: readonly unknown[];
  readonly scope: { readonly legalEntityId: string; readonly tenantId: string };
  readonly sql: string;
}

/** Runs every owner statement of the Read lifecycle in its own transaction with the Tenant the lifecycle installed. */
const nativeOwnerQuery = (client: NativeRuntimeClient) => (query: OwnerQuery) =>
  client
    .withTransaction(
      Effect.gen(function* ownerStatement() {
        yield* client.unsafe(
          "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)",
          [query.scope.tenantId, query.scope.legalEntityId],
        );
        // values (arrays), exactly as the Core harness maps them back onto the owner's selected columns
        return yield* client.unsafe(query.sql, query.params).values;
      }),
    )
    .pipe(Effect.orDie);

/** A labelled stand-in for the source owners' visibility: it answers per scope and records every question. */
export const visibilityDouble = (answers: (query: SourceVisibilityQuery) => SourceVisibility | 'UNAVAILABLE') => {
  const asked: SourceVisibilityQuery[] = [];
  const layer = Layer.succeed(SourceScopeVisibility, {
    check: (query) =>
      Effect.suspend(() => {
        asked.push(query);
        const answer = answers(query);
        return answer === 'UNAVAILABLE'
          ? Effect.fail(new SourceScopeVisibilityUnavailable({ reason: 'OWNER_UNAVAILABLE' }))
          : Effect.succeed(answer);
      }),
  });
  return { asked, layer };
};

export interface AccessReadOptions {
  readonly access: TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>>;
  readonly legalEntityId?: string;
  readonly principalId?: string;
  readonly tenantId: string;
}

interface PrincipalFields {
  readonly authBindingId: string;
  readonly authContextRef: string;
  readonly authMethod: 'session';
  legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const principalFieldsOf = (options: AccessReadOptions) => {
  const fields: PrincipalFields = {
    authBindingId: '99999999-9999-4999-8999-999999999999',
    authContextRef: 'better-auth-session:history-access-test',
    authMethod: 'session',
    principalId: options.principalId ?? '77777777-7777-4777-8777-777777777777',
    tenantId: options.tenantId,
  };
  if (options.legalEntityId !== undefined) {
    fields.legalEntityId = options.legalEntityId;
  }
  return fields;
};

export const accessReads = Effect.fn('CommunicationsAccessTest.reads')(function* reads(
  client: NativeRuntimeClient,
  options: AccessReadOptions,
) {
  const principal = trustVerifiedGatewayPrincipalContext(
    Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(principalFieldsOf(options)),
    COMPOSITION_REVISION,
  );
  const scope = { ...principal, correlationId: 'history-access-read' };
  const executeOwnerQuery = nativeOwnerQuery(client);
  const statements = { count: 0 };
  const harness = yield* makeReadTestHarness({
    access: options.access,
    compositionRevision: COMPOSITION_REVISION,
    executeOwnerQuery: (query) => {
      statements.count += 1;
      return executeOwnerQuery(query);
    },
    operationTime: READ_TIME,
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: communicationsRegistration,
    scope,
  });
  const transport = { correlationId: scope.correlationId };
  return {
    detail: (input: MessageHistoryDetailRequest) =>
      harness.runtime.runRead({ input, principal, registration: messageHistoryDetailRead, transport }),
    harness,
    list: (input: typeof MessageHistoryListRequestSchema.Encoded = {}) =>
      harness.runtime.runRead({ input, principal, registration: messageHistoryListRead, transport }),
    ownerStatements: () => statements.count,
  };
});
