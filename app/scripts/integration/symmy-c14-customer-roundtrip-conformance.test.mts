import { it } from 'effect-rstest';

import { runCustomerConformance } from './support/symmy-c14-customer-conformance.spec.mts';

it.live(
  'INTERNAL_C14 public customers match their native targets, search and fence disabled originators',
  () => runCustomerConformance('roundtrip'),
  480_000,
);
