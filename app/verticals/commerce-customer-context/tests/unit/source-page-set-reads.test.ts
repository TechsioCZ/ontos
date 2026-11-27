import { expect, it } from 'effect-rstest';
import { commerceCustomerContextRegisteredWorkloadCalls } from '../../src/registered-workload-calls.ts';
import { commerceCustomerContextManifest } from '../../vertical.manifest.ts';

const pageEntrypoint = 'commerce.customer-context.api.customer-profile-source-page';

it('proves a source-sync page through one declared requirement and one native-read rule per owner set read', () => {
  for (const [key, audience, provider] of [
    [
      'commerce.customer-context.requirement.customer-profile-source-page-admissions',
      'party-registry',
      'party.registry.api.source-admission-set',
    ],
    [
      'commerce.customer-context.requirement.customer-profile-source-page-privacy-set',
      'privacy',
      'privacy.core.api.source-processing-eligibility-set',
    ],
  ] as const) {
    const requirements = (commerceCustomerContextManifest.requirements?.operations ?? []).filter(
      (requirement) => requirement.key === key,
    );
    expect(requirements).toHaveLength(1);
    expect(requirements[0]?.entrypointKey).toBe(pageEntrypoint);
    expect(requirements[0]?.provider.entrypointKey).toBe(provider);
    const rules = commerceCustomerContextRegisteredWorkloadCalls.filter(
      (rule) =>
        rule.audience === audience &&
        rule.entrypointKey === provider &&
        rule.sourceWorkloadKey === 'commerce.customer-context.source-read' &&
        rule.jobKey === 'integration.symmy.execute-symmy-job' &&
        !('allowRecoverySource' in rule && rule.allowRecoverySource === true),
    );
    expect(rules).toHaveLength(1);
  }
});
