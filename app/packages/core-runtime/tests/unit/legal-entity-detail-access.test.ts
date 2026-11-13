import { Cause, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { legalEntityDetailRead } from '../../src/generated-reads/legal-entity-detail.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { ReadHandlerNotFound, ReadPermissionDenied, ReadPermissionUnavailable } from '../../src/reads/errors.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { makeTestBoundAccessGate } from '../../src/testing/access-gate.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

/**
 * O84: the Core Legal Entity detail read is `protected` by its own declaration
 * (`core.identity.legal-entity.read`, sensitive, scope-wide). A caller holding the capability reads
 * any company of its own tenant; a caller without it is denied; an unreadable authority is a
 * retryable 503; and another tenant's company never resolves. Every allow has its denial control.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantId = '00000000-0000-4000-8000-000000000099';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const legalEntityRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;

/** The read's own encoded request shape: plain ids the runtime decodes at its boundary. */
interface LegalEntityDetailInput {
  readonly legalEntityRef: {
    readonly moduleId: 'core.identity';
    readonly resourceId: string;
    readonly resourceType: 'core.identity.legal-entity';
    readonly tenantId: string;
  };
}

const scope: OperationalScope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'better-auth-session:legal-entity-detail',
    authMethod: 'session',
    principalId: '00000000-0000-4000-8000-000000000004',
    tenantId,
  }),
  correlationId: 'correlation-o84',
});

const operationAt = DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-11-03T09:00:00.000Z')));
const installAndReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";

/** The runtime under a scripted database and one scripted gate answer; only the gate is faked. */
const makeRuntime = Effect.fn('LegalEntityDetailAccessSuite.makeRuntime')(function* makeRuntime(
  accessDecision: ReturnType<typeof makeTestBoundAccessGate>['bound'],
) {
  const database = {
    executor: yield* makeTestDatabase((text) => {
      if (text.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      // A session-setting role installs its scope and reads back the connected role in one statement.
      if (text === installAndReadScopeSql) {
        return Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }]);
      }
      if (text.includes('transaction_timestamp')) {
        return Effect.succeed([{ operation_at: operationAt }]);
      }
      if (text.includes('legal_entities')) {
        return Effect.succeed([{ legalName: 'Example Manufacturing', status: 'active', welcome: null }]);
      }
      return text.includes('current_setting')
        ? Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }])
        : Effect.succeed([]);
    }),
  };
  return makeReadRuntime(
    database,
    openModuleEntrypointGateway,
    { resolve: () => Effect.succeed(scope) },
    {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    },
    { accessDecision, databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT },
  );
});

const runRead = (runtime: Effect.Success<ReturnType<typeof makeRuntime>>, input: LegalEntityDetailInput) =>
  runtime.runRead({
    input,
    principal: scope,
    registration: legalEntityDetailRead,
    transport: { correlationId: scope.correlationId },
  });

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

it.effect('reads the requested company when the caller holds the declaration (O84)', () =>
  Effect.gen(function* allowed() {
    const runtime = yield* makeRuntime(makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } }).bound);
    const result = yield* runRead(runtime, { legalEntityRef });
    expect(result).toEqual({ legalEntityRef, legalName: 'Example Manufacturing', status: 'active' });
  }),
);

it.effect('denies a caller without the declaration and answers a retryable 503 on an unreadable authority (O84)', () =>
  Effect.gen(function* deniedAndUnavailable() {
    const denied = yield* makeRuntime(makeTestBoundAccessGate({ defaultAnswer: { outcome: 'DENIED' } }).bound);
    const deniedExit = yield* Effect.exit(runRead(denied, { legalEntityRef }));
    expect(Schema.is(ReadPermissionDenied)(failureOf(deniedExit))).toBe(true);

    const unreadable = yield* makeRuntime(makeTestBoundAccessGate({ unavailable: true }).bound);
    const unavailableExit = yield* Effect.exit(runRead(unreadable, { legalEntityRef }));
    expect(Schema.is(ReadPermissionUnavailable)(failureOf(unavailableExit))).toBe(true);
  }),
);

it.effect('never resolves another tenant’s company even with the declaration (O84)', () =>
  Effect.gen(function* crossTenant() {
    const runtime = yield* makeRuntime(makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } }).bound);
    const exit = yield* Effect.exit(
      runRead(runtime, { legalEntityRef: { ...legalEntityRef, tenantId: otherTenantId } }),
    );
    expect(Schema.is(ReadHandlerNotFound)(failureOf(exit))).toBe(true);
  }),
);

it.effect('omits the sole-trader name without its field grant while the status and ids stay (O84)', () =>
  Effect.gen(function* fieldGrant() {
    // The parent read is allowed; only the personal-data field group is refused.
    const runtime = yield* makeRuntime(
      makeTestBoundAccessGate({
        answers: {
          'core.identity.legal-entity.personal.read': { outcome: 'DENIED' },
          'core.identity.legal-entity.read': { outcome: 'ALLOWED' },
        },
      }).bound,
    );
    const result = yield* runRead(runtime, { legalEntityRef });
    expect(result).toEqual({ legalEntityRef, status: 'active' });
    expect(result).not.toHaveProperty('legalName');

    // Negative control: with the field grant the name is returned in full.
    const granted = yield* makeRuntime(makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } }).bound);
    expect(yield* runRead(granted, { legalEntityRef })).toEqual({
      legalEntityRef,
      legalName: 'Example Manufacturing',
      status: 'active',
    });
  }),
);
