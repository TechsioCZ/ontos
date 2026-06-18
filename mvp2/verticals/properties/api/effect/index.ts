import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpServerRequest,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import {
  createOperationDomainRejected,
  createOperationExecutionFailed,
  createOperationIdempotencyConflict,
  createOperationIdempotencyKeyRequired,
  createOperationIdempotencyReplayUnavailable,
  createOperationContextAuthRequired,
  createOperationPolicyDenied,
  createOperationPersistenceFailed,
  propertiesEffectApi,
} from '../../shared/effect/api.ts';
import { runAction } from '@mvp2/core-runtime';
import type { CoreSDKError, OperationContext } from '@mvp2/core-runtime';
import { createUnitActionRegistration } from '../../src/actions/create-unit.registration.ts';
import type { CreateUnitAction } from '../../src/actions/create-unit.action.ts';

const operationAttributes = <TAction>(operationContext: OperationContext<TAction>) => ({
  'ontos.legal_entity.id': operationContext.legalEntityId,
  'ontos.principal.id': operationContext.principalId,
  'ontos.tenant.id': operationContext.tenantId,
});

const requestHeaders = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map((request) => new Headers(Object.entries(request.headers))),
);

const coreSDKErrorToHttpError = (error: CoreSDKError) => {
  switch (error._tag) {
    case 'OperationDomainRejected':
      return createOperationDomainRejected({
        code: error.code,
        message: error.message,
      });
    case 'OperationPolicyDenied':
      return createOperationPolicyDenied({
        code: error.code,
        message: error.message,
        policyKey: error.policyKey,
      });
    case 'OperationExecutionFailed':
      return createOperationExecutionFailed(error.message);
    case 'OperationIdempotencyConflict':
      return createOperationIdempotencyConflict(error.message);
    case 'OperationIdempotencyKeyRequired':
      return createOperationIdempotencyKeyRequired(error.message);
    case 'OperationIdempotencyReplayUnavailable':
      return createOperationIdempotencyReplayUnavailable(error.message);
    case 'OperationPersistenceFailed':
      return createOperationPersistenceFailed(error.message);
    case 'OperationAuthRequired':
    case 'OperationContextInvalid':
      return createOperationContextAuthRequired(error.message);
  }
};

const runCreateUnitAction = ({
  headers,
  payload,
}: {
  readonly headers: Headers;
  readonly payload: CreateUnitAction;
}) =>
  Effect.promise(() =>
    runAction({
      payload,
      registration: createUnitActionRegistration,
      transport: { headers },
    }),
  ).pipe(
    Effect.flatMap((result) =>
      result._tag === 'OperationSucceeded'
        ? Effect.succeed(result)
        : Effect.fail(coreSDKErrorToHttpError(result)),
    ),
  );

const propertiesLayer = HttpApiBuilder.group(propertiesEffectApi, 'properties', (handlers) =>
  handlers.handle('createUnit', ({ payload }) =>
    requestHeaders.pipe(
      Effect.flatMap((headers) => runCreateUnitAction({ headers, payload })),
      Effect.flatMap((result) =>
        Effect.log('[properties-bff] createUnit action completed through CoreSDK').pipe(
          Effect.as(result.response),
          Effect.withSpan('ultramodern.effect.properties.createUnit', {
            attributes: operationAttributes(result.context),
            kind: 'server',
          }),
        ),
      ),
    ),
  ),
);

const layer = HttpApiBuilder.layer(propertiesEffectApi).pipe(Layer.provide(propertiesLayer));

export default defineEffectBff({
  api: propertiesEffectApi,
  layer,
});
