import { createCodesmithGenerator } from '../generator-adapter.mts';
import { Effect, Predicate } from 'effect';
import {
  createMutationEffect,
  discoverOntosModuleEffect,
  EXTERNAL_HTTP_ADAPTER_GENERATOR_HEADER,
  requireCanonicalSlug,
  resolveContainedPath,
  scaffoldFailure,
  toCamelCase,
  toPascalCase,
  tryScaffold,
} from '../shared.mts';
import type {
  ExternalHttpAdapterScaffoldConfig,
  ExternalHttpAdapterScaffoldResult,
  ScaffoldFailure,
  ScaffoldPlan,
} from '../shared.mts';

const preserveFileSystemCause = (failure: ScaffoldFailure): ScaffoldFailure => {
  const { cause } = failure;
  const underlying = Predicate.isError(cause) ? cause.cause : undefined;
  return Predicate.isError(underlying)
    ? scaffoldFailure(`${failure.message}: ${underlying.message}`, cause)
    : failure;
};

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

export class ${adapterType}NotImplemented extends Schema.TaggedError<${adapterType}NotImplemented>()(
  '${adapterType}NotImplemented',
  {
    code: Schema.Literal('external_http_adapter_not_implemented'),
    reason: Schema.String,
  },
) {}

export interface ${adapterType}ServiceContract {
  readonly ${operationMethod}: () => Effect.Effect<never, ${adapterType}NotImplemented>;
}

export class ${adapterType}Service extends Context.Service<
  ${adapterType}Service,
  ${adapterType}ServiceContract
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
  } satisfies ${adapterType}ServiceContract;
});

export const ${adapterType}ServiceLive = Layer.effect(
  ${adapterType}Service,
  make${adapterType}Service,
);
`;
};

export const planExternalHttpAdapterScaffold = Effect.fn('ExternalHttpAdapterScaffold.plan')(
  function* planExternalHttpAdapterScaffold(
    workspaceRoot: string,
    config: ExternalHttpAdapterScaffoldConfig,
  ) {
    const provider = yield* tryScaffold('provider name is invalid', () =>
      requireCanonicalSlug(config.provider, 'provider'),
    );
    const operation = yield* tryScaffold('operation name is invalid', () =>
      requireCanonicalSlug(config.operation, 'operation'),
    );
    const vertical = yield* discoverOntosModuleEffect(workspaceRoot, config.vertical);
    const adapterPath = yield* tryScaffold('failed to resolve external HTTP adapter path', () =>
      resolveContainedPath(
        workspaceRoot,
        'verticals',
        vertical.slug,
        'src',
        'integrations',
        provider,
        `${provider}-${operation}.service.ts`,
      ),
    );
    const mutation = yield* createMutationEffect(
      adapterPath,
      renderExternalHttpAdapter(vertical.packageName, provider, operation),
    ).pipe(Effect.mapError(preserveFileSystemCause));
    return {
      mutations: [mutation],
      result: { adapterPath },
    } satisfies ScaffoldPlan<ExternalHttpAdapterScaffoldResult>;
  },
);

export default createCodesmithGenerator(planExternalHttpAdapterScaffold);
