# ADR-0019: Action authorization is explicit and fail-closed

Status: Accepted.

Scope: Action authorization. [Issue #173](https://github.com/TechsioCZ/ontos/issues/173)
tracks wider protected-entrypoint implementation and readiness;
[issue #369](https://github.com/TechsioCZ/ontos/issues/369) owns the separate production-promotion
approval gate.

Every Action requires explicit SpiceDB authorization configuration. Missing configuration denies
execution; it is never an implicit allow rule. The default authorization rule is an explicit
allow-everyone grant from an Action to the membership set of its trusted Tenant. In this decision,
"everyone" means every authenticated, active Principal who is a member of that Tenant. It does not
include anonymous callers, inactive Principals, Principals from another Tenant, or a global
Principal wildcard. An Action may replace this default with a narrower explicit rule when its
authorization requirements demand it.

The default rule is provisioned as environment data rather than implemented as an application-code
bypass. If the rule is absent, incomplete, or removed, the Action is unconfigured and execution is
denied. Development and stage provisioning materialize the same rule separately for each fixed
Tenant; neither environment receives an implicit exception in the runtime.

This keeps authorization behavior identical in development and production while making broad
development access intentional, inspectable, testable, and removable. Provisioning and validation
must ensure each externally reachable Action is explicitly classified; an absent or indeterminate
classification fails closed.

The rollout is ordered to avoid locking every caller out:

1. Expand the SpiceDB schema so an Action executor may reference `tenant#member`; this remains
   compatible with existing direct Principal grants.
2. In an isolated Locki sandbox, prove missing-rule denial and user-facing denial feedback, then
   provision the explicit default membership-set grants and prove allowed execution.
3. Through the fixed operator-invoked stage bootstrap, provision each intended Action-to-stage-
   Tenant-membership relationship and verify representative allowed and denied checks.
4. Only after those relationships are verified, deploy the runtime behavior that treats a missing
   Action rule as a denial.

This stage provisioning is authorization environment data, not a PostgreSQL migration and not an
automatic application-startup side effect. The sandbox proof does not write to stage.
