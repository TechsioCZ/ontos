import { it } from 'effect-rstest';

import { runPricingRoutesConformance } from './support/symmy-c14-pricing-routes-conformance.spec.mts';

it.live(
  'INTERNAL_C14 Price List routes recover exact native receipts and fence route deactivation',
  () => runPricingRoutesConformance('recovery'),
  900_000,
);
