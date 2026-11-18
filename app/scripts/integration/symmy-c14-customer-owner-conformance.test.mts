import { it } from 'effect-rstest';

import { runCustomerConformance } from './support/symmy-c14-customer-conformance.spec.mts';

it.live(
  'INTERNAL_C14 actual public customers create and read back their native targets under current Privacy',
  () => runCustomerConformance('readback'),
  480_000,
);
