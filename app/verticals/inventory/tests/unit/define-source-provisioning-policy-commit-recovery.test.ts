import {
  ActionAlreadyCommitted,
  ActionCommitIndeterminate,
  ActionRuntime,
  GatewayAssertionRedemptionService,
  isVerifiedGatewayPrincipalContext,
  ReadRuntime,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { ActionInvocationIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Crypto, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { OpenApi } from 'effect/http-api';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { makeInventoryApiRuntime } from '../../api/index.ts';
import {
  DefineSourceProvisioningPolicyActionApi,
  SourceProvisioningPolicyCommitOpenSchema,
} from '../../shared/apis/define-source-provisioning-policy-action.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { resolveSourceProvisioningPolicyCommitWithAuthorization } from '../../src/api/inventory-client.ts';
import { sourceImportCompositionFixture } from '../support/source-import-composition.fixture.ts';

const issuer = 'https://inventory-commit.test';
const principal = {
  authBindingId: '11111111-1111-4111-8111-111111111111',
  authContextRef: 'session:operator',
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
  authMethod: 'session',
  principalId: '22222222-2222-4222-8222-222222222222',
  tenantId: '33333333-3333-4333-8333-333333333333',
} as const;
const open = ActionInvocationIdSchema.make('44444444-4444-4444-8444-444444444444');
const committed = ActionInvocationIdSchema.make('55555555-5555-4555-8555-555555555555');
const unknown = ActionInvocationIdSchema.make('66666666-6666-4666-8666-666666666666');
const absent = ActionInvocationIdSchema.make('77777777-7777-4777-8777-777777777777');

it('publishes resolution alongside execution in the existing policy definition API', () => {
  const path = '/inventory/actions/define-source-provisioning-policy';
  const { paths } = OpenApi.fromApi(DefineSourceProvisioningPolicyActionApi);
  expect(paths[path]?.post).toBeDefined();
  expect(new Set(Object.keys(paths[`${path}/resolve-commit`]?.post?.responses ?? {}))).toEqual(
    new Set(['200', '400', '401', '403', '404', '409', '503']),
  );
});

it.live('recovers only the operator’s exact policy invocation without executing an Action', () =>
  Effect.gen(function* recoverPolicy() {
    const composition = yield* sourceImportCompositionFixture;
    const harness = yield* makeActionTestHarness();
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const jwk = { ...(yield* Effect.promise(() => exportJWK(publicKey))), alg: 'EdDSA', kid: 'test', use: 'sig' };
    const { revision } = composition.composition;
    const credential = Effect.fn('InventoryPolicyRecoveryTest.credential')(function* credential(
      legalEntityId?: string,
    ) {
      const jti = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
      const now = Math.floor((yield* DateTime.nowAsDate).getTime() / 1000);
      const token = yield* Effect.promise(() =>
        new SignJWT({
          compositionRevision: revision,
          principal: { ...principal, legalEntityId },
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: 'test', typ: 'JWT' })
          .setAudience('inventory')
          .setIssuer(issuer)
          .setSubject(principal.principalId)
          .setIssuedAt(now)
          .setExpirationTime(now + GATEWAY_ASSERTION_TTL_SECONDS)
          .setJti(jti)
          .sign(privateKey),
      );
      return `Bearer ${token}`;
    });
    const calls: unknown[] = [];
    const runtime = Layer.succeed(ActionRuntime, {
      resolveActionCommit: (input) => {
        expect(input.expectedActionKey).toBe('commerce.inventory.define-source-provisioning-policy');
        expect(isVerifiedGatewayPrincipalContext(input.principal)).toBe(true);
        expect(Schema.is(TrustedPrincipalContextSchema)(input.principal)).toBe(true);
        expect(input.principal).toMatchObject(principal);
        calls.push(input.invocationId);
        switch (input.invocationId) {
          case open: {
            return Effect.succeed({ _tag: 'ActionCommitOpen', invocationId: open } as const);
          }
          case committed: {
            return Effect.fail(
              new ActionAlreadyCommitted({
                code: 'action_already_committed',
                invocationId: committed,
                reason: 'Committed',
              }),
            );
          }
          case unknown: {
            return Effect.fail(
              new ActionCommitIndeterminate({
                code: 'action_commit_indeterminate',
                invocationId: unknown,
                reason: 'Unavailable',
              }),
            );
          }
          default: {
            return harness.runtime.resolveActionCommit(input);
          }
        }
      },
      runAction: () => Effect.die('Commit resolution must not run an Action'),
    });
    const compositionDocument = yield* Schema.encodeEffect(
      Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
    )(composition);
    const assembled = makeInventoryApiRuntime(
      Layer.succeed(ReadRuntime, { runRead: () => Effect.die('Commit resolution must not run a Read') }),
      Layer.mergeAll(
        runtime,
        Layer.succeed(ActiveApplicationCompositionSource, { load: Effect.succeed(compositionDocument) }),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ONTOS_GATEWAY_ISSUER: issuer,
            ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [jwk] }),
          }),
        ),
      ),
      Layer.succeed(GatewayAssertionRedemptionService, { consume: () => Effect.void }),
    );
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => assembled.createHandler()),
      (value) => Effect.promise(() => value.dispose()).pipe(Effect.orDie),
    );
    const fetchThrough: typeof fetch = (input, init) => app.handler(new Request(input, init));
    const resolve = (id: string, authorization: string) =>
      resolveSourceProvisioningPolicyCommitWithAuthorization(
        { invocationId: id },
        Redacted.make(authorization),
        'resolve-original',
        {
          baseUrl: issuer,
          compositionRevision: revision,
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchThrough));
    const resolved = yield* resolve(open, yield* credential());
    expect(Schema.is(SourceProvisioningPolicyCommitOpenSchema)(resolved)).toBe(true);
    expect(resolved).toMatchObject({
      invocationId: open,
      retryCommand: true,
    });
    expect(yield* resolve(committed, yield* credential()).pipe(Effect.flip)).toMatchObject({
      code: 'action_already_committed',
      invocationId: committed,
      resolution: 'REFRESH_GOVERNED_READS',
      retryCommand: false,
      status: 409,
    });
    expect(yield* resolve(unknown, yield* credential()).pipe(Effect.flip)).toMatchObject({
      invocationId: unknown,
      resolution: 'RESOLVE_COMMIT',
      retryCommand: false,
      status: 503,
    });
    expect(yield* resolve(absent, yield* credential()).pipe(Effect.flip)).toMatchObject({
      code: 'action_invocation_not_found',
      status: 404,
    });
    expect(yield* resolve(open, 'Bearer invalid').pipe(Effect.flip)).toMatchObject({ status: 401 });
    expect(yield* resolve(open, yield* credential(principal.tenantId)).pipe(Effect.flip)).toMatchObject({
      status: 403,
    });
    expect(calls).toEqual([open, committed, unknown, absent]);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
