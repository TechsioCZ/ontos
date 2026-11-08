import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { facilitySearchChanged } from '../../src/services/facility-search-projection.ts';
import { facilityOperationsRegistration } from '../../vertical.registration.ts';
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
    expect(descriptor.accessDeclaration).toMatchObject({
      key: 'facility.operations.request-search-rebuild.write',
      kind: 'action',
      selectors: [],
    });
    expect(descriptor.legalEntityScope).toBe('optional');
    expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    const harness = yield* makeActionTestHarness({
      access: { 'facility.operations.request-search-rebuild.write': 'allowed' },
      ownerRegistration: facilityOperationsRegistration,
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

for (const access of ['denied', 'unavailable'] as const) {
  it.effect(`${access} rebuild capability queues no event or message`, () =>
    Effect.gen(function* deniedRebuild() {
      const harness = yield* makeActionTestHarness({
        access: { 'facility.operations.request-search-rebuild.write': access },
        ownerRegistration: facilityOperationsRegistration,
      });
      expect(
        Predicate.isTagged(
          yield* harness.runtime.runAction(request).pipe(Effect.flip),
          access === 'denied' ? 'ActionPermissionDenied' : 'ActionPermissionCheckError',
        ),
      ).toBe(true);
      expect(harness.snapshot().transactionCount).toBe(0);
      expect(harness.snapshot().committed).toEqual([]);
    }),
  );
}
