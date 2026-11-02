import {
  ReadInputValidationError,
  ReadPolicyDenied,
  ReadPermissionDenied,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { authenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceRegistrationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '@app/commerce-customer-context/portal-auth/contracts';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Context, Effect, Layer, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import { privacyApi } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { noticePresentationReadApiLive } from '../../api/notice-presentation-read-server.ts';
import { Headers, HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';
import {
  NoticePresentationAuthenticationProblemSchema,
  NoticePresentationForbiddenProblemSchema,
  NoticePresentationInternalProblemSchema,
  NoticePresentationInvalidProblemSchema,
  NoticePresentationNotFoundProblemSchema,
  NoticePresentationPolicyConflictProblemSchema,
  NoticePresentationPolicyProblemSchema,
  NoticePresentationUnavailableProblemSchema,
} from '../../shared/apis/notice-presentation.ts';
import { PrivacyNoticeAcknowledgementError } from '../../shared/resources/privacy-notice-acknowledgement.ts';
import { privacyNoticeInformationStepLive } from '../../src/services/privacy-notice-acknowledgement-authority.service.ts';
import { noticePresentationRead } from '../../src/api/notice-presentation.read.ts';
import { CommerceCustomerContextNoticeSubjectAuthorityService } from '../../src/integrations/commerce-customer-context/commerce-customer-context-notice-subject-authority.service.ts';
import {
  makePrivacyNoticePresentationService,
  PrivacyNoticePresentationService,
} from '../../src/services/privacy-notice-presentation.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const compositionRevision = 'a'.repeat(64);
const principal = trustVerifiedGatewayPrincipalContext(
  Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '10000000-0000-4000-8000-000000000003',
    authContextRef: 'notice-read-contract-session',
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    legalEntityId: '10000000-0000-4000-8000-000000000004',
    principalId: '10000000-0000-4000-8000-000000000002',
    tenantId,
  }),
  compositionRevision,
);
const target = {
  businessInteractionRef: 'notice-read-contract',
  noticeVersionId: '10000000-0000-4000-8000-000000000005',
  privacySubjectRef: {
    moduleId: 'privacy.core',
    resourceId: '10000000-0000-4000-8000-000000000006',
    resourceType: 'privacy.core.privacy-subject',
    tenantId,
  },
  retailProfileId: 'profile:opaque-owner-id',
} as const;
const retainedSubject = Schema.decodeSync(PrivacySubjectRecordSchema)({
  createdAt: '2026-10-20T12:00:00.000Z',
  subject: {
    kind: 'DATA_SUBJECT',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: '10000000-0000-4000-8000-000000000007',
      resourceType: 'party.registry.party',
      tenantId,
    },
  },
  subjectRef: target.privacySubjectRef,
  updatedAt: '2026-10-20T12:00:00.000Z',
});
const executeSnapshotQuery: Parameters<typeof makeReadTestHarness>[0]['executeOwnerQuery'] = ({ sql }) => {
  if (sql.includes('privacy_subjects')) {
    return Effect.succeed([{ record: retainedSubject }]);
  }
  if (sql.includes('notice_versions')) {
    return Effect.succeed([]);
  }
  return Effect.die(`Unexpected SQL outside the Notice snapshot: ${sql}`);
};
const problems = makeGovernedReadProblems({
  authentication: NoticePresentationAuthenticationProblemSchema,
  forbidden: NoticePresentationForbiddenProblemSchema,
  internal: NoticePresentationInternalProblemSchema,
  invalid: NoticePresentationInvalidProblemSchema,
  notFound: NoticePresentationNotFoundProblemSchema,
  policyConflict: NoticePresentationPolicyConflictProblemSchema,
  policyIneligible: NoticePresentationPolicyProblemSchema,
  unavailable: NoticePresentationUnavailableProblemSchema,
});
const namespaceLive = authenticationNamespaceRegistryLayer(
  Schema.decodeEffect(AuthenticationNamespaceRegistrationSchema)({
    allowedAudiences: ['privacy'],
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    provider: 'commerce-portal-better-auth',
    requiresOperationAdmission: false,
    reservationPrincipalKind: 'human',
    subjectTypes: ['user'],
    trustedAttesterPrincipalIds: [],
  }).pipe(Effect.map((registration) => [registration])),
);
const cases = [
  { code: 'privacy_notice_acknowledgement_invalid', schema: ReadInputValidationError, status: 400 },
  { code: 'privacy_notice_acknowledgement_conflict', schema: ReadPolicyDenied, status: 409 },
  { code: 'privacy_notice_acknowledgement_denied', schema: ReadPermissionDenied, status: 403 },
  { code: 'privacy_notice_acknowledgement_not_found', schema: ReadHandlerNotFound, status: 404 },
  { code: 'privacy_notice_acknowledgement_unavailable', schema: ReadHandlerUnavailable, status: 503 },
] as const;

it.layer(Layer.mergeAll(NodeCrypto.layer, namespaceLive))('Notice read declared handler failures', (suite) => {
  for (const testCase of cases) {
    suite.effect(
      `preserves ${testCase.schema.name} through the real Read lifecycle and maps HTTP ${testCase.status}`,
      () =>
        Effect.gen(function* registeredNoticeFailure() {
          const harness = yield* makeReadTestHarness({
            compositionRevision,
            executeOwnerQuery: executeSnapshotQuery,
            operationTime: new Date('2026-10-20T12:00:00.000Z'),
            ownerAuthorizationDecision: 'allowed',
            permissionDecision: 'allowed',
            scope: { ...principal, correlationId: 'notice-read-contract' },
          });
          const integrity = yield* makePrivacyNoticePresentationService({
            keyId: 'notice-read-contract',
            signingKey: Redacted.make('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
          });
          let authorityCalls = 0;
          const ports = Layer.mergeAll(
            Layer.succeed(PrivacyNoticePresentationService, integrity),
            Layer.succeed(CommerceCustomerContextNoticeSubjectAuthorityService, {
              forScope: () => ({
                resolve: () => {
                  authorityCalls += 1;
                  return Effect.fail(
                    new PrivacyNoticeAcknowledgementError({
                      code: testCase.code,
                      reason: 'private authority diagnostics',
                    }),
                  );
                },
              }),
            }),
          );
          const read = harness.runtime.runRead({
            input: target,
            principal,
            registration: noticePresentationRead,
            transport: { correlationId: 'notice-read-contract' },
          });
          const failure = yield* read.pipe(
            Effect.provide(privacyNoticeInformationStepLive.pipe(Layer.provideMerge(ports))),
            Effect.flip,
          );
          expect(Schema.is(testCase.schema)(failure)).toBe(true);
          const handler = makeGovernedReadHttpHandler({
            authenticatePrincipal: () => Effect.succeed(principal),
            problems,
            registration: noticePresentationRead,
          });
          const problem = yield* handler({
            payload: target,
            request: { headers: Headers.fromInput({ 'x-correlation-id': 'notice-read-contract' }) },
          }).pipe(
            Effect.provide(privacyNoticeInformationStepLive.pipe(Layer.provideMerge(ports))),
            Effect.provide(harness.layer),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(new Request('https://privacy.example/reads/notice-presentation')),
            ),
            Effect.flip,
          );
          expect(problem.status).toBe(testCase.status);
          expect(JSON.stringify(problem)).not.toContain('private authority diagnostics');
          expect(authorityCalls).toBe(2);
          expect(harness.snapshot().ownerQueries).toHaveLength(4);
          expect(harness.snapshot().evidenceWrites).toBe(testCase.status === 403 ? 2 : 0);
          expect(harness.snapshot().statements.at(-1)).toBe(
            // The immutable SQL load commits before the remote finish. No protected result is released.
            'COMMIT',
          );
        }),
    );
  }
});

it.live('GET decodes exact targets, trusts only the verified Tenant and redeems its assertion once', () =>
  Effect.scoped(
    Effect.gen(function* getNoticeContract() {
      const composition = yield* makeApplicationCompositionSnapshotFixture(
        ['privacy'],
        ultramodernApiMarker.buildMarker,
      );
      const issuer = 'https://shell.notice-get.test';
      const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
      const publicJwk = {
        ...(yield* Effect.promise(() => exportJWK(publicKey))),
        alg: 'EdDSA',
        kid: 'notice-get',
        use: 'sig',
      };
      const token = yield* Effect.promise(() =>
        new SignJWT({
          compositionRevision: composition.composition.revision,
          principal,
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience('privacy')
          .setSubject(principal.principalId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .setJti('10000000-0000-4000-8000-000000000009')
          .sign(privateKey),
      );
      const harness = yield* makeReadTestHarness({
        compositionRevision: composition.composition.revision,
        executeOwnerQuery: executeSnapshotQuery,
        operationTime: new Date('2026-10-20T12:00:00.000Z'),
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope: { ...principal, correlationId: 'notice-get-contract' },
      });
      const integrity = yield* makePrivacyNoticePresentationService({
        keyId: 'notice-get-contract',
        signingKey: Redacted.make('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      });
      let redemptions = 0;
      let ownerCalls = 0;
      const admittedJtis = new Set<string>();
      const compositionDocument = yield* Schema.encodeEffect(
        Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
      )(composition);
      const configuration = Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ONTOS_GATEWAY_ISSUER: issuer,
            ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              keys: [publicJwk],
            }),
          }),
        ),
        Layer.succeed(ActiveApplicationCompositionSource, {
          load: Effect.succeed(compositionDocument),
        }),
      );
      const ports = Layer.mergeAll(
        Layer.succeed(PrivacyNoticePresentationService, integrity),
        Layer.succeed(CommerceCustomerContextNoticeSubjectAuthorityService, {
          forScope: ({ scope }) => ({
            resolve: (observedTarget) => {
              ownerCalls += 1;
              expect(scope.tenantId).toBe(tenantId);
              expect(scope.principalId).toBe(principal.principalId);
              expect(scope.legalEntityId).toBe(principal.legalEntityId);
              expect(observedTarget).toEqual(target);
              return Effect.fail(
                new PrivacyNoticeAcknowledgementError({
                  code: 'privacy_notice_acknowledgement_conflict',
                  reason: 'private exact Subject mismatch',
                }),
              );
            },
          }),
        }),
        Layer.succeed(GatewayAssertionRedemptionService, {
          consume: ({ jti }) =>
            Effect.suspend(() => {
              redemptions += 1;
              if (admittedJtis.has(jti)) {
                return Effect.fail(new GatewayAssertionReplayError({ reason: 'Already redeemed' }));
              }
              admittedJtis.add(jti);
              return Effect.void;
            }),
        }),
      );
      const api = HttpApi.make('PrivacyApi')
        .add(privacyApi.groups.noticePresentation)
        .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(api).pipe(
              Layer.provide(noticePresentationReadApiLive),
              Layer.provideMerge(RequestSchemaProblemLive),
              Layer.provideMerge(ActionPrincipalVerifierLive.pipe(Layer.provide(configuration))),
              Layer.provideMerge(Layer.mergeAll(harness.layer, ports, NodeCrypto.layer, HttpServer.layerServices)),
            ),
            { disableLogger: true },
          ),
        ),
        (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
      );
      const query = new URLSearchParams({
        businessInteractionRef: target.businessInteractionRef,
        privacySubjectId: target.privacySubjectRef.resourceId,
        retailProfileId: target.retailProfileId,
      });
      const path = `https://privacy.example/notices/${target.noticeVersionId}/presentation`;
      const request = (url: string, authorization?: string) => {
        const headers = new globalThis.Headers({ 'x-correlation-id': 'notice-get-contract' });
        if (authorization !== undefined) {
          headers.set('authorization', authorization);
        }
        return Effect.promise(() => server.handler(new Request(url, { headers }), Context.empty()));
      };
      const malformedPath = yield* request(
        `https://privacy.example/notices/not-a-uuid/presentation?${query}`,
        `Bearer ${token}`,
      );
      expect(malformedPath.status).toBe(400);
      const missingQuery = yield* request(
        `${path}?privacySubjectId=${target.privacySubjectRef.resourceId}`,
        `Bearer ${token}`,
      );
      expect(missingQuery.status).toBe(400);
      const injectedTenant = yield* request(`${path}?${query}&tenantId=foreign-tenant`, `Bearer ${token}`);
      expect(injectedTenant.status).toBe(400);
      expect(redemptions).toBe(0);
      expect(ownerCalls).toBe(0);
      const unauthenticated = yield* request(`${path}?${query}`);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer');
      expect(redemptions).toBe(0);
      const presented = yield* request(`${path}?${query}`, `Bearer ${token}`);
      expect(presented.status).toBe(409);
      expect(presented.headers.get('cache-control')).toBe('no-store');
      expect(redemptions).toBe(1);
      expect(ownerCalls).toBe(1);
      const replayed = yield* request(`${path}?${query}`, `Bearer ${token}`);
      expect(replayed.status).toBe(401);
      expect(replayed.headers.get('www-authenticate')).toBe('Bearer');
      expect(redemptions).toBe(2);
      expect(ownerCalls).toBe(1);
      expect(harness.snapshot().ownerQueries).toHaveLength(2);
      expect(harness.snapshot().evidenceWrites).toBe(0);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
