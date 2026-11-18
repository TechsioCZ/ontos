import { it } from 'effect-rstest';

import { runOrganizationConformance } from './support/organization-source-customer-conformance.spec.mts';

it.live(
  'actual source Organization completes company ICO and governed name roundtrip without future UUID policy seeds',
  () => runOrganizationConformance('identity'),
  1_200_000,
);
