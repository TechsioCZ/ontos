# ADR-0014: Authenticated Principal Session

Status: Accepted

BetterAuth sessions alone are not treated as logged-in OntOS users. Shell and Core only consider a user logged in when the BetterAuth session resolves through an active Principal Auth Binding to an active Principal in an active Tenant; this keeps authentication/session mechanics separate from OntOS principal identity and tenant validity.

One BetterAuth user may have active bindings to distinct tenant-scoped human Principals in multiple Tenants. An Authenticated Principal Session activates exactly one of those Tenants as session context. The selection grants no authority: every trusted-context resolution revalidates the exact active binding, Principal, and Tenant, and an invalid non-null selection fails closed without falling back to another Tenant. A new or legacy session with no selection uses the oldest eligible binding, breaking ties by Tenant ID. Switching Tenant updates only the current session and clears its active Legal Entity. API keys remain bound to exactly one Principal and Tenant.

This supersedes the former Day 3 one-BetterAuth-user/one-Tenant/no-selector decision. We rejected separate login accounts per Tenant because they fragment one person's authentication lifecycle, a global cross-Tenant Principal because it weakens tenant-scoped identity boundaries, and a client-trusted Tenant selector because context selection must never become authorization.
