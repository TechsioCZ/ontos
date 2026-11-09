import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { GateInput } from '@app/core-runtime/access/enforcement';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { inertAccessEnforcementPorts } from '@app/core-runtime/testing/access-gate';
import { DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessDecisionUnavailable } from '../../../../packages/core-runtime/src/access/decision/errors.ts';
import type { AccessAuthorityCurrentness } from '../../../../packages/core-runtime/src/access/enforcement/currentness.ts';
import { decodeAccessDeclarationOrThrow } from '../../../../packages/core-runtime/src/authorization/access-declaration.ts';
import { bindAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import type {
  AccessEnforcementPorts,
  BoundAccessGate,
  PreparedAccessDecision,
} from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import { partyTestAccessGate } from '../support/party-test-access-gate.ts';

/**
 * The Party test gate must drive the same `prepare` path a production Action takes. Currentness is the
 * one port scripted here, as a Ready persisted revision; the decision itself comes from the Party gate's
 * own script. The negative cases prove the gate is not weakened: a gate or ports without the contract
 * still fail closed.
 */

const CAPABILITY = 'party.registry.party.create';

const scope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000012',
    authContextRef: 'better-auth-session:party-test-access-gate',
    authMethod: 'session',
    principalId: '00000000-0000-4000-8000-000000000013',
    tenantId: '00000000-0000-4000-8000-000000000014',
  }),
  correlationId: 'party-test-access-gate',
});

const declaration = decodeAccessDeclarationOrThrow(
  {
    key: CAPABILITY,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    placement: { group: 'party', level: 'extended' },
    risk: 'sensitive',
    selectors: [],
  },
  { access: 'write', authorization: { kind: 'protected' }, moduleKey: 'party.registry', role: 'action' },
);

const gateInput: GateInput = {
  carrier: { accessDeclaration: declaration },
  legalEntityScope: 'forbidden',
  now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-09T12:00:00.000Z')),
  scope,
};

/** The persisted revision a Ready tenant authority reports: the one scope, at revision 1. */
const readyCurrentness: AccessAuthorityCurrentness = {
  read: () => Effect.succeed([Object.freeze({ revision: 1, scopeId: 'tenant-context-scope' })]),
};

const ports: AccessEnforcementPorts = { ...inertAccessEnforcementPorts(), currentness: readyCurrentness };

const prepareOf = (bound: BoundAccessGate): Effect.Effect<PreparedAccessDecision, AccessDecisionUnavailable> =>
  bound.prepare === undefined
    ? Effect.die('A gate bound with currentness must expose prepare')
    : bound.prepare(gateInput);

/** One Party test gate for the suite, so the revoke and restore calls reach the layer's own answers. */
const control = partyTestAccessGate();

it.layer(control.layer)('the Party test gate through the production prepare path', (suite) => {
  suite.effect('prepares the Party gate answer as ALLOWED', () =>
    Effect.gen(function* allowedPrepare() {
      const gate = yield* AccessDecisionGate;
      const prepared = yield* prepareOf(bindAccessGate(gate, ports));
      expect(prepared.decision.outcome).toBe('ALLOWED');
    }),
  );

  suite.effect('refuses a revoked capability through the same prepared path, then restores it', () =>
    Effect.gen(function* deniedPrepare() {
      const gate = yield* AccessDecisionGate;
      const bound = bindAccessGate(gate, ports);
      control.revoke('party.registry.party');
      expect((yield* prepareOf(bound)).decision.outcome).toBe('DENIED');
      control.restore('party.registry.party');
      expect((yield* prepareOf(bound)).decision.outcome).toBe('ALLOWED');
    }),
  );

  suite.effect('still fails closed when the gate states no rebind', () =>
    Effect.gen(function* withoutRebind() {
      const gate = yield* AccessDecisionGate;
      const bare = {
        decide: gate.decide,
        decideMany: gate.decideMany,
        list: gate.list,
        selectableLegalEntities: gate.selectableLegalEntities,
      };
      const outcome = yield* Effect.result(prepareOf(bindAccessGate(bare, ports)));
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );

  suite.effect('still fails closed when the intent cannot join the caller transaction', () =>
    Effect.gen(function* withoutJoin() {
      const gate = yield* AccessDecisionGate;
      const unjoined: AccessEnforcementPorts = {
        ...ports,
        intent: { authorityFor: ports.intent.authorityFor },
      };
      const outcome = yield* Effect.result(prepareOf(bindAccessGate(gate, unjoined)));
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );
});
