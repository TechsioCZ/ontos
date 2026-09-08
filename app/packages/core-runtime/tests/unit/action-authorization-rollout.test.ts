import { Effect, Schema } from 'effect';
import { expect, it } from '@app/effect-rstest';
import { decideAuthorizationRollout } from '../../src/authorization/rollout-decision.ts';
import type { AuthorizationWouldDenyEvent } from '../../src/authorization/rollout-decision.ts';

const now = Date.parse('2026-09-10T00:00:00.000Z');
const contract = {
  activatedAtEpochMs: Date.parse('2026-09-01T00:00:00.000Z'),
  compatibilityEntrypoints: new Set(['contacts.create-contact']),
  expiresAtEpochMs: Date.parse('2026-10-01T00:00:00.000Z'),
  inventoryHash: 'inventory-hash',
  mode: 'report_only' as const,
  sourceRevision: 'source-revision',
};

const input = {
  candidate: 'denied' as const,
  current: 'allowed' as const,
  denialReason: 'missing_policy' as const,
  entrypointKey: 'contacts.create-contact',
  nowEpochMs: now,
  policyClass: 'action_execution',
  surface: 'action' as const,
};

it.effect(
  'active, baselined report-only compatibility preserves only missing-policy behavior',
  () =>
    Effect.gen(function* authorizationRollout() {
      const events: AuthorizationWouldDenyEvent[] = [];
      expect(
        decideAuthorizationRollout(input, {
          contract,
          emit: (event) => {
            events.push(event);
          },
        }),
      ).toBe('allowed');
      expect(events).toEqual([
        {
          denialReason: 'missing_policy',
          entrypointKey: 'contacts.create-contact',
          inventoryHash: 'inventory-hash',
          policyClass: 'action_execution',
          schemaVersion: 1,
          sourceRevision: 'source-revision',
          surface: 'action',
          timestamp: '2026-09-10T00:00:00.000Z',
          type: 'authorization.would_deny',
        },
      ]);
      expect(
        (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(events)).includes(
          'principal',
        ),
      ).toBe(false);
      expect(
        (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(events)).includes(
          'tenant',
        ),
      ).toBe(false);
    }),
);

it('enforced, expired, and unbaselined entrypoints deny without evidence', () => {
  for (const changed of [
    { contract: { ...contract, mode: 'enforced' as const }, input },
    { contract, input: { ...input, nowEpochMs: contract.expiresAtEpochMs } },
    { contract, input: { ...input, entrypointKey: 'contacts.new-action' } },
  ]) {
    const events: AuthorizationWouldDenyEvent[] = [];
    expect(
      decideAuthorizationRollout(changed.input, {
        contract: changed.contract,
        emit: (event) => {
          events.push(event);
        },
      }),
    ).toBe('denied');
    expect(events).toEqual([]);
  }
});

it('a candidate allow never broadens a denial from the current authorization path', () => {
  expect(
    decideAuthorizationRollout(
      { ...input, candidate: 'allowed', current: 'denied' },
      {
        contract,
        emit: () => {
          expect.unreachable();
        },
      },
    ),
  ).toBe('denied');
});

it('all protected surfaces keep credential, tenancy, module, replay, and infrastructure failures non-bypassable', () => {
  for (const surface of ['action', 'capability_issuance', 'route', 'worker'] as const) {
    for (const denialReason of [
      'cross_tenant',
      'expired_credential',
      'infrastructure_unavailable',
      'malformed_credential',
      'module_disabled',
      'replayed_credential',
      'wrong_audience',
    ] as const) {
      expect(
        decideAuthorizationRollout(
          { ...input, denialReason, surface },
          {
            contract,
            emit: () => {
              expect.unreachable();
            },
          },
        ),
      ).toBe('denied');
    }
  }
});
