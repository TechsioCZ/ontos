import { moduleReleaseFetch } from '@app/core-runtime/unit-service-fetch';
import { Effect, Schema } from 'effect';

import { ShellProviderUnavailableError, ShellSearchProviderResultsSchema } from './shell-resources.ts';
import type { ShellSearchProviderHandler, ShellSearchProviderRequest } from './shell-resources.ts';

type ModuleReleaseTransport = typeof moduleReleaseFetch;

const ProviderPayloadSchema = Schema.Struct({
  includeArchived: Schema.optionalKey(Schema.Boolean),
  query: Schema.String,
  role: Schema.optionalKey(Schema.Literals(['CUSTOMER', 'SUPPLIER'])),
});
type ProviderPayload = {
  -readonly [Key in keyof typeof ProviderPayloadSchema.Type]: (typeof ProviderPayloadSchema.Type)[Key];
};
const encodeProviderPayload = Schema.encodeEffect(Schema.fromJsonString(ProviderPayloadSchema));
const decodeProviderResults = Schema.decodeUnknownEffect(Schema.fromJsonString(ShellSearchProviderResultsSchema));

/**
 * The Codesmith search-provider route inside the owner's own BFF: search key `<module>.<name>` is served at
 * `/<appId>-api/<module>/search/<name>`. A key outside its owner's namespace has no route.
 */
const providerPath = ({ appId, module, searchKey }: ShellSearchProviderRequest): string | undefined => {
  const prefix = `${module.moduleId}.`;
  const name = searchKey.startsWith(prefix) ? searchKey.slice(prefix.length) : '';
  return /^[a-z0-9][a-z0-9-]*$/u.test(name) ? `/${appId}-api/${module.moduleId}/search/${name}` : undefined;
};

const providerPayload = ({ includeArchived, query, role }: ShellSearchProviderRequest): ProviderPayload => {
  const payload: ProviderPayload = { query };
  if (includeArchived !== undefined) {
    payload.includeArchived = includeArchived;
  }
  if (role !== undefined) {
    payload.role = role;
  }
  return payload;
};

/**
 * Server-to-server Shell search gateway: each attempt carries its own audience-scoped assertion to the approved
 * owner release through the platform transport, never through a browser-supplied URL.
 */
export const makeModuleSearchProviderGateway = (transport: ModuleReleaseTransport): ShellSearchProviderHandler => ({
  search: Effect.fn('ShellSearchProviderGateway.search')(
    function* searchOwnerProvider(input: ShellSearchProviderRequest) {
      const path = providerPath(input);
      if (path === undefined || input.module.deployment.appId !== input.appId) {
        return yield* new ShellProviderUnavailableError();
      }
      const response = yield* transport(
        new Request(new URL(path, 'https://module.invalid'), {
          body: yield* encodeProviderPayload(providerPayload(input)),
          headers: {
            accept: 'application/json',
            authorization: input.authorization,
            'content-type': 'application/json',
            'x-correlation-id': input.correlationId,
          },
          method: 'POST',
        }),
        input.module,
      );
      const body = yield* Effect.tryPromise(response.text.bind(response)).pipe(Effect.timeout('10 seconds'));
      if (!response.ok) {
        return yield* new ShellProviderUnavailableError({ cause: { body, status: response.status } });
      }
      return yield* decodeProviderResults(body);
    },
    Effect.mapError((cause) =>
      Schema.is(ShellProviderUnavailableError)(cause) ? cause : new ShellProviderUnavailableError({ cause }),
    ),
  ),
});

export const moduleSearchProviderGateway = makeModuleSearchProviderGateway(moduleReleaseFetch);
