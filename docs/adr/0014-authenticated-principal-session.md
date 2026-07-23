# ADR-0014: Authenticated Principal Session

Status: Accepted

BetterAuth sessions alone are not treated as logged-in OntOS users. Shell and Core only consider a user logged in when the BetterAuth session resolves through an active Principal Auth Binding to an active Principal in an active Tenant; this keeps authentication/session mechanics separate from OntOS principal identity and tenant validity.
