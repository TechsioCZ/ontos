/**
 * The internal workloads (O73) a calling module runs as itself: a workload key the module's own Actions declare and its
 * own server acts as. Where the operator registered a principal for one (in a tenant), the platform issues that
 * principal's key next to the module key and hands it to the module, which then authenticates as the registered
 * workload exactly as before; nobody issues or copies such a key by hand. Such a workload is the platform's: no Tenant
 * administrator binds it to an integration (`core.identity.register-integration-workloads`).
 */
export const MODULE_INTERNAL_WORKLOADS: ReadonlyMap<string, readonly string[]> = new Map([
  ['crm', ['demo.crm.party-intake']],
  ['party-registry', ['party.registry.source-write', 'party.registry.source-read']],
  [
    'privacy',
    [
      'privacy.core.source-processing-check',
      'privacy.core.organization-business-check',
      'privacy.core.organization-profile-ico-check',
    ],
  ],
  ['commerce-customer-context', ['commerce.customer-context.organization-ico-facts.read']],
  ['symmy-integration', ['integration.symmy.source-organization-facts.read']],
]);
