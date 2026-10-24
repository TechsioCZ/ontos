export const ONTOS_SPICEDB_SCHEMA = `definition principal {
  relation tenant: tenant
  relation operator: principal
  relation self: principal
  permission manage_own_credentials = self & tenant->access
  permission operate = operator & tenant->access
}

// Membership is assigned explicitly. A role never creates a company membership.
// Object identity encodes the exact tenant, optional company, and role key.
definition scoped_role {
  relation member: principal
}

definition tenant {
  relation member: principal
  // Owned only by the current SQL company-membership projection.
  relation company_member: principal
  relation context_role: scoped_role#member
  relation superadmin: scoped_role#member
  relation auditor: scoped_role#member
  relation identity_admin: principal | scoped_role#member
  relation party_identity_manager: principal | scoped_role#member
  relation party_identity_merger: principal | scoped_role#member
  relation party_identity_reader: principal | scoped_role#member
  relation party_identity_reviewer: principal | scoped_role#member
  relation party_relationship_manager: principal | scoped_role#member
  relation support: principal | scoped_role#member
  permission access = member + company_member
  permission select_context = (context_role + superadmin + auditor) & access
  permission manage_own_credentials = (member->manage_own_credentials + company_member->manage_own_credentials) & access
  permission read_all = (superadmin + auditor) & access
  permission write_all = superadmin & access
  permission manage_identity = (identity_admin + superadmin) & access
  permission read_people = (identity_admin + superadmin + auditor) & access
  permission manage_party_identity = (party_identity_manager + superadmin) & access
  permission manage_party_relationships = (party_relationship_manager + superadmin) & access
  permission merge_party_identity = (party_identity_merger + superadmin) & access
  permission read_party_identity = (party_identity_reader + superadmin + auditor) & access
  permission review_party_identity = (party_identity_reviewer + superadmin) & access
  permission impersonate = (support + superadmin) & access
}

// Namespace-qualified identity provisioning is granted to an exact Tenant and
// authentication namespace. It does not imply administrative lifecycle access.
definition identity_namespace {
  relation tenant: tenant
  relation provisioner: principal | scoped_role#member
  permission provision = provisioner & tenant->access
}

definition legal_entity {
  relation tenant: tenant
  relation member: principal
  relation admin: scoped_role#member
  relation auditor: scoped_role#member
  relation counterparty_manager: principal | scoped_role#member
  relation counterparty_reader: principal | scoped_role#member
  permission access = (member + tenant->read_all) & tenant->access
  permission read_all = (admin + auditor + tenant->read_all) & access
  permission write_all = (admin + tenant->write_all) & access
  permission manage_people = write_all
  permission read_people = read_all
  permission manage_counterparty = (counterparty_manager + write_all) & access
  permission read_counterparty = (counterparty_reader + read_all) & access
}

definition module_access {
  relation legal_entity: legal_entity
  relation accessor: principal
  relation accessor_role: scoped_role#member
  relation reader_role: scoped_role#member
  relation writer_role: scoped_role#member
  permission access = (accessor + accessor_role + reader_role + writer_role + legal_entity->read_all) & legal_entity->access
  permission read_all = (reader_role + writer_role + legal_entity->read_all) & access
  permission write_all = (writer_role + legal_entity->write_all) & access
}

definition resource {
  relation module: module_access
  relation reader: principal | scoped_role#member
  relation writer: principal | scoped_role#member
  permission read = (reader + module->read_all) & module->access
  permission write = (writer + module->write_all) & module->access
}

// Named permissions explicitly declare their read/write scope; auditor rights
// never depend on guessing a permission name or copying another person's grants.
// Customer self-service grants name one exact profile without conferring company membership.
// A Price Group may inherit the same permission from its exact containing catalog.
definition business_permission {
  relation tenant: tenant
  relation legal_entity: legal_entity
  relation containing_catalog: business_permission
  relation grantee: principal
  relation role_grantee: scoped_role#member
  relation read_scope: tenant | legal_entity
  relation write_scope: tenant | legal_entity
  // Written only for exact customer-profile grants; it does not confer tenant/company membership.
  relation self_service_grantee: principal
  permission role_use = role_grantee & (tenant->access + legal_entity->access)
  permission direct_use = (grantee + role_use + read_scope->read_all + write_scope->write_all) & (tenant->access + legal_entity->access)
  permission use = self_service_grantee + direct_use + (tenant->access & containing_catalog->direct_use)
}

// Direct grants are retired at each owner's role cutover. Role grants always
// carry an exact business scope, including the company membership gate.
definition context_permission {
  relation tenant: tenant
  relation legal_entity: legal_entity
  relation tenant_scope: tenant
  relation grantee: principal
  relation role_grantee: scoped_role#member
  relation read_scope: tenant | legal_entity
  relation write_scope: tenant | legal_entity
  permission role_access = role_grantee & (legal_entity->access + tenant_scope->access)
  permission access = (grantee + role_access + read_scope->read_all + write_scope->write_all) & tenant->access
}

// Role policy is durable even when the owning module is uninstalled.
definition action_grant {
  relation role: scoped_role#member
  relation proposer_role: scoped_role#member
}

definition action {
  relation company_scope: legal_entity
  relation tenant_scope: tenant
  relation grant: action_grant
  relation self_credentials: tenant

  permission scope_access = company_scope->access + tenant_scope->access
  permission execute = ((grant->role + self_credentials->manage_own_credentials) & scope_access) + company_scope->write_all + tenant_scope->write_all
  permission propose = (grant->proposer_role & scope_access) + execute
}`;
