import { ActionPermissionDenied } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { activateTemplateRevisionAction } from '../../src/actions/activate-template-revision.action.ts';
import { deactivateTemplateRevisionAction } from '../../src/actions/deactivate-template-revision.action.ts';
import { invalidateTemplateRevisionAction } from '../../src/actions/invalidate-template-revision.action.ts';
import { prepareTemplateRevisionAction } from '../../src/actions/prepare-template-revision.action.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { domainFor, fictionalDraft, identity, revisionIdOf } from '../support/template-fixtures.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principal = {
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'better-auth-session:communications-template-actions',
  authMethod: 'session' as const,
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
};
const transport = (key: string) => ({ correlationId: key, idempotencyKey: key });

const makeHarness = (access: 'allowed' | 'denied') => {
  const memory = makeInMemoryTemplatePort();
  return Effect.gen(function* harnessEffect() {
    const harness = yield* makeActionTestHarness({
      access,
      ownerRegistration: communicationsRegistration,
      services: [
        bindActionTestServices(prepareTemplateRevisionAction, memory.port),
        bindActionTestServices(activateTemplateRevisionAction, memory.port),
        bindActionTestServices(deactivateTemplateRevisionAction, memory.port),
        bindActionTestServices(invalidateTemplateRevisionAction, memory.port),
      ],
    });
    return { harness, memory };
  });
};

describe('Template revision Actions through the Core Action runtime', () => {
  it.effect('[AC-01 S01 S02] one permitted administrator prepares, activates, deactivates and invalidates', () =>
    Effect.gen(function* permitted() {
      const { harness, memory } = yield* makeHarness('allowed');
      const { runtime } = harness;
      const prepared = yield* runtime.runAction({
        payload: fictionalDraft(),
        principal,
        registration: prepareTemplateRevisionAction,
        transport: transport('prepare-1'),
      });
      expect(prepared.revisionNumber).toBe(1);
      const activated = yield* runtime.runAction({
        payload: { reason: 'Fictional approval', revisionId: prepared.revisionId },
        principal,
        registration: activateTemplateRevisionAction,
        transport: transport('activate-1'),
      });
      expect(activated.revisionNumber).toBe(1);
      expect(activated.replacedRevisionId).toBeUndefined();
      expect(memory.state.activations).toHaveLength(1);
      expect(memory.state.activations[0]?.activatedByPrincipalId).toBe(principal.principalId);
      const deactivated = yield* runtime.runAction({
        payload: { reason: 'Fictional retirement', revisionId: prepared.revisionId },
        principal,
        registration: deactivateTemplateRevisionAction,
        transport: transport('deactivate-1'),
      });
      expect(deactivated.activationId).toBe(activated.activationId);
      const invalidated = yield* runtime.runAction({
        payload: { reason: 'Fictional unsafe wording', revisionId: prepared.revisionId },
        principal,
        registration: invalidateTemplateRevisionAction,
        transport: transport('invalidate-1'),
      });
      expect(invalidated.endedActivationId).toBeUndefined();
      expect(memory.state.invalidations).toHaveLength(1);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    '[S03 AC-01] an unauthorized attempt is denied by the Core gate: nothing is activated, the current revision stays',
    () =>
      Effect.gen(function* denied() {
        const { harness, memory } = yield* makeHarness('denied');
        const t = domainFor(memory.port);
        const current = (yield* t.prepare(fictionalDraft())).revision;
        const candidate = (yield* t.prepare(fictionalDraft({ body: '[FICTIONAL TEST COPY] candidate {{purpose}}' })))
          .revision;
        yield* t.approve(current.revisionId);
        const before = memory.state.activations.map((found) => found.activationId);
        const failure = yield* harness.runtime
          .runAction({
            payload: {
              reason: 'Fictional attempt by an unauthorized actor',
              revisionId: revisionIdOf(candidate.revisionId),
            },
            principal,
            registration: activateTemplateRevisionAction,
            transport: transport('activate-denied'),
          })
          .pipe(Effect.flip);
        expect(Schema.is(ActionPermissionDenied)(failure)).toBe(true);
        expect(memory.state.activations.map((found) => found.activationId)).toEqual(before);
        expect((yield* t.resolve(identity())).revisionId).toBe(current.revisionId);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
