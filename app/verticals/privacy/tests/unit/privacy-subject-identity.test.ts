import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { createPrivacySubjectAction } from '../../src/actions/create-privacy-subject.action.ts';
import {
  createPrivacySubjectActionSchemaErrorLive,
  mapCreatePrivacySubjectActionProblem,
} from '../../api/create-privacy-subject-action-problems.ts';
import { CreatePrivacySubjectPayloadSchema } from '../../shared/actions/privacy-operations.ts';
import {
  CreatePrivacySubjectActionApi,
  CreatePrivacySubjectActionInvalidProblemSchema,
  CreatePrivacySubjectActionIneligibleProblemSchema,
} from '../../shared/apis/create-privacy-subject-action.ts';
import { privacySubjectRefForParty } from '../../shared/domain/privacy-subject-identity.ts';

const partyRef = {
  moduleId: 'party.registry',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'party.registry.party',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;
const subject = { kind: 'DATA_SUBJECT', partyRef } as const;

it('derives a stable Privacy UUID from the typed external Party reference, separated by tenant and Party', () => {
  const reference = privacySubjectRefForParty(partyRef);
  expect(reference.resourceId).toBe('374faba0-92e0-8be4-a47b-5c7a1f5ba7f9');
  expect(reference).toEqual(privacySubjectRefForParty({ ...partyRef }));
  expect(reference.resourceId).not.toBe(partyRef.resourceId);
  expect(reference.resourceId).not.toBe(
    privacySubjectRefForParty({ ...partyRef, resourceId: 'another-party' }).resourceId,
  );
  expect(reference.resourceId).not.toBe(
    privacySubjectRefForParty({
      ...partyRef,
      tenantId: '33333333-3333-4333-8333-333333333333',
    }).resourceId,
  );
  expect(
    Result.isSuccess(Schema.decodeUnknownResult(CreatePrivacySubjectPayloadSchema)({ subject, subjectRef: reference })),
  ).toBe(true);
});

it.effect('rejects malformed subject IDs as typed HTTP 400 before the Action or database is invoked', () =>
  Effect.gen(function* malformedSubjectHttp() {
    const handlers = HttpApiBuilder.group(CreatePrivacySubjectActionApi, 'createPrivacySubjectAction', (routes) =>
      routes.handle('execute', () => Effect.die('Invalid subject ID reached Action execution')),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(CreatePrivacySubjectActionApi).pipe(
            Layer.provide(handlers),
            Layer.provide(createPrivacySubjectActionSchemaErrorLive),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
    );
    for (const resourceId of [`retail-party:${partyRef.resourceId}`, 'not-a-uuid', '']) {
      const payload = { subject, subjectRef: { ...privacySubjectRefForParty(partyRef), resourceId } };
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(payload);
      const response = yield* Effect.promise(() =>
        runtime.handler(
          new Request('https://privacy.example/privacy/actions/create-privacy-subject', {
            body,
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }),
        ),
      );
      expect(response.status).toBe(400);
      const problem = yield* Effect.promise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CreatePrivacySubjectActionInvalidProblemSchema)),
      );
      expect(Schema.is(CreatePrivacySubjectActionInvalidProblemSchema)(problem)).toBe(true);
      expect(problem.status).toBe(400);
    }
  }),
);

it.layer(NodeCrypto.layer)('Privacy Subject exact Party identity admission', (suite) => {
  suite.effect('rejects an unrelated well-formed UUID as 422 before owner SQL or persistence', () =>
    Effect.gen(function* rejectUnrelatedSubjectIdentity() {
      const harness = yield* makeActionTestHarness({ actionPermission: 'allowed' });
      const payload = Schema.decodeSync(CreatePrivacySubjectPayloadSchema)({
        subject,
        subjectRef: { ...privacySubjectRefForParty(partyRef), resourceId: '44444444-4444-4444-8444-444444444444' },
      });
      const error = yield* harness.runtime
        .runAction({
          audience: 'privacy',
          payload,
          principal: Schema.decodeSync(TrustedPrincipalContextSchema)({
            authBindingId: '77777777-7777-4777-8777-777777777777',
            authContextRef: 'api-key:subject-identity-unit',
            authMethod: 'api_key',
            legalEntityId: '55555555-5555-4555-8555-555555555555',
            principalId: '66666666-6666-4666-8666-666666666666',
            tenantId: partyRef.tenantId,
          }),
          registration: createPrivacySubjectAction,
          transport: { correlationId: 'subject-identity-rejection', idempotencyKey: 'subject-identity-rejection' },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ code: 'privacy_action_rejected' });
      const problem = mapCreatePrivacySubjectActionProblem(error);
      expect(Schema.is(CreatePrivacySubjectActionIneligibleProblemSchema)(problem)).toBe(true);
      expect(problem.status).toBe(422);
      expect(harness.snapshot().transactionCount).toBe(0);
      expect(harness.snapshot().committed).toEqual([]);
    }),
  );
});
