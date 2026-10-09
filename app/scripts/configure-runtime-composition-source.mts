import { Effect, Redacted } from 'effect';

import { ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY } from '../packages/core-runtime/src/modules/active-application-composition-edge.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ActiveApplicationCompositionPublicationError,
} from './active-application-composition.mts';
import { ZeropsPublicApi } from './zerops-public-api.mts';
import { ZeropsApiError } from './zerops-public-api-error.mts';

const SOURCE_URL_VARIABLE = ACTIVE_APPLICATION_COMPOSITION_POLICY.sourceUrlVariable;
const READ_TOKEN_VARIABLE = 'ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN';

const invalid = () =>
  new ActiveApplicationCompositionPublicationError({
    message: 'the composition URL must select the shared active value at a native Cloudflare KV endpoint',
    reason: 'invalid_observation',
  });

/** Only the native provider endpoint may receive the composition credential. */
export const validateNativeCompositionSourceUrl = (value: string) =>
  Effect.gen(function* validateSourceUrl() {
    const url = yield* Effect.try({ catch: invalid, try: () => new URL(value) });
    if (
      url.origin !== 'https://api.cloudflare.com' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !url.pathname.endsWith(`/values/${ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY}`) ||
      !/^\/client\/v4\/accounts\/[a-f\d]{32}\/storage\/kv\/namespaces\/[a-f\d]{32}\/values\/[^/]+$/u.test(url.pathname)
    ) {
      return yield* invalid();
    }
    return value;
  });

/** Configure the stable Node source once; publishing releases only changes KV bytes. */
export const configureRuntimeCompositionSource = (input: {
  readonly projectId: string;
  readonly readToken: Redacted.Redacted;
  readonly url: string;
}) =>
  Effect.gen(function* configureSource() {
    const url = yield* validateNativeCompositionSourceUrl(input.url);
    const readToken = Redacted.value(input.readToken);
    if (readToken.trim() === '') {
      return yield* new ActiveApplicationCompositionPublicationError({
        message: 'the native composition source requires a read credential',
        reason: 'invalid_observation',
      });
    }
    const api = yield* ZeropsPublicApi;
    const environment = yield* api.projectEnvs(input.projectId);
    const source = environment.find(({ key }) => key === SOURCE_URL_VARIABLE);
    if (source?.content !== url) {
      yield* api.upsertProjectEnv(input.projectId, source, SOURCE_URL_VARIABLE, url, false);
    }
    // Always enforce sensitivity, including when an old value was stored as a plain variable.
    yield* api.upsertProjectEnv(
      input.projectId,
      environment.find(({ key }) => key === READ_TOKEN_VARIABLE),
      READ_TOKEN_VARIABLE,
      readToken,
      true,
    );
    return yield* Effect.void;
  }).pipe(
    Effect.catchTag('ZeropsApiError', () =>
      Effect.fail(new ZeropsApiError({ message: 'runtime composition source configuration failed' })),
    ),
  );
