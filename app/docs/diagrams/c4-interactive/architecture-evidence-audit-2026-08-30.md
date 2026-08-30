# OntOS architecture evidence audit — 2026-08-30

## Conclusion

The C4 diagrams describe the accepted **logical target architecture** accurately. They must not be presented as a 100% finalized **physical production deployment** because [Wayrepo #17](https://github.com/TSNheathen/wayrepo/issues/17) is still open.

The diagrams deliberately separate three evidence classes:

1. **Accepted target:** settled product and logical architecture decisions.
2. **Current implementation exemplar:** develop-branch code that proves an implementation pattern but is not the final Commerce design.
3. **Current Stage deployment:** the concrete Zerops services declared by `app/zerops.yaml`, without extrapolating a production topology.

## Scope and method

- OntOS branch: `develop`
- OntOS revision: `b07ec16fe7657f947f15724191caf3f09d13dfd7`
- Wayrepo branch: `main`
- Wayrepo revision: `bfa07e91cb4ebc22a72f8a58525c562e4fab3d23`
- GitHub issue inventories enumerated through the authenticated GitHub API:
  - `TechsioCZ/ontos`: 75 issues total, 17 open, 58 closed.
  - `TSNheathen/wayrepo`: 17 issues total, 7 open, 10 closed.
- Every issue was included in the inventory. Architecture-bearing issues and their current/superseding conclusions were then inspected in detail; domain-only Projects and Task Collection issues were checked for boundary implications.

## Accepted target decisions reflected in the diagrams

| Decision | Evidence | Diagram consequence |
| --- | --- | --- |
| OntOS is the product; Core is a small kernel; Commerce is a reusable Application Composition; Akros and N1 are Customer Configurations, not forks. | [Wayrepo #7](https://github.com/TSNheathen/wayrepo/issues/7), `docs/product/ontos-application-composition-vocabulary.md` | L1 names one OntOS system. L2 separates Core, applications, and independently deployable modules. |
| One shared native B2C/B2B backend; independently deployed storefronts with local BFFs; thin Storefront API; separate Commerce Operations staff app. | [Wayrepo #9](https://github.com/TSNheathen/wayrepo/issues/9), [Wayrepo #11](https://github.com/TSNheathen/wayrepo/issues/11), `app/docs/architecture/COMMERCE_APPLICATIONS.md` | L1 keeps storefronts outside the standard OntOS runtime. L2 shows Storefront API and Commerce Operations separately. |
| Staff and Portal Account identities use separate BetterAuth realms; every storefront has a tenant-bound Storefront Client. | [Wayrepo #11](https://github.com/TSNheathen/wayrepo/issues/11), `app/docs/architecture/COMMERCE_APPLICATIONS.md` | L2 shows two identity realms and the tenant-bound storefront path. |
| Every Foundational or Business Module is an independently deployable MicroVertical; co-location does not erase ownership seams. | [OntOS #93](https://github.com/TechsioCZ/ontos/issues/93), ADR 0017 | L2 groups Foundational and Business MicroVerticals while preserving owner-local implementation, persistence, migrations, and workers. |
| Application Composition chooses implementations and preserves the required dependency DAG and transitive closure. | [OntOS #92](https://github.com/TechsioCZ/ontos/issues/92) | L2 and L3 show composition/DAG governance and affected-entrypoint degradation. |
| One session selects one tenant; selection is not authorization; binding, Principal, and tenant are revalidated. | [OntOS #94](https://github.com/TechsioCZ/ontos/issues/94) | L3 makes trusted context and fail-closed revalidation explicit. |
| Party Registry owns Party identity and relationships; Connector Registry owns provider correlations; CRM and Commerce own profiles and workflows. | [OntOS #95](https://github.com/TechsioCZ/ontos/issues/95) | L2 names Party Registry as a Foundational MicroVertical. L4 is marked as a current exemplar whose non-live customer/contact model may be replaced. |
| Symmy is preferred but non-exclusive; payments and unsupported routes use direct adapters; each system/fact has one explicit route. | [OntOS #96](https://github.com/TechsioCZ/ontos/issues/96), [Wayrepo #8](https://github.com/TSNheathen/wayrepo/issues/8) | L1 and L2 show explicit Symmy-or-direct integration routing without making Symmy a universal gateway. |
| Core prevents duplicate business effects but does not store arbitrary business response payloads. | [OntOS #97](https://github.com/TechsioCZ/ontos/issues/97), [Wayrepo #10](https://github.com/TSNheathen/wayrepo/issues/10) | L3 distinguishes Core evidence/deduplication from owner-domain result reconstruction. |

## Open decisions that prevent a “100% final physical architecture” claim

| Open issue | Remaining architectural uncertainty |
| --- | --- |
| [Wayrepo #12](https://github.com/TSNheathen/wayrepo/issues/12) | Full workflow/consistency contract and failure guarantees across module boundaries. The Order commitment point is known, but the GitHub decision ticket remains open. |
| [Wayrepo #13](https://github.com/TSNheathen/wayrepo/issues/13) | Migration, coexistence, and cutover shape. |
| [Wayrepo #14](https://github.com/TSNheathen/wayrepo/issues/14) | Production acceptance and readiness criteria. |
| [Wayrepo #15](https://github.com/TSNheathen/wayrepo/issues/15) | Milestone and delivery sequencing. |
| [Wayrepo #16](https://github.com/TSNheathen/wayrepo/issues/16) | Audit completeness and final specification handoff. |
| [Wayrepo #17](https://github.com/TSNheathen/wayrepo/issues/17) | Production topology: isolated/shared/hybrid tenancy, service and worker placement, databases and schemas, BetterAuth and SpiceDB placement, object storage, regions/residency, secrets, backup/restore, observability, cost, ownership, and the Akros launch topology. |

OntOS open issue [#163](https://github.com/TechsioCZ/ontos/issues/163) is documentation consolidation and does not change behavior. The other open OntOS issues in the inspected inventory primarily specify Projects/Task Collection domain behavior; they reinforce tenant, Principal, and SpiceDB boundaries but do not settle Wayrepo #17.

## Zerops Stage evidence

`app/zerops.yaml` calls itself **Stage deployment topology** and declares four setups:

| Setup | Evidence |
| --- | --- |
| `migrator` | Builds the workspace, runs Core/Auth/Projects migrations and runtime-role bootstrap, verifies the application schema, and exposes `/ready` on port 8080. |
| `spicedb` | Runs `authzed/spicedb:v1.56.0`, exposes gRPC 50051 and health 8443, and uses PostgreSQL as its datastore. |
| `projects` | Runs the materialized Projects artifact on port 4101 with readiness at `/projects-api/projects/readiness`. |
| `shellsuperapp` | Runs the materialized Shell artifact on port 3020 with root readiness. |

The manifest references a managed `db` service for administrative PostgreSQL access but does not declare that service as a setup in this file. Application runtime `DATABASE_URL` injection is likewise provider configuration outside the manifest. The deployment diagram records these as explicit evidence limits instead of inventing configuration.

Authoritative deployment guidance remains `app/docs/architecture/DEPLOYMENT.md`: build once and promote immutable artifacts, deploy providers before consumers, keep installation separate from tenant activation, preserve owner-local migrations, use compatible overlap/rollback, deploy Shell after providers are ready, and canary tenant activation.

## Diagram reading contract

- **L1 System Context:** accepted product/system boundary, with implementation status annotated.
- **L2 Accepted Target Containers:** accepted logical target; not a physical placement promise.
- **L3 Core Runtime Components:** accepted kernel/owner responsibility contract.
- **L4 Current Projects Exemplar:** develop-branch implementation evidence only.
- **Zerops Stage Deployment:** concrete Stage manifest evidence only.

The diagrams can be shared as the strongest currently supportable architecture package if this distinction remains attached. Calling the physical deployment “final” should wait until Wayrepo #17 is decided and the diagrams are updated from that decision.
