/**
 * Producer sources the signed-in role cannot read at all, known before any producer read is sent.
 *
 * The shell pins on the document the module ids its composition lists in the person's navigation (one entry for
 * every module whose `module.access` the principal holds), and every producer module behind a statistics source
 * contributes one. A source whose module is missing would answer 403, so the page treats it as refused up front
 * instead of sending the read. Without the shell's hint nothing is known and every source is read as before.
 */
import { documentNavigationModules } from '@app/shared-contracts';
import { Effect } from 'effect';

import type { StatisticsSource } from './use-statistics-inputs.ts';

const MERCHANDISE_MODULE = 'demo.merchandise';

/** The module that owns each producer read. */
const sourceModules = {
  customers: 'party.registry',
  employees: 'demo.workforce',
  invoices: 'finance.billing',
  movements: MERCHANDISE_MODULE,
  opportunities: 'demo.sales-pipeline',
  orders: MERCHANDISE_MODULE,
  products: MERCHANDISE_MODULE,
  tags: 'demo.tagging',
  tasks: 'work.tasks',
} as const satisfies Record<StatisticsSource, string>;

const statisticsSources = Object.keys(sourceModules).filter((source): source is StatisticsSource =>
  Object.hasOwn(sourceModules, source),
);

const noUnreadableSources: ReadonlySet<StatisticsSource> = new Set();

/** The sources whose module is missing from `modules`; none when the shell pinned no navigation. */
export const unreadableSourcesOf = (modules?: ReadonlySet<string>): ReadonlySet<StatisticsSource> =>
  modules === undefined
    ? noUnreadableSources
    : new Set(statisticsSources.filter((source) => !modules.has(sourceModules[source])));

/** Read from the shell's per-document hint: module access only changes with a reload of the document. */
export const unreadableSources = Effect.sync(() => unreadableSourcesOf(documentNavigationModules()));

/** The unreadable sources for the metric picker, known at the first render. */
export const useUnreadableSources = (): ReadonlySet<StatisticsSource> =>
  unreadableSourcesOf(documentNavigationModules());
