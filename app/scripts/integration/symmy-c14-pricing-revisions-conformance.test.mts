import { it } from 'effect-rstest';

import { runPricingRoutesConformance } from './support/symmy-c14-pricing-routes-conformance.spec.mts';

it.live(
  'INTERNAL_C14 Price List routes preserve source identity, independent lists, paging and current revisions',
  () => runPricingRoutesConformance('revisions'),
  900_000,
);
