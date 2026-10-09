---
name: pr-885-remediation-architecture-scope
overview: Establish the accepted deployment boundary for Commerce Market Catalog and reduce PR #885 to the architecture, generated registration, and global configuration changes that are demonstrably required by issues #333 and #346 before semantic remediation proceeds.
todos:
  - id: justify-market-catalog-boundary
    content: "Record and obtain review acceptance for retaining commerce-market-catalog as an independently deployable canonical Market owner, citing ADR-0017, MICROVERTICALS.md, the moduleId/appId distinction, and #346 exclusive ownership; if that boundary is rejected, stop and re-plan the Market files under the approved existing deployment before changing behavior."
    status: completed
  - id: classify-global-change-scope
    content: "Create a file-by-file scope ledger for PR #885's root package/lockfile/TS/Oxlint/Modern metadata, Shell client registration, topology, and Party Registry test changes, tying every retained edit to a generator output, runtime registration, owner contract, or validation requirement from #333/#346."
    status: completed
  - id: remove-unrelated-global-churn
    content: "Remove or revert every global, Shell, topology, or Party Registry change that the focused scope ledger cannot justify, while preserving generated artifacts that are required for the accepted Market deployment and public clients."
    status: completed
  - id: verify-generated-module-boundary
    content: "Re-run the repository-owned module-contract and registration generators/checks for the accepted boundary, then confirm manifests, entrypoints, topology ownership, Shell clients, and package metadata agree without hand-authored compatibility shims."
    status: completed
  - id: publish-scope-rationale
    content: "Update the PR implementation notes with the accepted deployment rationale, the retained global-change ledger, removed scope, and explicit external owner dependencies for Catalog and Pricing so reviewers can assess business semantics separately from deployment plumbing."
    status: completed
isProject: false
---

# pr-885-remediation-architecture-scope

## Execution Notes

This lane addresses audit findings T3.1 and T3.2 before behavioral changes make the branch harder to reshape. The current branch introduces a complete `app/verticals/commerce-market-catalog` deployment, while #346 explicitly says a planning capability does not by itself mandate a deployable module. Existing architecture does support strict independently deployable fact owners, but that rationale must be made explicit rather than inferred from the issue title.

The preferred direction is to retain the dedicated Market owner only after the architecture review confirms that its canonical tables, governed Actions/reads, and public client seam justify the deployment. This is not permission to create a separate deployment for every planning issue. If the decision changes, downstream Market plans must be rebased to the approved location before implementation.

Relevant authorities: `app/docs/architecture/MICROVERTICALS.md`, `app/docs/architecture/MODULE_MANIFESTS.md`, `app/docs/architecture/MODULE_ENTRYPOINTS.md`, `app/docs/architecture/COMMERCE_APPLICATIONS.md`, `docs/adr/0017-commerce-application-boundaries.md`, issue #346, and the T3 findings in the supplied audit.

## Constraints

- Issues #333 and #346 are HITL-frozen. Agents may read them but must not comment on, edit, label, close, or otherwise mutate them without explicit HITL approval. Do not edit or create any other GitHub issue.
- Do not change business semantics in this lane.
- Do not weaken generator, module-entrypoint, topology, lint, typecheck, or deployment checks.
- Do not preserve a global edit merely because the full branch currently passes CI; every retained edit needs a #333/#346 or generated-contract reason.
- Do not import another deployment's private source when adjusting the boundary.
- The open Catalog implementation in PR #873 and the absent Pricing implementation are external owner dependencies, not reasons to duplicate owner logic in Customer Context.
- Treat later-roadmap production journeys as parked handoffs, not as closure dependencies for the #333/#346 owner cutline.

## Operator Guidance

Run this plan first. Its final boundary decision gates the Market eligibility and Market retirement plans; the global-change cleanup can proceed concurrently with owner-contract analysis once the boundary is accepted. Use focused checks such as `mise exec -- pnpm check:module-contracts`, `mise exec -- pnpm module-entrypoints:check`, `mise exec -- pnpm contract:check`, and the exact generator check required by retained files. Do not run a repository-wide cleanup audit.
