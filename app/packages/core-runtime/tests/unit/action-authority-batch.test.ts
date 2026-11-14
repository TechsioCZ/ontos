import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessDecision } from '../../src/access/decision/contract.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { ActionPermissionCheckError } from '../../src/actions/errors.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeActionAuthorityService } from '../../src/permissions/action-authority.ts';
import type { DeclaredActionAuthority } from '../../src/permissions/action-authority.ts';

const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:action-authority-batch',
    authMethod: 'session',
    legalEntityId: '20000000-0000-4000-8000-000000000001',
    principalId: '30000000-0000-4000-8000-000000000001',
    tenantId: '10000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'action-authority-batch',
};
const now = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-10T12:00:00.000Z'));

const answer = (outcome: AccessDecision['outcome']): AccessDecision => ({
  evidence: [],
  outcome,
  reasons: [{ code: outcome === 'ALLOWED' ? 'allow.granted' : 'deny.insufficient_grant' }],
  selectors: [],
});

const declaredAction = (actionKey: string): DeclaredActionAuthority => ({
  actionKey,
  carrier: {},
  legalEntityScope: 'required',
});

const outcomes: ReadonlyMap<string, AccessDecision['outcome']> = new Map([
  ['work.tasks.apply-command', 'ALLOWED'],
  ['work.tasks.bulk-assign', 'NEEDS_APPROVAL'],
  ['work.tasks.request-search-rebuild', 'DENIED'],
]);
const declared = new Map([...outcomes.keys()].map((actionKey) => [actionKey, declaredAction(actionKey)]));
const actionKeys = [...outcomes.keys(), 'unpublished.action'];

/** A gate that answers only batches: a single decision is a regression to one question at a time. */
const batchGate = (asked: (readonly GateInput[])[], unavailableAt?: number) => ({
  decide: () => Effect.die('An Action batch must not be decided one question at a time'),
  decideMany: (input: readonly GateInput[]) =>
    Effect.sync(() => {
      asked.push(input);
      return input.map((question, index) => {
        expect(question.scope).toBe(scope);
        expect(question.now).toBe(now);
        return answer(index === unavailableAt ? 'UNAVAILABLE' : (outcomes.get(actionKeys[index] ?? '') ?? 'DENIED'));
      });
    }),
});

it.effect('asks every named Action in one gate batch and maps each outcome to its execute and propose answer', () =>
  Effect.gen(function* oneBatch() {
    const asked: (readonly GateInput[])[] = [];
    const authorities = yield* makeActionAuthorityService({
      declared,
      gate: batchGate(asked),
      now,
    }).checkActionAuthorities({ actionKeys, scope });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.map(({ carrier, legalEntityScope }) => [carrier, legalEntityScope])).toEqual([
      [{}, 'required'],
      [{}, 'required'],
      [{}, 'required'],
      // An Action the catalog does not declare is asked with no carrier, so the gate denies it.
      [{}, 'optional'],
    ]);
    expect(authorities).toEqual([
      { actionKey: 'work.tasks.apply-command', execute: 'allowed', propose: 'allowed' },
      { actionKey: 'work.tasks.bulk-assign', execute: 'denied', propose: 'allowed' },
      { actionKey: 'work.tasks.request-search-rebuild', execute: 'denied', propose: 'denied' },
      { actionKey: 'unpublished.action', execute: 'denied', propose: 'denied' },
    ]);
  }),
);

it.effect('fails the whole batch when one answer is unavailable, and when the seam cannot answer a batch', () =>
  Effect.gen(function* unavailableBatch() {
    const unavailable = yield* makeActionAuthorityService({ declared, gate: batchGate([], 1), now })
      .checkActionAuthorities({ actionKeys, scope })
      .pipe(Effect.flip);
    expect(unavailable).toBeInstanceOf(ActionPermissionCheckError);
    const unbatched = yield* makeActionAuthorityService({
      declared,
      gate: { decide: () => Effect.die('Never decided one at a time') },
      now,
    })
      .checkActionAuthorities({ actionKeys, scope })
      .pipe(Effect.flip);
    expect(unbatched).toBeInstanceOf(ActionPermissionCheckError);
  }),
);

it.effect('asks nothing for no Actions', () =>
  Effect.gen(function* emptyBatch() {
    const asked: (readonly GateInput[])[] = [];
    const authorities = yield* makeActionAuthorityService({
      declared,
      gate: batchGate(asked),
      now,
    }).checkActionAuthorities({ actionKeys: [], scope });
    expect(authorities).toEqual([]);
    expect(asked).toEqual([]);
  }),
);
