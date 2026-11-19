import { it } from 'effect-rstest';

import { runOrganizationConformance } from './support/organization-source-customer-conformance.spec.mts';

it.live(
  'actual source Organization completes native customer onboarding, memberships and original receipt recovery',
  () => runOrganizationConformance('membership'),
  1_200_000,
);
