import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  createMutation,
  discoverOntosModule,
  EXTERNAL_HTTP_ADAPTER_GENERATOR_HEADER,
  requireCanonicalSlug,
  resolveContainedPath,
  toCamelCase,
  toPascalCase,
} from '../shared.mts';
import type {
  ExternalHttpAdapterScaffoldConfig,
  ExternalHttpAdapterScaffoldResult,
  ScaffoldPlan,
} from '../shared.mts';

const renderExternalHttpAdapter = (
  packageName: string,
  provider: string,
  operation: string,
): string => {
  const providerType = toPascalCase(provider);
  const operationType = toPascalCase(operation);
  const adapterType = `${providerType}${operationType}`;
  const operationMethod = toCamelCase(operation);

  return `${EXTERNAL_HTTP_ADAPTER_GENERATOR_HEADER}
import { Context, Effect, Layer, Schema } from 'effect';
import { HttpClient } from 'effect/unstable/http';

export class ${adapterType}NotImplemented extends Schema.TaggedErrorClass<${adapterType}NotImplemented>()(
  '${adapterType}NotImplemented',
  {
    code: Schema.Literal('external_http_adapter_not_implemented'),
    reason: Schema.String,
  },
) {}

export interface ${adapterType}ServiceShape {
  readonly ${operationMethod}: () => Effect.Effect<never, ${adapterType}NotImplemented>;
}

export class ${adapterType}Service extends Context.Service<
  ${adapterType}Service,
  ${adapterType}ServiceShape
>()('${packageName}/integrations/${provider}/${provider}-${operation}/${adapterType}Service') {}

const make${adapterType}Service = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return {
    ${operationMethod}: () => {
      void httpClient;
      return Effect.fail(
        new ${adapterType}NotImplemented({
          code: 'external_http_adapter_not_implemented',
          reason: 'The ${providerType} ${operationType} external HTTP adapter is not implemented',
        }),
      );
    },
  } satisfies ${adapterType}ServiceShape;
});

export const ${adapterType}ServiceLive = Layer.effect(
  ${adapterType}Service,
  make${adapterType}Service,
);
`;
};

export const planExternalHttpAdapterScaffold = async (
  workspaceRoot: string,
  config: ExternalHttpAdapterScaffoldConfig,
): Promise<ScaffoldPlan<ExternalHttpAdapterScaffoldResult>> => {
  const provider = requireCanonicalSlug(config.provider, 'provider');
  const operation = requireCanonicalSlug(config.operation, 'operation');
  const vertical = await discoverOntosModule(workspaceRoot, config.vertical);
  const adapterPath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'src',
    'integrations',
    provider,
    `${provider}-${operation}.service.ts`,
  );
  return {
    mutations: [
      await createMutation(
        adapterPath,
        renderExternalHttpAdapter(vertical.packageName, provider, operation),
      ),
    ],
    result: { adapterPath },
  };
};

export default createCodesmithGenerator(planExternalHttpAdapterScaffold);
