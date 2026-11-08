import { makeMicroverticalHttpPrincipalAuthentication } from '@app/core-runtime/http/principal-authentication';
import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { OwnerActionApprovalApi } from '@app/core-runtime/access/approvals/owner-api';
import {
  OwnerActionApprovalSchemaErrorLive,
  makeOwnerActionApprovalApiLive,
} from '@app/core-runtime/access/approvals/owner-http';
import { bindGatewayPrincipalVerifier } from '../../../../packages/gateway-principal-verifier/src/server.ts';
import { Effect, Layer, Schema } from 'effect';
import type { Redacted } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';

const addressSchema = Schema.Struct({ port: Schema.Int });

/**
 * The independent Node owner mounts the shipped owner API and its genuine audience-bound
 * verification/redemption path. Its caller must supply the real owner provider and case context.
 */
export const serveNativeOwnerApprovalHttp = Effect.fn('OwnerApprovalNative.serveHttp')(
  function* serveNativeOwnerApprovalHttp(input: {
    readonly deployment: { readonly appId: string; readonly buildMarker: string };
    readonly issuer: string;
    readonly publicJwks: string;
  }) {
    const redemptionService = yield* GatewayAssertionRedemptionService;
    const requestServices = Layer.mergeAll(
      Layer.succeed(GatewayAssertionRedemptionService, redemptionService),
      staffAuthenticationNamespaceRegistryLayer([input.deployment.appId]),
    );
    const verifier = bindGatewayPrincipalVerifier(input.deployment.appId, input.deployment);
    const verify = (authorization: Redacted.Redacted<string | undefined>) =>
      GatewayAssertionRedemptionService.pipe(
        Effect.flatMap((redemption) =>
          verifier.verifyAndRedeem(authorization, {
            environment: {
              ONTOS_GATEWAY_ISSUER: input.issuer,
              ONTOS_GATEWAY_PUBLIC_JWKS: input.publicJwks,
            },
            redemption,
          }),
        ),
      );
    const authenticate = makeMicroverticalHttpPrincipalAuthentication(verify);
    const api = OwnerActionApprovalApi.prefix(`/${input.deployment.appId}-api`);
    const handlers = makeOwnerActionApprovalApiLive(api, authenticate).pipe(
      Layer.provide(OwnerActionApprovalSchemaErrorLive),
      Layer.provide(requestServices),
      HttpRouter.provideRequest(requestServices),
    );
    const http = HttpApiBuilder.layer(api).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices));
    yield* Layer.build(HttpRouter.serve(http, { disableListenLog: true, disableLogger: true }));
    const server = yield* HttpServer.HttpServer;
    const { port } = yield* Schema.decodeUnknownEffect(addressSchema)(server.address);
    return { baseUrl: `http://127.0.0.1:${port}/`, pid: process.pid };
  },
);
