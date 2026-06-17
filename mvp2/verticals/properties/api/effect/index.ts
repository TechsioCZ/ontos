import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpServerRequest,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import {
  createOperationContextAuthRequired,
  propertiesEffectApi,
} from '../../shared/effect/api.ts';
import { resolveVerticalGatewayToken } from '@mvp2/core-runtime';
import type { OperationContext } from '@mvp2/core-runtime';
import type { CreateUnitAction } from '../../src/actions/create-unit.action.ts';
import { createUnitHandler } from '../../src/actions/create-unit.handler.ts';

const operationAttributes = <TAction>(operationContext: OperationContext<TAction>) => ({
  'ontos.legal_entity.id': operationContext.legalEntityId,
  'ontos.principal.id': operationContext.principalId,
  'ontos.tenant.id': operationContext.tenantId,
});

const requestHeaders = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map((request) => new Headers(Object.entries(request.headers))),
);

const makeOperationContext = <TAction>(action: TAction) =>
  requestHeaders.pipe(
    Effect.flatMap((headers) => {
      const result = resolveVerticalGatewayToken({
        audience: 'properties',
        token: headers.get('x-ontos-operation-context'),
      });

      return result._tag === 'Success'
        ? Effect.succeed({
            ...result.operationContext,
            action,
          } satisfies OperationContext<TAction>)
        : Effect.fail(createOperationContextAuthRequired(result.error.message));
    }),
  );

const propertiesLayer = HttpApiBuilder.group(propertiesEffectApi, 'properties', (handlers) =>
  handlers.handle('createUnit', () => {
    const action: CreateUnitAction = {};

    return makeOperationContext(action).pipe(
      Effect.flatMap((operationContext) =>
        Effect.log('[properties-bff] createUnit handler called').pipe(
          Effect.as(createUnitHandler(operationContext)),
          Effect.withSpan('ultramodern.effect.properties.createUnit', {
            attributes: operationAttributes(operationContext),
            kind: 'server',
          }),
        ),
      ),
    );
  }),
);

const layer = HttpApiBuilder.layer(propertiesEffectApi).pipe(Layer.provide(propertiesLayer));

export default defineEffectBff({
  api: propertiesEffectApi,
  layer,
});
