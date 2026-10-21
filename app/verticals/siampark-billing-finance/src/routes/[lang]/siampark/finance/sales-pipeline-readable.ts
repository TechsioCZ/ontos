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
const MERCHANDISE_MODULE = 'demo.merchandise';

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

export const referenceAccessFromComposition = ({
  navigation,
  state,
}: {
  readonly navigation: readonly { readonly moduleId: string }[];
  readonly state: string;
}) => {
  const modules = new Set(navigation.map(({ moduleId }) => moduleId));
  // An unavailable composition is inconclusive. Keep the provider's own authorization and error handling.
  return {
    opportunitiesReadable: state !== 'available' || modules.has(SALES_PIPELINE_MODULE),
    productsReadable: state !== 'available' || modules.has(MERCHANDISE_MODULE),
  };
};

const lookupReferenceAccess = makeEffectHttpApiClient(ShellNavigationApi, { baseUrl: SHELL_API_PREFIX }).pipe(
  Effect.flatMap((client) => client.composition.shellComposition({})),
  Effect.map(referenceAccessFromComposition),
  Effect.timeout(COMPOSITION_TIMEOUT),
  Effect.orElseSucceed(() => ({ opportunitiesReadable: true, productsReadable: true })),
);

/**
 * Read once per document: module access only changes with a sign-out or a legal entity switch, and both reload the
 * document. Concurrent callers share the one request.
 */
export const financeReferenceAccess = financeBrowserRuntime.runSync(Effect.cached(lookupReferenceAccess));

const PROPERTY_MODULE = 'siampark.property';
const AGREEMENTS_MODULE = 'siampark.agreements';

/** Siampark object modules (property/unit, contracts) the company can read; other companies get no object picker. */
export const objectAccessFromComposition = ({
  navigation,
  state,
}: {
  readonly navigation: readonly { readonly moduleId: string }[];
  readonly state: string;
}) => {
  const modules = new Set(navigation.map(({ moduleId }) => moduleId));
  return {
    contractsReadable: state !== 'available' || modules.has(AGREEMENTS_MODULE),
    propertiesReadable: state !== 'available' || modules.has(PROPERTY_MODULE),
  };
};

const lookupObjectAccess = makeEffectHttpApiClient(ShellNavigationApi, { baseUrl: SHELL_API_PREFIX }).pipe(
  Effect.flatMap((client) => client.composition.shellComposition({})),
  Effect.map(objectAccessFromComposition),
  Effect.timeout(COMPOSITION_TIMEOUT),
  Effect.orElseSucceed(() => ({ contractsReadable: true, propertiesReadable: true })),
);

export const financeObjectAccess = financeBrowserRuntime.runSync(Effect.cached(lookupObjectAccess));
