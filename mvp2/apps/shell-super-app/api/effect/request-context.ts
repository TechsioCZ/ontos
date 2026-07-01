import { Effect, HttpServerRequest } from '@modern-js/plugin-bff/effect-edge';
import { resolveOperationContextFromSession } from '@mvp2/core-runtime/operation-context/session';
import { createOperationContextAuthRequired } from '../../src/effect/auth-api.ts';

export const requestHeaders = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map((request) => new globalThis.Headers(Object.entries(request.headers))),
);

export const requireOperationContext = (headers: Headers) =>
  Effect.promise(() => resolveOperationContextFromSession({ headers })).pipe(
    Effect.flatMap((result) =>
      result._tag === 'Success'
        ? Effect.succeed(result.operationContext)
        : Effect.fail(createOperationContextAuthRequired(result.error.message)),
    ),
  );

export const currentOperationContext = requestHeaders.pipe(
  Effect.flatMap((headers) => requireOperationContext(headers)),
);
