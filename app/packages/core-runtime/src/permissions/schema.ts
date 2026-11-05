export const ONTOS_SPICEDB_SCHEMA = `use expiration

definition principal {}

definition tenant {
  relation member: principal
  relation identity_admin: principal
  relation party_identity_manager: principal
  relation party_identity_merger: principal
  relation party_identity_reader: principal
  relation party_identity_reviewer: principal
  relation party_relationship_manager: principal
  relation support: principal
  permission access = member
  permission manage_identity = identity_admin & access
  permission manage_party_identity = party_identity_manager & access
  permission manage_party_relationships = party_relationship_manager & access
  permission merge_party_identity = party_identity_merger & access
  permission read_party_identity = party_identity_reader & access
  permission review_party_identity = party_identity_reviewer & access
  permission impersonate = support & access
}

// Namespace-qualified identity provisioning is granted to an exact Tenant and
// authentication namespace. It does not imply administrative lifecycle access.
definition identity_namespace {
  relation tenant: tenant
  relation provisioner: principal
  permission provision = provisioner & tenant->access
}

definition legal_entity {
  relation tenant: tenant
  relation member: principal
  relation counterparty_manager: principal
  relation counterparty_reader: principal
  permission access = member & tenant->access
  permission manage_counterparty = counterparty_manager & access
  permission read_counterparty = counterparty_reader & access
}

definition module_access {
  relation legal_entity: legal_entity
  relation accessor: principal
  permission access = accessor & legal_entity->access
}

definition resource {
  relation module: module_access
  relation reader: principal
  relation writer: principal
  permission read = reader & module->access
  permission write = writer & module->access
}

// Tenant-owned references remain independent of a selected Legal Entity.
// Assignment eligibility is an explicit target grant, never mere membership.
definition tenant_resource {
  relation tenant: tenant
  relation reader: principal
  relation writer: principal
  relation assignee: principal
  permission read = reader & tenant->access
  permission write = writer & tenant->access
  permission assign = assignee & tenant->access
}

// Each object ID encodes the stable permission code and exact tenant/business scope.
// Tenant-only Pricing targets use tenant access; existing Retail and Counterparty targets use Legal Entity access.
// A Price Group may inherit the same permission from its exact containing catalog through an explicit relation.
definition business_permission {
  relation tenant: tenant
  relation legal_entity: legal_entity
  relation containing_catalog: business_permission
  relation grantee: principal
  permission direct_use = grantee & (tenant->access + legal_entity->access)
  permission use = direct_use + (tenant->access & containing_catalog->direct_use)
}

// Named entrypoint permissions are exact to one Tenant, optional Legal Entity, and owning module.
// The object identity carries that scope; tenant membership remains an independent gate.
definition context_permission {
  relation tenant: tenant
  relation grantee: principal
  permission access = grantee & tenant->access
}

definition action {
  relation restriction: action
  relation executor: principal | tenant#member

  permission is_restricted = restriction
  permission execute = executor
}

// Authorization v2 engine: the reference schema v2.2, added next to the legacy definitions above,
// which it never reads or changes. Reference names gain an access_ prefix (company becomes
// access_legal_entity, so scope.company becomes access_scope.legal_entity), and the reference's
// humans-only principal becomes access_human: the legacy principal is the object ID space of every
// core.principals kind (human, service, integration, agent, system), so v2 relations accept only
// access_human (a verified human) and agent, and no other principal kind ever reaches a v2 tuple.
// Core is the only writer. Scope equality, cardinality, immutable incarnations, cell metadata and
// delegation containment are Core writer invariants, and so are: never projecting an agent into a
// run or approve cell of a sensitive or critical capability, and correlating a mandate's
// assignments with the exact assignments its grants bind (access_mandate). SpiceDB cannot relate
// two targets of one resource for the same subject, so those correlations are extra CheckBulk items
// Core proves in the same snapshot; a caveat without context or an indeterminate answer is denied
// (fail closed), and only a transport or deadline failure is unavailable. PostgreSQL owns intent and
// deadlines; Core's wall-clock fence stays mandatory even when a fully consistent datastore still
// serves a pre-expiry revision. Agent connection ceilings are Core intent, intersected outside the
// graph.
caveat amount_ceiling(amount_minor int, currency string, limit_minor int, limit_currency string) {
  amount_minor >= 0 && amount_minor <= limit_minor && currency == limit_currency
}

caveat target_set(resource_key string, resource_keys list<string>) {
  resource_key in resource_keys
}

caveat bounded_target_set(resource_key string, resource_keys list<string>, amount_minor int, currency string, limit_minor int, limit_currency string) {
  resource_key in resource_keys &&
  amount_minor >= 0 && amount_minor <= limit_minor && currency == limit_currency
}

definition agent {}

// A verified human. Only this type and agent appear in v2 relations; service, integration and
// system principals stay outside v2 (their own workload classification is legacy/O29).
definition access_human {}

definition access_tenant {
  relation member: access_human | access_human with expiration | agent | agent with expiration
  relation owner: access_human
  relation suspended: access_human | agent
  permission access = member - suspended
  permission administer = owner & access
}

definition access_legal_entity {
  relation tenant: access_tenant
  relation member: access_human | access_human with expiration | agent | agent with expiration
  relation access_admin: access_human
  relation suspended: access_human | agent
  permission access = (member & tenant->access) - suspended
  permission administer = ((access_admin & access) + tenant->administer) - suspended
  permission select = access + administer
}

definition access_scope {
  relation tenant: access_tenant
  // Exactly one context, never a null-legal-entity wildcard.
  relation legal_entity: access_legal_entity
  relation tenant_context: access_tenant
  permission access = (legal_entity->access + tenant_context->access) & tenant->access
  permission administer = (legal_entity->administer + tenant_context->administer) & tenant->access
  permission select = access + administer
}

definition access_installation {
  relation enabled_scope: access_scope
  permission access = enabled_scope->access
}

definition access_assignment {
  relation scope: access_scope
  // One holder, never reused after removal or replacement.
  relation holder: access_human | access_human with expiration
  relation agent_holder: agent | agent with expiration
  permission eligible = (holder + agent_holder) & scope->access
}

definition access_role_binding {
  relation scope: access_scope
  // One immutable revision in one scope. Assignment IDs survive role edits.
  relation member: access_assignment#holder
  relation agent_member: access_assignment#agent_holder
  permission eligible = (member + agent_member) & scope->access
  permission human_eligible = member & scope->access
}

definition access_delegation {
  relation scope: access_scope
  relation manager: access_human | access_human with expiration
  permission manage = manager & scope->access
}

definition access_capability {
  relation scope: access_scope
  relation installation: access_installation
  relation delegated_manager: access_delegation
  permission available = installation->access & scope->access
  // Management survives uninstall. It never implies business execution.
  permission configure = scope->administer + delegated_manager->manage

  relation run_all_grant: access_grant
  relation run_assigned_grant: access_grant
  relation run_entrusted_grant: access_grant
  relation run_team_grant: access_grant
  permission run_all = run_all_grant->use & available
  permission run_assigned = run_assigned_grant->use & available
  permission run_entrusted = run_entrusted_grant->use & available
  permission run_team = run_team_grant->use & available

  relation propose_all_grant: access_grant
  relation propose_assigned_grant: access_grant
  relation propose_entrusted_grant: access_grant
  relation propose_team_grant: access_grant
  permission propose_all = propose_all_grant->use & available
  permission propose_assigned = propose_assigned_grant->use & available
  permission propose_entrusted = propose_entrusted_grant->use & available
  permission propose_team = propose_team_grant->use & available

  relation approve_all_grant: access_grant
  relation approve_assigned_grant: access_grant
  relation approve_entrusted_grant: access_grant
  relation approve_team_grant: access_grant
  permission approve_all = approve_all_grant->human_use & available
  permission approve_assigned = approve_assigned_grant->human_use & available
  permission approve_entrusted = approve_entrusted_grant->human_use & available
  permission approve_team = approve_team_grant->human_use & available
}

definition access_grant {
  relation capability: access_capability
  // One complete cell per role revision x scope, not per assignee.
  // A personal grant is the SAME shape with a one-assignment binding.
  // Core checks the exact capability-slot -> grant -> binding -> assignment
  // userset links in the SAME CheckBulk snapshot, not independent allows: a
  // binding member is access_assignment:<id>#holder, so a witness on
  // binding->member for that exact userset subject correlates one incarnation.
  relation binding: access_role_binding | access_role_binding with amount_ceiling | access_role_binding with target_set | access_role_binding with bounded_target_set
  permission use = binding->eligible & capability->available
  permission human_use = binding->human_eligible & capability->available
}

definition access_team {
  relation scope: access_scope
  relation member: access_human | agent
  permission eligible = member & scope->access
}

definition access_projection {}

definition access_record {
  relation projection: access_projection
  relation scope: access_scope
  relation assigned: access_human | agent
  relation entrusted: access_human | agent
  relation team: access_team
  relation creator: access_human | agent
  // Predicates only. No portal, field, self-service or legacy bypass.
  permission assigned_match = assigned & scope->access
  permission entrusted_match = entrusted & scope->access
  permission team_match = team->eligible & scope->access
}

definition access_mandate {
  relation scope: access_scope
  relation executor: access_human with expiration
  relation execution_assignment: access_assignment
  relation approval_assignment: access_assignment
  relation execution_grant: access_grant
  relation approval_grant: access_grant
  // The executor is the approver (P5). A different member of the shared binding cannot revive the
  // approver's removed incarnation: Core binds membership incarnations and original cells, and on an
  // equal-or-broader role edit re-points grant witnesses atomically. Revocation events permanently
  // delete executor and mark the proposal lapsed.
  // use/human_use only prove the approver holds SOME assignment in each grant's binding, because a
  // permission cannot compare two relation targets. Core therefore proves, in the same CheckBulk
  // snapshot, that each grant's binding carries this mandate's exact assignment userset
  // (access_assignment:<id>#holder on access_role_binding#member) and that scope, assignments and
  // grants agree (O49).
  permission live = executor & execution_assignment->eligible & approval_assignment->eligible & execution_grant->human_use & approval_grant->human_use & scope->access
}`;
