import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Exit, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { facilitySearchChanged } from '../../src/services/facility-search-projection.ts';
import { scope } from './facility-search-fixtures.ts';

const request = {
  payload: {},
  principal: scope,
  registration: requestSearchRebuildAction,
  transport: { correlationId: 'facility-rebuild-test', idempotencyKey: 'rebuild-1' },
};

it.effect('refreshes every searched agenda mutation, but not unrelated agendas or unattached file uploads', () =>
  Effect.gen(function* refreshTargets() {
    for (const agenda of ['assets', 'security', 'documents', 'meters', 'agenda', 'purchasing', undefined]) {
      const input = agenda === undefined ? { entityIds: [], revision: 1 } : { agenda, entityIds: [], revision: 1 };
      const result = yield* Schema.decodeUnknownEffect(ApplyCommandResultSchema)(input);
      expect(facilitySearchChanged(result)).toBe(
        agenda === 'assets' || agenda === 'security' || agenda === 'documents' || agenda === 'meters',
      );
    }
  }),
);

it.effect('governed rebuild commits one linked event and outbox request and replays idempotently', () =>
  Effect.gen(function* rebuild() {
    const { descriptor } = requestSearchRebuildAction;
    expect(descriptor.actionKey).toBe('facility.operations.request-search-rebuild');
    expect(descriptor.tenantPermission?.({})).toBe('manage_identity');
    expect(descriptor.legalEntityScope).toBe('optional');
    expect(descriptor.entrypoint.authorization).toEqual({ kind: 'action_execution', provisioning: 'explicit' });
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      legalEntityAccess: 'allowed',
      tenantPermission: 'allowed',
    });
    const result = yield* harness.runtime.runAction(request);
    expect(result.status).toBe('QUEUED');
    expect(Predicate.isTagged(yield* Effect.flip(harness.runtime.runAction(request)), 'ActionAlreadyCommitted')).toBe(
      true,
    );
    const { committed } = harness.snapshot();
    expect(committed.length).toBe(1);
    expect(committed[0]?.evidence.domainEvents.length).toBe(1);
    expect(committed[0]?.evidence.outboxMessages.length).toBe(1);
    expect(committed[0]?.evidence.domainEvents[0]?.eventType).toBe('facility.operations.search-rebuild-requested.v1');
    expect(committed[0]?.evidence.outboxMessages[0]?.message.topic).toBe(
      'facility.operations.search-rebuild-requested.v1',
    );
  }),
);

it.effect('requires both explicit Action execution and tenant administration before queueing anything', () =>
  Effect.gen(function* deniedRebuild() {
    for (const permissions of [
      { actionPermission: 'denied', tenantPermission: 'allowed' },
      { actionPermission: 'allowed', tenantPermission: 'denied' },
    ] as const) {
      const harness = yield* makeActionTestHarness({ ...permissions, legalEntityAccess: 'allowed' });
      expect(Exit.isFailure(yield* Effect.exit(harness.runtime.runAction(request)))).toBe(true);
      expect(harness.snapshot().committed).toEqual([]);
    }
  }),
);
