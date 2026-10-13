/**
 * Producer sources the signed-in role cannot read at all, known before any producer read is sent.
 *
 * The shell composition lists a navigation entry for every module whose `module.access` the principal holds, and
 * every producer module behind a statistics source contributes one. A source whose module is missing from that list
 * would answer 403, so the page treats it as refused up front instead of sending the read. When the composition
 * cannot be read, or the shell is not in its `available` state, nothing is known and every source is read as before.
 */
import {
  Effect,
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
  makeEffectHttpApiClient,
} from '@modern-js/bff-effect/effect-client';
import { useEffect, useState } from 'react';

import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { StatisticsSource } from './use-statistics-inputs.ts';

/** Same-origin shell API prefix; the remote runs inside the shell document. */
const SHELL_API_PREFIX = '/shell-super-app-api';

/** The composition lookup only narrows reads, so a slow shell must not hold the page back for long. */
const COMPOSITION_TIMEOUT = '3 seconds';

const ShellModuleIdSchema = Schema.String.pipe(Schema.brand('ShellModuleId'));

/** Partial mirror of the shell composition response: only the navigation module ids and the state are read. */
const ShellNavigationApi = HttpApi.make('SalesInsightsShellNavigationApi').add(
  HttpApiGroup.make('composition').add(
    HttpApiEndpoint.get('shellComposition', '/shell/composition', {
      success: Schema.Struct({
        navigation: Schema.Array(Schema.Struct({ moduleId: ShellModuleIdSchema })),
        state: Schema.String,
      }),
    }),
  ),
);

const MERCHANDISE_MODULE = 'demo.merchandise';

/** The module that owns each producer read. */
const sourceModules = {
  customers: 'party.registry',
  employees: 'demo.workforce',
  invoices: 'siampark.billing-finance',
  movements: MERCHANDISE_MODULE,
  opportunities: 'demo.sales-pipeline',
  orders: MERCHANDISE_MODULE,
  products: MERCHANDISE_MODULE,
  tags: 'demo.tagging',
  tasks: 'siampark.work',
} as const satisfies Record<StatisticsSource, string>;

const statisticsSources = Object.keys(sourceModules).filter((source): source is StatisticsSource =>
  Object.hasOwn(sourceModules, source),
);

const noUnreadableSources: ReadonlySet<StatisticsSource> = new Set();

const lookupUnreadableSources = makeEffectHttpApiClient(ShellNavigationApi, { baseUrl: SHELL_API_PREFIX }).pipe(
  Effect.flatMap((client) => client.composition.shellComposition({})),
  Effect.map(({ navigation, state }): ReadonlySet<StatisticsSource> => {
    if (state !== 'available') {
      return noUnreadableSources;
    }
    const readable = new Set<string>(navigation.map(({ moduleId }) => moduleId));
    return new Set(statisticsSources.filter((source) => !readable.has(sourceModules[source])));
  }),
  Effect.timeout(COMPOSITION_TIMEOUT),
  Effect.orElseSucceed(() => noUnreadableSources),
);

/**
 * Read once per document: module access only changes with a sign-out or a legal entity switch, and both reload the
 * document. Concurrent callers share the one request.
 */
export const unreadableSources = browserRuntime.runSync(Effect.cached(lookupUnreadableSources));

/** The unreadable sources for the metric picker; empty until the composition answers. */
export const useUnreadableSources = (): ReadonlySet<StatisticsSource> => {
  const [sources, setSources] = useState<ReadonlySet<StatisticsSource>>(noUnreadableSources);
  useEffect(() => {
    let active = true;
    void browserRuntime.runPromise(
      unreadableSources.pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            if (active) {
              setSources(next);
            }
          }),
        ),
      ),
    );
    return () => {
      active = false;
    };
  }, []);
  return sources;
};
