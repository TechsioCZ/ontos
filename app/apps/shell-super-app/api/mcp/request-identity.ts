import { ActionTransportMetadataSchema } from '@app/core-runtime';
import type { OperationalScopeRequest } from '@app/core-runtime';
import { Crypto, Effect, Option, Schema } from 'effect';
import type { Types } from 'effect';
import { Headers as HttpHeaders, HttpRouter, HttpServerRequest } from 'effect/http';
import type { HttpServerResponse } from 'effect/http';

import { IdentityRequestHeadersSchema } from '../../shared/api.ts';
import { AgentActionRequestIdentity } from '../auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../auth/agent-request-identity.ts';

const mcpRequestHeadersSchema = Schema.Struct({
  ...IdentityRequestHeadersSchema.fields,
  'x-correlation-id': Schema.optionalKey(ActionTransportMetadataSchema.fields.correlationId),
  'x-trace-id': ActionTransportMetadataSchema.fields.traceId,
});

// Own each HTTP request's correlation before SDK callbacks capture services; standard MCP clients need no custom header.
// Invalid supplied metadata stays unbound. Only the caller can supply an Action's durable idempotency key.
const bindMcpRequestIdentity = Effect.fn('Mcp.bindRequestIdentity')(function* bindMcpRequestIdentity(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
  generatedCorrelationId: Effect.Effect<Option.Option<string>>,
): Effect.fn.Return<HttpServerResponse.HttpServerResponse, Types.unhandled, HttpServerRequest.HttpServerRequest> {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const headers = yield* Effect.option(Schema.decodeUnknownEffect(mcpRequestHeadersSchema)(request.headers));
  if (Option.isNone(headers)) {
    return yield* handler;
  }
  const correlationId =
    headers.value['x-correlation-id'] === undefined
      ? yield* generatedCorrelationId
      : Option.some(headers.value['x-correlation-id']);
  if (Option.isNone(correlationId)) {
    return yield* handler;
  }
  let identity: OperationalScopeRequest = { correlationId: correlationId.value };
  if (headers.value['x-trace-id'] !== undefined) {
    identity = { ...identity, traceId: headers.value['x-trace-id'] };
  }
  const forwarded = request.modify({
    headers: HttpHeaders.set(request.headers, 'x-correlation-id', correlationId.value),
  });
  const readHandler = handler.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, forwarded),
    Effect.provideService(AgentReadRequestIdentity, identity),
  );
  const idempotencyKey = headers.value['idempotency-key'];
  return yield* idempotencyKey === undefined
    ? readHandler
    : readHandler.pipe(Effect.provideService(AgentActionRequestIdentity, { ...identity, idempotencyKey }));
});

export const mcpRequestIdentityMiddleware = HttpRouter.middleware()(
  Effect.gen(function* makeMcpRequestIdentityMiddleware() {
    const crypto = yield* Crypto.Crypto;
    // The router infers its error and requirement channels from this plain handler signature.
    const generatedCorrelationId = Effect.option(crypto.randomUUIDv4());
    return (handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
      bindMcpRequestIdentity(handler, generatedCorrelationId);
  }),
);
