import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';

import {
  IdentityAdministrationDeniedAudit,
  IdentityAdministrationAuditResultSchema,
  identityAdministrationAuditRead,
  ReadRuntime,
} from '@app/core-runtime';
import type { OperationalScopeRequest, TrustedPrincipalContext } from '@app/core-runtime';
import { Data, Effect, Predicate, Schema } from 'effect';

import {
  AGENT_ADMINISTRATION_DECLARATION,
  agentAdministrationDecision,
  peopleAdministrationDecision,
} from './administration-access.ts';
import { AgentActionRequestIdentity } from './agent-action-request-identity.ts';
import { DemoAccountUnavailable } from './demo-account-unavailable.ts';

export class DemoAccountForbidden extends Data.TaggedError('DemoAccountForbidden')<{ readonly reason: string }> {}

const unavailable = (cause: unknown) => new DemoAccountUnavailable({ cause });
const fromReadError = (cause: { readonly _tag: string }) =>
  Predicate.isTagged(cause, 'ReadPermissionDenied') || Predicate.isTagged(cause, 'OperationContextDenied')
    ? new DemoAccountForbidden({ reason: 'Only a scoped administrator manages people' })
    : unavailable(cause);

export interface DemoAccountCaller {
  readonly legalName: string;
  readonly principal: TrustedPrincipalContext & { readonly legalEntityId: string };
}

/**
 * Agent administration of the selected company: the v2 gate's answer to the declared Agents
 * administration surface (`shell-super-app.access-admin.agents`), never a persona label or job title.
 */
export const requireAdministrator = Effect.fn('DemoAccounts.requireAdministrator')(function* requireAdministrator(
  caller: DemoAccountCaller,
) {
  const decision = yield* agentAdministrationDecision(caller.principal);
  if (decision.outcome === 'UNAVAILABLE') {
    return yield* unavailable('Company administration authorization is temporarily unavailable');
  }
  if (decision.outcome !== 'ALLOWED') {
    return yield* new DemoAccountForbidden({ reason: 'Only a scoped administrator manages agents' });
  }
  return yield* Effect.void;
});

/** Audit scope and member/name lookup belong to the governed Core Read, never to transport-supplied IDs. */
export const auditTrail = Effect.fn('DemoAccounts.auditTrail')(function* auditTrail(
  caller: DemoAccountCaller,
  transport: OperationalScopeRequest,
  subjects: 'agents' | 'people',
) {
  const runtime = yield* ReadRuntime;
  const { entries } = yield* runtime
    .runRead({
      input: { subjects },
      principal: caller.principal,
      registration: identityAdministrationAuditRead,
      transport,
    })
    .pipe(Effect.mapError(fromReadError));
  const wire = yield* Schema.encodeEffect(IdentityAdministrationAuditResultSchema)({ entries }).pipe(
    Effect.mapError(unavailable),
  );
  return wire.entries;
});

/**
 * Safe navigation hint: true exactly when the "Lidé a role" page can load its people in the selected
 * company (`core.identity.people-directory.list`, asked as that read asks it). It reveals no people or
 * role records and changes no list or write authorization.
 */
export const peopleAdministrationCapability = Effect.fn('DemoAccounts.peopleAdministrationCapability')(
  function* peopleAdministrationCapability(caller: Pick<DemoAccountCaller, 'principal'>) {
    const decision = yield* peopleAdministrationDecision(caller.principal);
    return { canManage: decision.outcome === 'ALLOWED' };
  },
);

/** Deterministic IDs per idempotency key, so a retried create replays the same Core Action. */
export const derivedUuid = (seed: string) => {
  const hex = Hex.encode(sha256(utf8ToBytes(seed)));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** A non-administrator's attempt is denied before the Core Action runs; it is still written to the Core audit. */
export const auditForbiddenAttempt = Effect.fn('DemoAccounts.auditForbiddenAttempt')(function* auditForbiddenAttempt(
  caller: DemoAccountCaller,
  operation: string,
  principalKind: 'agent' | null = null,
  targetPrincipalId: string | null = null,
) {
  const transport = yield* AgentActionRequestIdentity;
  const audit = yield* IdentityAdministrationDeniedAudit;
  yield* audit
    .record({
      declaration: AGENT_ADMINISTRATION_DECLARATION,
      operation,
      principal: caller.principal,
      principalKind,
      targetPrincipalId,
      transport,
    })
    .pipe(Effect.mapError(unavailable));
});
