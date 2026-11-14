import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { Effect, Layer } from 'effect';
import { HttpServerRequest } from 'effect/http';

/** Tests inject the reference owner; accidentally reaching its real gateway must fail. */
export const referenceTransportNotUsed = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, {
    load: Effect.die('Unexpected reference composition lookup'),
  }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, {
    configuration: Effect.die('Unexpected reference gateway configuration'),
  }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://work.example.test')),
  ),
);
