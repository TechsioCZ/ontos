import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpServerRequest,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import { runAction } from '@mvp2/core-runtime/sdk';
import type { CoreSDKError } from '@mvp2/core-runtime/sdk';
import type { OperationContext } from '@mvp2/core-runtime/operation-context';
import { ultramodernApiMarker } from '../../src/ultramodern-build.ts';
import {
  accountingEffectApi,
  createOperationAuthorizationDenied,
  createOperationContextAuthRequired,
  createOperationDomainRejected,
  createOperationExecutionFailed,
  createOperationIdempotencyConflict,
  createOperationIdempotencyKeyRequired,
  createOperationIdempotencyReplayUnavailable,
  createOperationModuleStateDenied,
  createOperationPersistenceFailed,
  createOperationPolicyDenied,
} from '../../shared/effect/api.ts';
import { listAccountingActionRegistration } from '../../src/actions/list-accounting.registration.ts';
import type { ListAccountingAction } from '../../src/actions/list-accounting.action.ts';

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

const runListAccountingAction = ({
  headers,
  payload,
}: {
  readonly headers: Headers;
  readonly payload: ListAccountingAction;
}) =>
  Effect.promise(() =>
    runAction({
      payload,
      registration: listAccountingActionRegistration,
      transport: { headers },
    }),
  ).pipe(
    Effect.flatMap((result) =>
      result._tag === 'OperationSucceeded'
        ? Effect.succeed(result)
        : Effect.fail(coreSDKErrorToHttpError(result)),
    ),
  );

const accountingLayer = HttpApiBuilder.group(accountingEffectApi, 'accounting', (handlers) =>
  handlers
    .handle('list', ({ query }) =>
      requestHeaders.pipe(
        Effect.flatMap((headers) => runListAccountingAction({ headers, payload: query })),
        Effect.flatMap((result) =>
          Effect.log('[accounting-bff] list action completed through CoreSDK').pipe(
            Effect.as(result.response),
            Effect.withSpan('ultramodern.effect.accounting.list', {
              attributes: operationAttributes(result.context),
              kind: 'server',
            }),
          ),
        ),
      ),
    )
    .handle('readiness', () =>
      Effect.succeed({
        checks: {
          effectBff: 'ready' as const,
          moduleFederation: 'ready' as const,
          ssr: 'ready' as const,
          translations: 'ready' as const,
        },
        marker: ultramodernApiMarker,
        status: 'ready' as const,
        versionSkew: 'none' as const,
      }).pipe(
        Effect.withSpan('ultramodern.effect.accounting.readiness', {
          attributes: {
            'modernjs.operation.id': 'AccountingEffectApi:accounting:readiness',
            'modernjs.operation.method': 'GET',
            'modernjs.operation.route': '/effect/accounting/readiness',
          },
          kind: 'server',
        }),
      ),
    ),
);

const layer = HttpApiBuilder.layer(accountingEffectApi).pipe(Layer.provide(accountingLayer));

export default defineEffectBff({
  api: accountingEffectApi,
  layer,
});
