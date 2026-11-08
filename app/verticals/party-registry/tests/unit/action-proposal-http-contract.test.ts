import { ProposalIdSchema } from '@app/core-runtime/access/ids';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { executePrivacyMeasureActionSchemaErrorLive } from '../../api/execute-privacy-measure-action-problems.ts';
import {
  ExecutePrivacyMeasurePayloadSchema,
  ExecutePrivacyMeasureResultSchema,
} from '../../shared/actions/execute-privacy-measure.ts';
import { ExecutePrivacyMeasureActionApi } from '../../shared/apis/execute-privacy-measure-action.ts';

// Exercise the real generated contract with a controlled handler. This proves HTTP encoding,
// not authorization, proposal persistence, or execution of a privacy measure.
it.effect('the generated Action contract returns proposal 202 and preserves ordinary result 200', () =>
  Effect.gen(function* realGeneratedProposalContract() {
    const payload = ExecutePrivacyMeasurePayloadSchema.make({
      handoff: {
        contentScopeRefs: ['party.registry.counterparty.lifecycle'],
        controllerObligationRef: 'obligation:1',
        dispositionDecision: 'RESTRICT',
        expectedEvidenceRefs: ['party.registry.counterparty.archived'],
        idempotencyKey: 'party-privacy-measure:1',
        kind: 'RESTRICT',
        measureId: 'measure:1',
        owningCapability: 'party.registry',
        preconditionRefs: ['decision:1'],
        requestedAt: '2026-09-14T10:00:00.000Z',
        requestedResult: 'RESTRICTED',
        resourceRefs: ['party.registry|party.registry.counterparty|company:1|counterparty:1'],
        right: null,
        sourceDecisionRef: 'decision:1',
        sourceDecisionRevision: 1,
        subjectRef: 'subject:1',
        taskId: 'task:1',
        tenantId: '10000000-0000-4000-8000-000000000001',
      },
    });
    const ordinary = ExecutePrivacyMeasureResultSchema.make({
      attempt: 1,
      evidenceRefs: ['evidence:1'],
      idempotencyKey: payload.handoff.idempotencyKey,
      includedResourceRefs: payload.handoff.resourceRefs,
      measureId: payload.handoff.measureId,
      occurredAt: '2026-09-14T10:01:00.000Z',
      outcomeId: 'outcome:1',
      owningCapability: 'party.registry',
      reason: 'Test transport result',
      recordedAt: '2026-09-14T10:01:00.000Z',
      remainingResourceRefs: [],
      sourceDecisionRef: payload.handoff.sourceDecisionRef,
      sourceDecisionRevision: payload.handoff.sourceDecisionRevision,
      status: 'SUCCEEDED',
      taskId: payload.handoff.taskId,
    });
    const accepted = ActionProposalAcceptedSchema.make({
      _tag: 'ActionProposalAccepted',
      expiresAt: DateTime.makeUnsafe('2035-01-01T12:00:00.000Z'),
      proposalId: ProposalIdSchema.make('10000000-0000-4000-8000-000000000001'),
    });
    const handlers = HttpApiBuilder.group(ExecutePrivacyMeasureActionApi, 'executePrivacyMeasureAction', (group) =>
      group.handle('execute', ({ request }) =>
        Effect.succeed(request.headers['x-action-intent'] === 'propose' ? accepted : ordinary),
      ),
    ).pipe(Layer.provide(executePrivacyMeasureActionSchemaErrorLive));
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(ExecutePrivacyMeasureActionApi).pipe(
            Layer.provide(handlers),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ExecutePrivacyMeasurePayloadSchema))(payload);
    const responseFor = (intent?: 'propose') =>
      Effect.promise(() =>
        server.handler(
          new Request('https://fixture.ontos.test/party-registry/actions/execute-privacy-measure', {
            body,
            headers:
              intent === undefined
                ? { 'content-type': 'application/json' }
                : { 'content-type': 'application/json', 'x-action-intent': intent },
            method: 'POST',
          }),
          Context.empty(),
        ),
      );

    const proposalResponse = yield* responseFor('propose');
    expect(proposalResponse.status).toBe(202);
    expect(proposalResponse.headers.get('content-type')).toContain('application/json');
    const proposalBody: unknown = yield* Effect.promise(() => proposalResponse.json());
    const encodedAccepted = yield* Schema.encodeEffect(ActionProposalAcceptedSchema)(accepted);
    expect(proposalBody).toEqual(encodedAccepted);
    // The execution-only worker's result decoder must not accept a parked receipt as an outcome.
    expect(Schema.is(ExecutePrivacyMeasureResultSchema)(proposalBody)).toBe(false);

    const ordinaryResponse = yield* responseFor();
    expect(ordinaryResponse.status).toBe(200);
    const ordinaryBody: unknown = yield* Effect.promise(() => ordinaryResponse.json());
    const encodedOrdinary = yield* Schema.encodeEffect(ExecutePrivacyMeasureResultSchema)(ordinary);
    expect(ordinaryBody).toEqual(encodedOrdinary);
  }),
);
