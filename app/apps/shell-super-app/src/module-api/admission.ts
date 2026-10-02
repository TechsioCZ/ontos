import type { ApplicationComposition } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

export const MODULE_API_REVISION_HEADER = 'x-ontos-composition-revision';

const hopByHopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
const governedHeaders = new Set([
  'authorization',
  MODULE_API_REVISION_HEADER,
  'idempotency-key',
  'x-correlation-id',
  'x-trace-id',
]);
const connectionToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export class ModuleApiDispatchError extends Schema.TaggedError<ModuleApiDispatchError>()('ModuleApiDispatchError', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
  status: Schema.Literals([400, 404, 409, 503]),
}) {}

/** Resolve only the reviewed native BFF convention under an admitted release, never an input URL. */
export const admitModuleApiRequest = Effect.fn('ModuleApi.admitRequest')(function* admitRequest(
  request: Request,
  composition: ApplicationComposition,
) {
  const url = new URL(request.url);
  const [, prefix, appId, encodedBuildMarker, ...endpoint] = url.pathname.split('/');
  if (
    prefix !== 'module-api' ||
    appId === undefined ||
    encodedBuildMarker === undefined ||
    encodedBuildMarker === '' ||
    !/^[a-z][a-z0-9-]*$/u.test(appId)
  ) {
    return yield* new ModuleApiDispatchError({ reason: 'Module API release path is invalid', status: 400 });
  }
  const buildMarker = yield* Effect.try({
    catch: (cause) =>
      new ModuleApiDispatchError({ cause, reason: 'Module API release marker is malformed', status: 400 }),
    try: () => decodeURIComponent(encodedBuildMarker),
  });
  if (request.headers.get(MODULE_API_REVISION_HEADER) !== composition.revision) {
    return yield* new ModuleApiDispatchError({ reason: 'Reload the document to use the active release', status: 409 });
  }
  const module = composition.modules.find((candidate) => candidate.deployment.appId === appId);
  if (module === undefined) {
    return yield* new ModuleApiDispatchError({ reason: 'Module is not admitted in the active release', status: 404 });
  }
  if (module.deployment.buildMarker !== buildMarker) {
    return yield* new ModuleApiDispatchError({ reason: 'Module executable release has changed', status: 409 });
  }
  const ownerPath = `/${endpoint.join('/')}`;
  const decodedPath = yield* Effect.try({
    catch: (cause) => new ModuleApiDispatchError({ cause, reason: 'Module API path is malformed', status: 400 }),
    try: () => decodeURIComponent(ownerPath),
  });
  const ownerPrefix = `/${appId}-api`;
  if (
    (ownerPath !== ownerPrefix && !ownerPath.startsWith(`${ownerPrefix}/`)) ||
    decodedPath.includes('\\') ||
    decodedPath.includes('%') ||
    decodedPath.split('/').some((segment) => segment === '.' || segment === '..') ||
    /%2f|%5c/iu.test(ownerPath)
  ) {
    return yield* new ModuleApiDispatchError({ reason: 'Module API path is outside the owning BFF', status: 400 });
  }
  const forwardedUrl = new URL(ownerPath, 'https://module.invalid');
  forwardedUrl.search = url.search;
  const connection = request.headers.get('connection');
  const connectionHeaders = connection === null ? [] : connection.split(',').map((token) => token.trim().toLowerCase());
  if (connectionHeaders.some((token) => !connectionToken.test(token) || governedHeaders.has(token))) {
    return yield* new ModuleApiDispatchError({ reason: 'Module API Connection header is invalid', status: 400 });
  }
  const forwardedRequest = new Request(forwardedUrl, request);
  for (const name of ['cookie', 'host', ...hopByHopHeaders, ...connectionHeaders]) {
    forwardedRequest.headers.delete(name);
  }
  return { forwardedRequest, forwardedUrl, module };
});
