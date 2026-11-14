import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { expect, it } from 'effect-rstest';

import {
  OWNER_ACTION_APPROVAL_PATH,
  OWNER_ACTION_APPROVAL_INSPECTION_PATH,
  OwnerActionApprovalApi,
  OwnerActionApprovalRequestSchema,
} from '@app/core-runtime/access/approvals/owner-api';
import {
  makeOwnerActionApproveHandler,
  makeOwnerActionInspectHandler,
  OwnerActionApprovalSchemaErrorLive,
} from '@app/core-runtime/access/approvals/owner-http';
import { OwnerActionApprovals, OwnerActionApprovalError } from '@app/core-runtime/access/approvals/owner-runtime';
import type { OwnerActionApprovalsService } from '@app/core-runtime/access/approvals/owner-runtime';
import {
  OperationPrincipalVerificationErrorSchema,
  makeMicroverticalHttpPrincipalAuthentication,
} from '../../src/http/principal-authentication.ts';
import { AccessScopeIdSchema, CommandDigestSchema, ModuleKeySchema, ProposalIdSchema } from '../../src/access/ids.ts';
import { principal } from '../support/action-command-v2.ts';

const request = OwnerActionApprovalRequestSchema.make({
  compositionRevision: 'a'.repeat(64),
  expectedCommandDigest: CommandDigestSchema.make('b'.repeat(64)),
  expectedOwner: {
    deployment: { appId: 'owner-test', buildMarker: 'build-1' },
    moduleKey: ModuleKeySchema.make('demo.governing-read'),
  },
  expectedStatus: 'pending',
  proposalId: ProposalIdSchema.make('00000000-0000-4000-8000-000000000010'),
  scopeId: AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000011'),
});
const encode = Schema.encodeSync(OwnerActionApprovalRequestSchema);
const requestBody = Schema.encodeSync(Schema.fromJsonString(OwnerActionApprovalRequestSchema))(request);
const extraBody = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...OwnerActionApprovalRequestSchema.fields,
      payload: Schema.Struct({ salary: Schema.Number }),
    }),
  ),
)({ ...request, payload: { salary: 500 } });
const verificationFailure = (_tag: (typeof OperationPrincipalVerificationErrorSchema.Type)['_tag']) =>
  Schema.decodeUnknownEffect(OperationPrincipalVerificationErrorSchema)({
    _tag,
    reason: 'private verification diagnostic',
  }).pipe(Effect.orDie, Effect.flatMap(Effect.fail));

class AuthenticationFixture extends Context.Service<AuthenticationFixture, { readonly credential: string }>()(
  '@app/core-runtime/tests/unit/owner-action-approval-api.test/AuthenticationFixture',
) {}

const receivingPrefix = '/receiving-owner' as const;
const unrelatedGroup = HttpApiGroup.make('unrelated').add(
  HttpApiEndpoint.get('status', '/status', { success: Schema.String }),
);
const receivingApi = HttpApi.make('ReceivingOwnerApprovalApi')
  .add(unrelatedGroup)
  .addHttpApi(OwnerActionApprovalApi)
  .prefix(receivingPrefix);

// Compile-only controls. These unsupported definitions must never reach Layer construction.
const unsupportedReceivingApiBindings = () => {
  const authenticate = makeMicroverticalHttpPrincipalAuthentication(() => Effect.succeed(principal));
  const missing = HttpApi.make('MissingOwnerApprovalApi');
  const wrong = HttpApi.make('WrongOwnerApprovalApi').add(
    HttpApiGroup.make('ownerActionApprovals').add(
      HttpApiEndpoint.get('unrelated', '/unrelated', { success: Schema.String }),
    ),
  );
  // @ts-expect-error The receiving API must contain the actual owner approval group.
  HttpApiBuilder.group(missing, 'ownerActionApprovals', (group) => group);
  HttpApiBuilder.group(wrong, 'ownerActionApprovals', (group) =>
    // @ts-expect-error A group name alone cannot substitute for the original endpoint contracts.
    group.handle('approve', makeOwnerActionApproveHandler(authenticate)),
  );
};

const mount = (
  service: Pick<OwnerActionApprovalsService, 'approve'> & Partial<Pick<OwnerActionApprovalsService, 'inspect'>>,
) =>
  Effect.gen(function* mountActualContract() {
    let redemptions = 0;
    const verifierServices = Layer.succeed(AuthenticationFixture, { credential: 'Bearer valid' });
    const ownerServices = Layer.succeed(OwnerActionApprovals, {
      inspect: () => Effect.die('Inspection was not scripted by this HTTP-only fixture'),
      ...service,
    });
    const authenticate = makeMicroverticalHttpPrincipalAuthentication((authorization) =>
      Effect.gen(function* verifyOriginalRequest() {
        const verifier = yield* AuthenticationFixture;
        if (Redacted.value(authorization) === 'Bearer unavailable') {
          return yield* verificationFailure('ActionPrincipalUnavailableError');
        }
        if (Redacted.value(authorization) !== verifier.credential) {
          return yield* verificationFailure('ActionPrincipalInvalidError');
        }
        redemptions += 1;
        // HTTP-only fixture: verification is scripted. The real provider separately refuses an
        // unsealed context; this stub cannot supply a production approval or a prepared authority.
        return principal;
      }),
    );
    const handlers = HttpApiBuilder.group(receivingApi, 'ownerActionApprovals', (group) =>
      group
        .handle('approve', makeOwnerActionApproveHandler(authenticate))
        .handle('inspect', makeOwnerActionInspectHandler(authenticate)),
    ).pipe(
      Layer.provide(OwnerActionApprovalSchemaErrorLive),
      Layer.provide(ownerServices),
      Layer.provide(verifierServices),
    );
    // This root-composition type proof refuses a residual schema middleware, owner service or
    // authentication request port. Runtime HTTP assertions alone cannot prove a closed Layer.
    const closedHandlers: Layer.Layer<HttpApiGroup.Service<'ReceivingOwnerApprovalApi', 'ownerActionApprovals'>> =
      handlers.pipe(HttpRouter.provideRequest(Layer.merge(verifierServices, ownerServices)));
    const unrelatedHandlers = HttpApiBuilder.group(receivingApi, 'unrelated', (group) =>
      group.handle('status', () => Effect.succeed('ok')),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(receivingApi).pipe(
            Layer.provide(closedHandlers),
            Layer.provide(unrelatedHandlers),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    return {
      redemptions: () => redemptions,
      send: (
        body: string,
        authorization = 'Bearer valid',
        correlationId = 'owner-approval-http',
        path:
          | typeof OWNER_ACTION_APPROVAL_PATH
          | typeof OWNER_ACTION_APPROVAL_INSPECTION_PATH = OWNER_ACTION_APPROVAL_PATH,
      ) =>
        Effect.promise(() =>
          server.handler(
            new Request(`https://owner.ontos.test${receivingPrefix}${path}`, {
              body,
              headers: { authorization, 'content-type': 'application/json', 'x-correlation-id': correlationId },
              method: 'POST',
            }),
            Context.empty(),
          ),
        ),
      sendUnprefixed: () =>
        Effect.promise(() =>
          server.handler(
            new Request(`https://owner.ontos.test${OWNER_ACTION_APPROVAL_PATH}`, {
              body: requestBody,
              headers: {
                authorization: 'Bearer valid',
                'content-type': 'application/json',
                'x-correlation-id': 'owner-approval-http',
              },
              method: 'POST',
            }),
            Context.empty(),
          ),
        ),
    };
  });

it.effect('binds the combined receiving API identity and prefix without registering the unprefixed route', () =>
  Effect.gen(function* actualReceivingApi() {
    expect(unsupportedReceivingApiBindings).toBeTypeOf('function');
    for (const name of ['approve', 'inspect'] as const) {
      const original = OwnerActionApprovalApi.groups.ownerActionApprovals.endpoints[name];
      const receiving = receivingApi.groups.ownerActionApprovals.endpoints[name];
      expect(receiving.path).toBe(`${receivingPrefix}${original.path}`);
      expect(receiving.payload).toBe(original.payload);
      expect(receiving.success).toBe(original.success);
      expect(receiving.error).toBe(original.error);
      expect(receiving.middlewares).toBe(original.middlewares);
    }
    let approvals = 0;
    const server = yield* mount({
      approve: () =>
        Effect.sync(() => {
          approvals += 1;
          return { proposalId: request.proposalId, status: 'approved' as const };
        }),
    });
    expect((yield* server.sendUnprefixed()).status).toBe(404);
    expect(server.redemptions()).toBe(0);
    expect(approvals).toBe(0);
    expect((yield* server.send(requestBody)).status).toBe(200);
    expect(server.redemptions()).toBe(1);
    expect(approvals).toBe(1);
  }),
);

it.effect('the published approval request has only immutable receiving-release and pending-command preconditions', () =>
  Effect.gen(function* strictContract() {
    expect(yield* Schema.decodeUnknownEffect(OwnerActionApprovalRequestSchema)(encode(request))).toEqual(request);
    for (const extra of [
      { payload: { salary: 500 } },
      { principal },
      { actionAuthority: {} },
      { targets: [] },
      { approverId: principal.principalId },
      { policy: { selfApproval: 'permitted' } },
    ]) {
      const result = yield* Schema.decodeUnknownEffect(OwnerActionApprovalRequestSchema, { onExcessProperty: 'error' })(
        {
          ...encode(request),
          ...extra,
        },
      ).pipe(Effect.result);
      expect(result).toHaveProperty('failure');
    }
    for (const expectedStatus of ['approved', 'executed', 'lapsed']) {
      expect(Schema.is(OwnerActionApprovalRequestSchema)({ ...request, expectedStatus })).toBe(false);
    }
  }),
);

it.effect('the actual mounted contract authenticates first and serializes only the safe approval acknowledgement', () =>
  Effect.gen(function* safeAcknowledgement() {
    let calls = 0;
    const server = yield* mount({
      approve: (input) =>
        Effect.sync(() => {
          expect(input.principal).toBe(principal);
          expect(input.request).toEqual(request);
          expect(input.requestHeaders).toEqual({ 'x-correlation-id': 'owner-approval-http' });
          calls += 1;
          return {
            actionAuthority: { secret: 'never-expose' },
            payload: { salary: 500 },
            proposalId: request.proposalId,
            status: 'approved' as const,
          };
        }),
    });
    const response = yield* server.send(requestBody);
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({
      proposalId: request.proposalId,
      status: 'approved',
    });
    expect(server.redemptions()).toBe(1);
    expect(calls).toBe(1);
  }),
);

for (const [credential, status] of [
  ['Bearer invalid', 401],
  ['Bearer unavailable', 503],
] as const) {
  it.effect(`the actual authentication adapter returns safe ${status} before the owner service`, () =>
    Effect.gen(function* authenticationRefusal() {
      const server = yield* mount({ approve: () => Effect.die('An unauthenticated request must not reach approval') });
      const response = yield* server.send(requestBody, credential);
      expect(response.status).toBe(status);
      expect(response.headers.get('www-authenticate')).toBe(status === 401 ? 'Bearer' : null);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      const body = yield* Effect.promise(() => response.text());
      expect(body).not.toContain('private verification diagnostic');
      expect(server.redemptions()).toBe(0);
    }),
  );
}

for (const [code, status] of [
  ['approval_refused', 403],
  ['approval_conflict', 409],
  ['approval_unavailable', 503],
  ['authentication_required', 401],
] as const) {
  it.effect(`the mounted owner failure ${code} retains its declared safe HTTP ${status}`, () =>
    Effect.gen(function* ownerFailure() {
      const failure = Object.defineProperty(new OwnerActionApprovalError({ code }), 'cause', {
        value: { privatePayload: 'do-not-return', privateProof: 'do-not-return' },
      });
      const server = yield* mount({ approve: () => Effect.fail(failure) });
      const response = yield* server.send(requestBody);
      expect(response.status).toBe(status);
      expect(response.headers.get('www-authenticate')).toBe(status === 401 ? 'Bearer' : null);
      const body = yield* Effect.promise(() => response.text());
      expect(body).not.toContain('do-not-return');
      expect(body).not.toContain('privateProof');
    }),
  );
}

it.effect('malformed/extra command input and invalid correlation fail before the owner approval service', () =>
  Effect.gen(function* invalidInput() {
    const server = yield* mount({ approve: () => Effect.die('Invalid input must not reach approval') });
    for (const body of ['{}', '{"payload":{}}', extraBody]) {
      expect((yield* server.send(body)).status).toBe(400);
    }
    expect((yield* server.send(requestBody, 'Bearer valid', '')).status).toBe(400);
  }),
);

it.effect('unexpected owner defects become safe typed HTTP 500 rather than exposing a cause or command', () =>
  Effect.gen(function* safeDefect() {
    const server = yield* mount({ approve: () => Effect.die('private-command-and-proof') });
    const response = yield* server.send(requestBody);
    expect(response.status).toBe(500);
    expect(yield* Effect.promise(() => response.text())).not.toContain('private-command-and-proof');
  }),
);

for (const canApprove of [true, false]) {
  it.effect(`inspection projects only the authenticated canApprove=${canApprove} observation and cannot approve`, () =>
    Effect.gen(function* safeInspection() {
      let inspections = 0;
      const server = yield* mount({
        approve: () => Effect.die('Inspection must not approve'),
        inspect: (input) =>
          Effect.sync(() => {
            expect(input.principal).toBe(principal);
            expect(input.request).toEqual(request);
            inspections += 1;
            return {
              canApprove,
              privateProof: 'do-not-return',
              proposalId: request.proposalId,
              status: 'approved',
            };
          }),
      });
      const response = yield* server.send(
        requestBody,
        'Bearer valid',
        'owner-approval-http',
        OWNER_ACTION_APPROVAL_INSPECTION_PATH,
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ canApprove, proposalId: request.proposalId });
      expect(server.redemptions()).toBe(1);
      expect(inspections).toBe(1);
    }),
  );
}

it.effect(
  'inspection authenticates and refuses malformed preconditions; unavailable authority is never eligibility',
  () =>
    Effect.gen(function* unavailableInspection() {
      let inspections = 0;
      const server = yield* mount({
        approve: () => Effect.die('Inspection must not approve'),
        inspect: () => {
          inspections += 1;
          return Effect.fail(new OwnerActionApprovalError({ code: 'approval_unavailable' }));
        },
      });
      const sendInspection = (body: string, authorization = 'Bearer valid') =>
        server.send(body, authorization, 'owner-approval-http', OWNER_ACTION_APPROVAL_INSPECTION_PATH);
      expect((yield* sendInspection(requestBody, 'Bearer invalid')).status).toBe(401);
      expect((yield* sendInspection('{}')).status).toBe(400);
      expect((yield* sendInspection(extraBody)).status).toBe(400);
      expect(inspections).toBe(0);
      const response = yield* sendInspection(requestBody);
      expect(response.status).toBe(503);
      expect(yield* Effect.promise(() => response.text())).not.toContain('canApprove');
      expect(inspections).toBe(1);
    }),
);
