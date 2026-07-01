import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import {
  createOperationDomainRejected,
  createOperationExecutionFailed,
  createOperationAuthorizationDenied,
  createOperationIdempotencyConflict,
  createOperationIdempotencyKeyRequired,
  createOperationIdempotencyReplayUnavailable,
  createOperationModuleStateDenied,
  createOperationContextAuthRequired,
  createOperationPolicyDenied,
  createOperationPersistenceFailed,
  propertiesEffectApi,
} from '../../shared/effect/api.ts';
import { runAction } from '@mvp2/core-runtime/sdk';
import type { CoreSDKError } from '@mvp2/core-runtime/sdk';
import type { OperationContext } from '@mvp2/core-runtime/operation-context';
import { createUnitActionRegistration } from '../../src/actions/create-unit.registration.ts';
import type { CreateUnitAction } from '../../src/actions/create-unit.action.ts';
import { readUnitsActionRegistration } from '../../src/actions/read-units.registration.ts';
import type { ReadUnitsAction } from '../../src/actions/read-units.action.ts';

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
    case 'OperationDomainRejected': {
      return createOperationDomainRejected({
        code: error.code,
        message: error.message,
      });
    }
    case 'OperationAuthorizationDenied': {
      return createOperationAuthorizationDenied({
        code: error.code,
        message: error.message,
        permission: error.permission,
        provider: error.provider,
        resourceObjectId: error.resourceObjectId,
        resourceObjectType: error.resourceObjectType,
      });
    }
    case 'OperationModuleStateDenied': {
      return createOperationModuleStateDenied({
        accessKind: error.accessKind,
        code: error.code,
        message: error.message,
        moduleKey: error.moduleKey,
        state: error.state,
      });
    }
    case 'OperationPolicyDenied': {
      return createOperationPolicyDenied({
        code: error.code,
        message: error.message,
        policyKey: error.policyKey,
      });
    }
    case 'OperationExecutionFailed': {
      return createOperationExecutionFailed(error.message);
    }
    case 'OperationIdempotencyConflict': {
      return createOperationIdempotencyConflict(error.message);
    }
    case 'OperationIdempotencyKeyRequired': {
      return createOperationIdempotencyKeyRequired(error.message);
    }
    case 'OperationIdempotencyReplayUnavailable': {
      return createOperationIdempotencyReplayUnavailable(error.message);
    }
    case 'OperationPersistenceFailed': {
      return createOperationPersistenceFailed(error.message);
    }
    case 'OperationAuthRequired':
    case 'OperationContextInvalid': {
      return createOperationContextAuthRequired(error.message);
    }
    default: {
      return createOperationExecutionFailed('Unhandled CoreSDK error.');
    }
  }
};

type PropertiesHttpError = ReturnType<typeof coreSDKErrorToHttpError>;

const httpErrorStatus = (error: PropertiesHttpError): number => {
  switch (error._tag) {
    case 'OperationContextAuthRequired': {
      return 401;
    }
    case 'OperationAuthorizationDenied':
    case 'OperationModuleStateDenied': {
      return 403;
    }
    case 'OperationIdempotencyKeyRequired': {
      return 428;
    }
    case 'OperationDomainRejected':
    case 'OperationIdempotencyConflict':
    case 'OperationIdempotencyReplayUnavailable':
    case 'OperationPolicyDenied': {
      return 409;
    }
    case 'OperationExecutionFailed':
    case 'OperationPersistenceFailed': {
      return 500;
    }
  }
};

const httpErrorResponse = (error: PropertiesHttpError) =>
  HttpServerResponse.jsonUnsafe(error, {
    status: httpErrorStatus(error),
  });

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

const readUnitsActionPayload: ReadUnitsAction = {};

const runReadUnitsAction = ({ headers }: { readonly headers: Headers }) =>
  Effect.promise(() =>
    runAction({
      payload: readUnitsActionPayload,
      registration: readUnitsActionRegistration,
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
  handlers
    .handle('createUnit', ({ payload }) =>
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
        Effect.catch((error) => Effect.succeed(httpErrorResponse(error))),
      ),
    )
    .handle('readUnits', () =>
      requestHeaders.pipe(
        Effect.flatMap((headers) => runReadUnitsAction({ headers })),
        Effect.flatMap((result) =>
          Effect.log('[properties-bff] readUnits action completed through CoreSDK').pipe(
            Effect.as(result.response),
            Effect.withSpan('ultramodern.effect.properties.readUnits', {
              attributes: operationAttributes(result.context),
              kind: 'server',
            }),
          ),
        ),
        Effect.catch((error) => Effect.succeed(httpErrorResponse(error))),
      ),
    ),
);

const layer = HttpApiBuilder.layer(propertiesEffectApi).pipe(Layer.provide(propertiesLayer));

export default defineEffectBff({
  api: propertiesEffectApi,
  layer,
});
