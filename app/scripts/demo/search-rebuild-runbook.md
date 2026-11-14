# Governed search rebuilds on stage

Search uses owner projections in the Core index. A rebuild is an audited owner Action, not a direct database update or a second query path.

## Original-demo operator policy

The approved operator is `obchod@demo.ontos` in the original demo tenant, `70000000-0000-4000-8000-000000000020`. It must already belong to that tenant's existing `superadmin` scoped role. This procedure never creates or changes a role, membership, business permission, reader grant or module access.

Optional owner rebuild Actions use **tenant ingress**. The native `action.tenant_scope → tenant.write_all` rule gives execution to the existing tenant superadmins, not company administrators. The exact writable allowlist is:

- `demo.crm.request-search-rebuild`
- `demo.merchandise.request-search-rebuild`
- `demo.sales-pipeline.request-search-rebuild`
- `work.tasks.request-search-rebuild`
- `finance.billing.request-search-rebuild`
- `legal.agreements.request-search-rebuild`
- `facility.operations.request-search-rebuild`
- `commerce.market-catalog.request-search-rebuild`
- `demo.workforce.request-search-rebuild`
- `projects.core.request-search-rebuild`
- `core.identity.request-people-search-rebuild`, whose Action forbids company context

Each writable relationship is an `action.tenant_scope` link to the original demo tenant. No `action_grant.role`, company scope, module, resource or membership relationship is writable in this policy.

The eleven-link tenant policy never changes property scopes. The two Workforce and Projects links are not in the nine links installed on 2 November; they are created only by a new reviewed plan and apply, and the verified installation receipts below stay historical. A separate, approved drift repair restores exactly two source-declared `action.company_scope` links at Nájempark, `71000000-0000-4000-8000-000000000021`: `property.portfolio.request-search-rebuild` and `property.leasing.request-search-rebuild`. Its independent allowlist permits only those two CREATE operations. Native source derivation, the full company-admin and tenant-superadmin role graph, unchanged unrelated links and the complete gaining-principal list must pass before apply. It never repairs memberships or other missing grants. Party Registry keeps its existing tenant-membership-default Action policy and uses its already admitted original-demo company context. These ingress choices do not change the rebuild workers' complete-tenant snapshot scope.

The playground tenant is excluded. Its administrator performs a separately reviewed rebuild in that tenant. Never give playground access to the original-demo operator.

## Plan, review, apply, verify

Use the deployed native APIs:

1. `searchStageSource` validates the current published Action catalog.
2. `scopedActionRoleBootstrapRelationships` derives the approved tenant ingress relationships. Retain only the exact allowlisted `action.tenant_scope` links.
3. `planSearchStagePolicy` builds the read-only plan. Read the tenant's complete `superadmin` userset and every membership of its referenced role. Record exactly which principals gain execution. Stop on any unexpected principal or userset. Missing memberships of other demo accounts do not authorize repairing them.
4. Bind the reviewed fingerprint to the native plan, deployed composition, operator implementation, existing authority graph, unchanged required property scopes and unrelated Action relationships. Persist plans and receipts with restrictive permissions.
5. `runSearchStagePolicy` applies only the reviewed missing links with native preconditions. An additional write guard must reject any relationship outside the allowlist, including TOUCH, DELETE and membership updates.
6. Verify the exact links and unchanged authority/required scopes. Positively establish that the negative control is an existing company administrator but not a tenant superadmin. Its execution of every tenant-ingress rebuild Action must remain denied.

Approved links remain installed for future rebuilds. Keep the verified installation fingerprint and receipts with the operator evidence. This runbook is the approved policy, not proof that an installation or rebuild has completed.

Do not use the broad demo-policy installer to work around unrelated missing memberships. The ŠroubShop account installer owns its memberships after cutover. Any missing rental seed membership must be investigated separately.

## Rebuild one owner at a time

After the target release is verified live:

1. Acquire a bounded deployment quiet window. Do not block separately authorized read-only checks.
2. Read the unfiltered native inventory with `scripts/outbox-dead-delivery.mts list --limit 500`. Any dead delivery stops further deploys and rebuild requests until its cause and an exact operator resolution are approved.
3. Capture the read-only projection/outbox state. Plan one owner's Action with a fresh session, exact ingress, composition and durable idempotency key.
4. Review the fingerprint, then apply once. Do not repeat an uncertain Action request.
5. Verify completed delivery evidence, newer reserved generation and each resource-type rebuild floor/fingerprint. An Action acknowledgement alone is not completion. Previously approved released deliveries are settled history, not evidence that this rebuild succeeded.
6. Read the **all-tenant, all-worker** dead list again before requesting the next owner. Stop on any failure. Do not release or redrive it automatically.
7. After all owners, verify the requested staff accounts, positive cross-company canaries, public IČO/e-mail queries, Czech groups and latency against the saved baseline.
8. Run the final unfiltered dead list immediately before releasing the quiet window.

Owner migrations run only through normal deployment. The app host's dead-delivery preflight runs before owner DDL or authority draining. Failure to read the inventory is not an empty inventory. Existing dead work is never silently ignored.

## Verified installations on 2 November 2026

Both plans used verified release `c793c93ee6e67d564bbe41e65ab577336fe1bfc2` and composition `e78ec4074bcfd585ca06fb270e781ea5003ff64cbb73d6ef3aa8ea0967670bef`.

- Tenant ingress: fingerprint `4796359d7cfbed5a81376217e519c0a156fc5e01853df2ef1c9a1d1313164063`, native digest `d05bc49168c1d2b79d4b0132bbb2051cfce86c86fd4a2268697bab1378722b42`. Apply created exactly nine links; explicit verify checked 1,470 decisions. The sole gaining principal was the existing `obchod@demo.ontos` tenant superadmin. Existing company admin `management@najempark.demo` remained denied for all nine tenant Actions.
- Property drift: fingerprint `3fff1b2cb4b07ff52aaa1116ff70b96c61e985324cf3c324926d2c50dbf3ec93`, native digest `eeaf5cc82ba9881dd4bfcfbf1c23281edfb4d6b47d4cb18bdddcddf172ff7e59`. Apply created exactly two company-scope links; explicit verify checked 42 decisions. The only gaining principals were the source-declared company admins `obchod@demo.ontos` and `management@najempark.demo`. The complete role graph matched source, and no memberships changed.

These installation receipts do not prove rebuild completion. Keep the separate owner plan fingerprints, acknowledgement journals, persisted generation/floor proofs and post-owner all-dead checks for each rebuild.
