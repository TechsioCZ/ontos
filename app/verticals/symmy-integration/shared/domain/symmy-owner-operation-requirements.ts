/** Exact source-owned conditional identities. These keys describe availability, never permission grants. */
export const symmyOwnerOperationRequirementKey = (
  source: 'worker' | 'admission',
  providerEntrypointKey: string,
): string => `integration.symmy.requirement.${source}.${providerEntrypointKey}`;
