/**
 * Whether the signed-in role can read the sales pipeline at all, known before any opportunity read is sent.
 *
 * The shell composition lists a navigation entry for every module whose `module.access` the principal holds. When
 * the sales pipeline is missing from that list its read would answer 403, so the invoice references skip it. When
 * the composition cannot be read, or the shell is not in its `available` state, the read is sent as before.
 */
import {
  Effect,
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
  makeEffectHttpApiClient,
} from '@modern-js/bff-effect/effect-client';

import { financeBrowserRuntime } from '../../../../runtime/browser.ts';

/** Same-origin shell API prefix; the remote runs inside the shell document. */
const SHELL_API_PREFIX = '/shell-super-app-api';

/** The composition lookup only narrows reads, so a slow shell must not hold the page back for long. */
const COMPOSITION_TIMEOUT = '3 seconds';

const SALES_PIPELINE_MODULE = 'demo.sales-pipeline';

const ShellModuleIdSchema = Schema.String.pipe(Schema.brand('ShellModuleId'));

/** Partial mirror of the shell composition response: only the navigation module ids and the state are read. */
const ShellNavigationApi = HttpApi.make('FinanceShellNavigationApi').add(
  HttpApiGroup.make('composition').add(
    HttpApiEndpoint.get('shellComposition', '/shell/composition', {
      success: Schema.Struct({
        navigation: Schema.Array(Schema.Struct({ moduleId: ShellModuleIdSchema })),
        state: Schema.String,
      }),
    }),
  ),
);

const lookupSalesPipelineReadable = makeEffectHttpApiClient(ShellNavigationApi, { baseUrl: SHELL_API_PREFIX }).pipe(
  Effect.flatMap((client) => client.composition.shellComposition({})),
  Effect.map(
    ({ navigation, state }) =>
      state !== 'available' || new Set<string>(navigation.map(({ moduleId }) => moduleId)).has(SALES_PIPELINE_MODULE),
  ),
  Effect.timeout(COMPOSITION_TIMEOUT),
  Effect.orElseSucceed(() => true),
);

/**
 * Read once per document: module access only changes with a sign-out or a legal entity switch, and both reload the
 * document. Concurrent callers share the one request.
 */
export const salesPipelineReadable = financeBrowserRuntime.runSync(Effect.cached(lookupSalesPipelineReadable));
