CREATE TABLE "core"."access_agent_connections" (
	"agent_id" uuid NOT NULL,
	"ceiling_json" jsonb NOT NULL,
	"connection_id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"scope_id" uuid NOT NULL,
	"status" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	CONSTRAINT "access_connections_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "access_connections_period_ck" CHECK ("valid_from" < "valid_until"),
	CONSTRAINT "access_connections_ceiling_ck" CHECK (jsonb_typeof("ceiling_json") = 'object'),
	CONSTRAINT "access_connections_status_ck" CHECK ("status" in ('active', 'revoked', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "core"."access_agent_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_assignments" (
	"agent_id" uuid,
	"assigned_by" uuid NOT NULL,
	"delegated_by" uuid,
	"delegation_envelope_json" jsonb,
	"incarnation_id" uuid PRIMARY KEY,
	"principal_id" uuid,
	"role_id" uuid NOT NULL,
	"role_revision_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"status" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	CONSTRAINT "access_assignments_holder_xor_ck" CHECK (("principal_id" is null) <> ("agent_id" is null)),
	CONSTRAINT "access_assignments_period_ck" CHECK ("valid_until" is null or "valid_from" < "valid_until"),
	CONSTRAINT "access_assignments_status_ck" CHECK ("status" in ('active', 'revoked', 'expired')),
	CONSTRAINT "access_assignments_envelope_ck" CHECK (("delegated_by" is null and "delegation_envelope_json" is null) or ("delegated_by" is not null and "delegation_envelope_json" is not null and "valid_until" is not null and jsonb_typeof("delegation_envelope_json") = 'object'))
);
--> statement-breakpoint
ALTER TABLE "core"."access_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_catalog_entries" (
	"capability_key" text,
	"catalog_snapshot_id" uuid,
	"entry_json" jsonb NOT NULL,
	CONSTRAINT "access_catalog_entries_pk" PRIMARY KEY("catalog_snapshot_id","capability_key"),
	CONSTRAINT "access_catalog_entry_key_ck" CHECK ("capability_key" ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*(\.[a-z][a-z0-9]*([-_][a-z0-9]+)*){2,}$' and length("capability_key") <= 200),
	CONSTRAINT "access_catalog_entry_json_ck" CHECK (jsonb_typeof("entry_json") = 'object' and "entry_json"->>'key' is not distinct from "capability_key")
);
--> statement-breakpoint
CREATE TABLE "core"."access_catalog_snapshots" (
	"catalog_snapshot_id" uuid PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"digest" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "access_catalog_snapshot_digest_ck" CHECK ("digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "core"."access_change_decisions" (
	"batch_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"decided_by" uuid NOT NULL,
	"decision" text NOT NULL,
	"decision_id" uuid PRIMARY KEY,
	"item_id" uuid NOT NULL,
	"role_revision_ids" uuid[] NOT NULL,
	"tenant_id" uuid NOT NULL,
	"undoes_decision_id" uuid,
	CONSTRAINT "access_change_decisions_kind_ck" CHECK ("decision" in ('adopt', 'decline', 'undo')),
	CONSTRAINT "access_change_decisions_revisions_ck" CHECK (array_position("role_revision_ids", null) is null and ("decision" <> 'decline' or cardinality("role_revision_ids") = 0)),
	CONSTRAINT "access_change_decisions_undo_ck" CHECK (("decision" = 'undo' and "undoes_decision_id" is not null and "undoes_decision_id" <> "decision_id") or ("decision" <> 'undo' and "undoes_decision_id" is null))
);
--> statement-breakpoint
ALTER TABLE "core"."access_change_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_change_items" (
	"capability_key" text NOT NULL,
	"catalog_snapshot_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"item_id" uuid PRIMARY KEY,
	"kind" text NOT NULL,
	"lineage_from" text[] NOT NULL,
	"risk" text NOT NULL,
	"status" text NOT NULL,
	"suggested_role_ids" uuid[] NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "access_change_items_kind_ck" CHECK ("kind" in ('new', 'renamed', 'split', 'removed', 'risk_changed')),
	CONSTRAINT "access_change_items_status_ck" CHECK ("status" in ('pending', 'adopted', 'declined', 'undone')),
	CONSTRAINT "access_change_items_risk_ck" CHECK ("risk" in ('routine', 'sensitive', 'critical')),
	CONSTRAINT "access_change_items_lineage_ck" CHECK (array_position("lineage_from", null) is null and case when "kind" in ('renamed', 'split') then cardinality("lineage_from") > 0 else cardinality("lineage_from") = 0 end)
);
--> statement-breakpoint
ALTER TABLE "core"."access_change_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_consent_snapshots" (
	"ceiling_json" jsonb NOT NULL,
	"connection_id" uuid,
	"granted_at" timestamp with time zone NOT NULL,
	"granted_by" uuid NOT NULL,
	"revision" integer,
	"tenant_id" uuid,
	CONSTRAINT "access_consent_snapshots_pk" PRIMARY KEY("tenant_id","connection_id","revision"),
	CONSTRAINT "access_consent_snapshots_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "access_consent_snapshots_ceiling_ck" CHECK (jsonb_typeof("ceiling_json") = 'object')
);
--> statement-breakpoint
ALTER TABLE "core"."access_consent_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_decision_logs" (
	"actor_json" jsonb NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"admission_deadline" timestamp with time zone,
	"capability_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"decision_log_id" uuid PRIMARY KEY,
	"delegate_app_id" text,
	"delegate_principal_id" uuid,
	"mode" text NOT NULL,
	"on_behalf_of_principal_id" uuid,
	"operation_id" uuid,
	"outcome" text NOT NULL,
	"reasons_json" jsonb NOT NULL,
	"scope_id" uuid NOT NULL,
	"target" text,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "access_decision_logs_delegate_ck" CHECK (("delegate_app_id" is null) = ("delegate_principal_id" is null) and ("delegate_app_id" is null or length("delegate_app_id") between 1 and 120)),
	CONSTRAINT "access_decision_logs_mode_ck" CHECK ("mode" in ('run', 'propose', 'approve')),
	CONSTRAINT "access_decision_logs_correlation_ck" CHECK (length("correlation_id") between 1 and 200),
	CONSTRAINT "access_decision_logs_outcome_ck" CHECK ("outcome" in ('ALLOWED', 'NEEDS_APPROVAL', 'DENIED', 'UNAVAILABLE')),
	CONSTRAINT "access_decision_logs_reasons_ck" CHECK (jsonb_typeof("reasons_json") = 'array' and jsonb_array_length("reasons_json") > 0),
	CONSTRAINT "access_decision_logs_actor_ck" CHECK (jsonb_typeof("actor_json") = 'object' and "actor_json"->>'principalId' is not distinct from "actor_principal_id"::text)
);
--> statement-breakpoint
ALTER TABLE "core"."access_decision_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_delegations" (
	"amount_ceiling_json" jsonb,
	"can_redelegate" boolean DEFAULT false NOT NULL,
	"capability_keys" text[] NOT NULL,
	"delegation_id" uuid PRIMARY KEY,
	"granted_by" uuid NOT NULL,
	"manager_id" uuid NOT NULL,
	"people" uuid[] NOT NULL,
	"role_ids" uuid[] NOT NULL,
	"scope_id" uuid NOT NULL,
	"status" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	CONSTRAINT "access_delegations_self_ck" CHECK ("granted_by" <> "manager_id" and not ("manager_id" = any("people"))),
	CONSTRAINT "access_delegations_envelope_ck" CHECK (cardinality("capability_keys") > 0 and cardinality("role_ids") > 0 and cardinality("people") > 0 and array_position("capability_keys", null) is null and array_position("role_ids", null) is null and array_position("people", null) is null),
	CONSTRAINT "access_delegations_redelegate_ck" CHECK (not "can_redelegate"),
	CONSTRAINT "access_delegations_period_ck" CHECK ("valid_from" < "until"),
	CONSTRAINT "access_delegations_status_ck" CHECK ("status" in ('active', 'revoked', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "core"."access_delegations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_grant_incarnations" (
	"capability_key" text NOT NULL,
	"cell_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"grant_incarnation_id" uuid PRIMARY KEY,
	"mode" text NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"status" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "access_grants_status_ck" CHECK ("status" in ('active', 'retired')),
	CONSTRAINT "access_grants_mode_ck" CHECK ("mode" in ('run', 'propose', 'approve')),
	CONSTRAINT "access_grants_slot_ck" CHECK ("slot" in ('all', 'assigned', 'entrusted', 'team')),
	CONSTRAINT "access_grants_cell_ck" CHECK (jsonb_typeof("cell_json") = 'object'),
	CONSTRAINT "access_grants_cell_identity_ck" CHECK ("cell_json"->>'capabilityKey' = "capability_key" and "cell_json"->>'mode' = "mode" and (("slot" = 'all' and "cell_json"->'selector'->>'_tag' in ('all', 'targets')) or "slot" = "cell_json"->'selector'->>'_tag'))
);
--> statement-breakpoint
ALTER TABLE "core"."access_grant_incarnations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_mandate_grants" (
	"assignment_incarnation_id" uuid,
	"capability_key" text NOT NULL,
	"grant_incarnation_id" uuid,
	"mandate_id" uuid,
	"mode" text NOT NULL,
	"purpose" text,
	"scope_id" uuid NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "access_mandate_grants_pk" PRIMARY KEY("tenant_id","mandate_id","grant_incarnation_id","assignment_incarnation_id","purpose"),
	CONSTRAINT "access_mandate_grants_purpose_ck" CHECK ("purpose" in ('execution', 'approval', 'requester', 'parent_record_read')),
	CONSTRAINT "access_mandate_grants_mode_ck" CHECK (("purpose" = 'requester' and "mode" = 'propose') or ("purpose" = 'approval' and "mode" = 'approve') or ("purpose" in ('execution', 'parent_record_read') and "mode" = 'run'))
);
--> statement-breakpoint
ALTER TABLE "core"."access_mandate_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_mandates" (
	"mandate_id" uuid PRIMARY KEY,
	"proposal_id" uuid NOT NULL,
	"capability_key" text NOT NULL,
	"command_digest" text NOT NULL,
	"approval_expires_at" timestamp with time zone NOT NULL,
	"scope_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"approver_assignment_incarnation_id" uuid NOT NULL,
	"approver_id" uuid NOT NULL,
	"execution_assignment_incarnation_id" uuid NOT NULL,
	CONSTRAINT "access_mandates_digest_ck" CHECK ("command_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "access_mandates_ttl_ck" CHECK ("approved_at" < "approval_expires_at")
);
--> statement-breakpoint
ALTER TABLE "core"."access_mandates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_memberships" (
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"membership_id" uuid PRIMARY KEY,
	"principal_id" uuid,
	"recorded_by" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"status" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	CONSTRAINT "access_memberships_holder_xor_ck" CHECK (("principal_id" is null) <> ("agent_id" is null)),
	CONSTRAINT "access_memberships_kind_ck" CHECK ("kind" in ('member', 'owner', 'access_admin')),
	CONSTRAINT "access_memberships_status_ck" CHECK ("status" in ('active', 'suspended', 'revoked')),
	CONSTRAINT "access_memberships_manager_ck" CHECK ("kind" = 'member' or "principal_id" is not null),
	CONSTRAINT "access_memberships_period_ck" CHECK ("valid_until" is null or "valid_from" < "valid_until")
);--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_operation_journals" (
	"command_digest" text NOT NULL,
	"failure_code" text,
	"operation_id" uuid PRIMARY KEY,
	"phase" text NOT NULL,
	"projection_token" text,
	"scope_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"tenant_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "access_operation_journals_digest_ck" CHECK ("command_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "access_operation_journals_phase_ck" CHECK ("phase" in ('validated', 'fenced', 'projected', 'committed', 'failed')),
	CONSTRAINT "access_operation_journals_time_ck" CHECK ("started_at" <= "updated_at"),
	CONSTRAINT "access_operation_journals_projection_ck" CHECK ("phase" not in ('projected', 'committed') or "projection_token" is not null)
);
--> statement-breakpoint
ALTER TABLE "core"."access_operation_journals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_proposals" (
	"ended_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"execution_operation_id" uuid,
	"proposal_id" uuid PRIMARY KEY,
	"action_invocation_id" uuid,
	"capability_key" text NOT NULL,
	"command_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"requester_json" jsonb NOT NULL,
	"requester_principal_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"status" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rejected_by" uuid,
	"requester_authority_json" jsonb NOT NULL,
	"target" text,
	CONSTRAINT "access_proposals_digest_ck" CHECK ("command_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "access_proposals_period_ck" CHECK ("created_at" < "expires_at"),
	CONSTRAINT "access_proposals_status_ck" CHECK ("status" in ('pending', 'approved', 'executed', 'lapsed', 'rejected', 'expired')),
	CONSTRAINT "access_proposals_end_ck" CHECK ((("status" = 'rejected') = ("rejected_by" is not null)) and (("status" in ('rejected', 'lapsed', 'expired')) = ("ended_at" is not null))),
	CONSTRAINT "access_proposals_execution_ck" CHECK (("status" = 'executed') = ("executed_at" is not null and "execution_operation_id" is not null)),
	CONSTRAINT "access_proposals_requester_ck" CHECK (jsonb_typeof("requester_json") = 'object' and "requester_json"->>'principalId' is not distinct from "requester_principal_id"::text and jsonb_typeof("requester_authority_json") = 'array' and jsonb_array_length("requester_authority_json") > 0)
);
--> statement-breakpoint
ALTER TABLE "core"."access_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_frozen_commands" (
	"action_key" text NOT NULL,
	"capability_key" text NOT NULL,
	"command_digest" text NOT NULL,
	"command_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "access_frozen_commands_pk" PRIMARY KEY ("tenant_id","proposal_id"),
	CONSTRAINT "access_frozen_commands_digest_ck" CHECK ("command_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "access_frozen_commands_command_ck" CHECK (jsonb_typeof("command_json") = 'object')
);--> statement-breakpoint
ALTER TABLE "core"."access_frozen_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_role_revisions" (
	"catalog_snapshot_id" uuid NOT NULL,
	"cells_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"provenance" text NOT NULL,
	"revision" integer NOT NULL,
	"role_id" uuid NOT NULL,
	"role_revision_id" uuid PRIMARY KEY,
	"template_key" text,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "access_role_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "access_role_revisions_provenance_ck" CHECK ("provenance" in ('template', 'customer_changed', 'manual', 'imported')),
	CONSTRAINT "access_role_revisions_template_ck" CHECK (("provenance" in ('template', 'customer_changed')) = ("template_key" is not null)),
	CONSTRAINT "access_role_revisions_cells_ck" CHECK (jsonb_typeof("cells_json") = 'array')
);
--> statement-breakpoint
ALTER TABLE "core"."access_role_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_roles" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"legal_entity_id" uuid,
	"name" text NOT NULL,
	"role_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "access_roles_name_ck" CHECK (length("name") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "core"."access_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_scope_fences" (
	"owning_operation_id" uuid,
	"revision" integer NOT NULL,
	"scope_id" uuid PRIMARY KEY,
	"state" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "access_scope_fences_state_ck" CHECK ("state" in ('Ready', 'Changing', 'Unavailable')),
	CONSTRAINT "access_scope_fences_owner_ck" CHECK (("state" = 'Ready' and "owning_operation_id" is null) or ("state" <> 'Ready' and "owning_operation_id" is not null)),
	CONSTRAINT "access_scope_fences_revision_ck" CHECK ("revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "core"."access_scope_fences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_scopes" (
	"legal_entity_id" uuid,
	"scope_id" uuid PRIMARY KEY,
	"tenant_context_id" uuid,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "access_scopes_xor_ck" CHECK (("tenant_context_id" is null) <> ("legal_entity_id" is null)),
	CONSTRAINT "access_scopes_tenant_context_ck" CHECK ("tenant_context_id" is null or "tenant_context_id" = "tenant_id")
);
--> statement-breakpoint
ALTER TABLE "core"."access_scopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_team_members" (
	"added_at" timestamp with time zone NOT NULL,
	"added_by" uuid NOT NULL,
	"agent_id" uuid,
	"principal_id" uuid,
	"team_id" uuid NOT NULL,
	"team_member_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "access_team_members_holder_xor_ck" CHECK (("principal_id" is null) <> ("agent_id" is null))
);--> statement-breakpoint
ALTER TABLE "core"."access_team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_teams" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"name" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"team_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "access_teams_name_ck" CHECK (length("name") between 1 and 200)
);--> statement-breakpoint
ALTER TABLE "core"."access_teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."access_workload_bindings" (
	"binding_id" uuid PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"incarnation" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"status" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workload_key" text NOT NULL,
	CONSTRAINT "access_workload_bindings_status_ck" CHECK ("status" in ('active', 'revoked')),
	CONSTRAINT "access_workload_bindings_key_ck" CHECK ("workload_key" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$' and length("workload_key") <= 200),
	CONSTRAINT "access_workload_bindings_revoked_ck" CHECK (("status" = 'revoked') = ("revoked_at" is not null))
);--> statement-breakpoint
ALTER TABLE "core"."access_workload_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "access_connections_tenant_id_uk" ON "core"."access_agent_connections" ("tenant_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_assignments_tenant_id_uk" ON "core"."access_assignments" ("tenant_id","incarnation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_assignments_scope_uk" ON "core"."access_assignments" ("tenant_id","incarnation_id","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_catalog_snapshot_digest_uk" ON "core"."access_catalog_snapshots" ("digest");--> statement-breakpoint
CREATE UNIQUE INDEX "access_change_decisions_tenant_id_uk" ON "core"."access_change_decisions" ("tenant_id","decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_change_decisions_batch_item_uk" ON "core"."access_change_decisions" ("tenant_id","batch_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_change_items_tenant_id_uk" ON "core"."access_change_items" ("tenant_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_change_items_catalog_key_uk" ON "core"."access_change_items" ("tenant_id","catalog_snapshot_id","capability_key","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "access_delegations_tenant_id_uk" ON "core"."access_delegations" ("tenant_id","delegation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_tenant_id_uk" ON "core"."access_grant_incarnations" ("tenant_id","grant_incarnation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_scope_uk" ON "core"."access_grant_incarnations" ("tenant_id","grant_incarnation_id","scope_id","capability_key","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_cell_uk" ON "core"."access_grant_incarnations" ("tenant_id","scope_id","role_id","capability_key","mode","slot") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "access_proposals_command_uk" ON "core"."access_proposals" ("tenant_id","proposal_id","scope_id","capability_key","command_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "access_proposals_invocation_uk" ON "core"."access_proposals" ("tenant_id","action_invocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_mandates_tenant_id_uk" ON "core"."access_mandates" ("tenant_id","mandate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_mandates_proposal_uk" ON "core"."access_mandates" ("tenant_id","proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_mandates_scope_uk" ON "core"."access_mandates" ("tenant_id","mandate_id","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_memberships_tenant_id_uk" ON "core"."access_memberships" ("tenant_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_memberships_subject_uk" ON "core"."access_memberships" ("tenant_id","scope_id","principal_id","kind") WHERE "status" <> 'revoked' and "principal_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "access_memberships_agent_uk" ON "core"."access_memberships" ("tenant_id","scope_id","agent_id","kind") WHERE "status" <> 'revoked' and "agent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "access_operation_journals_tenant_id_uk" ON "core"."access_operation_journals" ("tenant_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_operation_journals_scope_id_uk" ON "core"."access_operation_journals" ("tenant_id","scope_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_proposals_tenant_id_uk" ON "core"."access_proposals" ("tenant_id","proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_proposals_execution_uk" ON "core"."access_proposals" ("execution_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_role_revisions_tenant_id_uk" ON "core"."access_role_revisions" ("tenant_id","role_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_role_revisions_number_uk" ON "core"."access_role_revisions" ("tenant_id","role_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "access_role_revisions_role_uk" ON "core"."access_role_revisions" ("tenant_id","role_id","role_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_roles_tenant_id_uk" ON "core"."access_roles" ("tenant_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_scopes_tenant_id_uk" ON "core"."access_scopes" ("tenant_id","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_scopes_tenant_context_uk" ON "core"."access_scopes" ("tenant_context_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_scopes_legal_entity_uk" ON "core"."access_scopes" ("tenant_id","legal_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_team_members_tenant_id_uk" ON "core"."access_team_members" ("tenant_id","team_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_team_members_principal_uk" ON "core"."access_team_members" ("tenant_id","team_id","principal_id") WHERE "principal_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "access_team_members_agent_uk" ON "core"."access_team_members" ("tenant_id","team_id","agent_id") WHERE "agent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "access_teams_tenant_id_uk" ON "core"."access_teams" ("tenant_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_teams_name_uk" ON "core"."access_teams" ("tenant_id","scope_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "access_workload_bindings_tenant_id_uk" ON "core"."access_workload_bindings" ("tenant_id","binding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_workload_bindings_incarnation_uk" ON "core"."access_workload_bindings" ("tenant_id","incarnation");--> statement-breakpoint
CREATE UNIQUE INDEX "access_workload_bindings_active_uk" ON "core"."access_workload_bindings" ("tenant_id","principal_id","workload_key") WHERE "status" = 'active';--> statement-breakpoint
ALTER TABLE "core"."access_agent_connections" ADD CONSTRAINT "access_agent_connections_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_agent_connections" ADD CONSTRAINT "access_connections_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_agent_connections" ADD CONSTRAINT "access_connections_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_agent_connections" ADD CONSTRAINT "access_connections_person_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_assignments" ADD CONSTRAINT "access_assignments_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_assignments" ADD CONSTRAINT "access_assignments_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_assignments" ADD CONSTRAINT "access_assignments_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_assignments" ADD CONSTRAINT "access_assignments_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_assignments" ADD CONSTRAINT "access_assignments_assigner_fk" FOREIGN KEY ("tenant_id","assigned_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_assignments" ADD CONSTRAINT "access_assignments_role_fk" FOREIGN KEY ("tenant_id","role_id","role_revision_id") REFERENCES "core"."access_role_revisions"("tenant_id","role_id","role_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_assignments" ADD CONSTRAINT "access_assignments_delegation_fk" FOREIGN KEY ("tenant_id","delegated_by") REFERENCES "core"."access_delegations"("tenant_id","delegation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_catalog_entries" ADD CONSTRAINT "access_catalog_entries_ubZaI1aDFLZU_fkey" FOREIGN KEY ("catalog_snapshot_id") REFERENCES "core"."access_catalog_snapshots"("catalog_snapshot_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_change_decisions" ADD CONSTRAINT "access_change_decisions_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_change_decisions" ADD CONSTRAINT "access_change_decisions_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "core"."access_change_items"("tenant_id","item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_change_decisions" ADD CONSTRAINT "access_change_decisions_undo_fk" FOREIGN KEY ("tenant_id","undoes_decision_id") REFERENCES "core"."access_change_decisions"("tenant_id","decision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_change_decisions" ADD CONSTRAINT "access_change_decisions_person_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_change_items" ADD CONSTRAINT "access_change_items_ksotFCFPZpwl_fkey" FOREIGN KEY ("catalog_snapshot_id") REFERENCES "core"."access_catalog_snapshots"("catalog_snapshot_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_change_items" ADD CONSTRAINT "access_change_items_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_consent_snapshots" ADD CONSTRAINT "access_consent_snapshots_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_consent_snapshots" ADD CONSTRAINT "access_consent_snapshots_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "core"."access_agent_connections"("tenant_id","connection_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_consent_snapshots" ADD CONSTRAINT "access_consent_snapshots_granter_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_decision_logs" ADD CONSTRAINT "access_decision_logs_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_decision_logs" ADD CONSTRAINT "access_decision_logs_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_decision_logs" ADD CONSTRAINT "access_decision_logs_actor_fk" FOREIGN KEY ("tenant_id","actor_principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_decision_logs" ADD CONSTRAINT "access_decision_logs_on_behalf_of_fk" FOREIGN KEY ("tenant_id","on_behalf_of_principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_decision_logs" ADD CONSTRAINT "access_decision_logs_operation_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "core"."access_operation_journals"("tenant_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_delegations" ADD CONSTRAINT "access_delegations_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_delegations" ADD CONSTRAINT "access_delegations_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_delegations" ADD CONSTRAINT "access_delegations_granter_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_delegations" ADD CONSTRAINT "access_delegations_manager_fk" FOREIGN KEY ("tenant_id","manager_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_grant_incarnations" ADD CONSTRAINT "access_grant_incarnations_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_grant_incarnations" ADD CONSTRAINT "access_grants_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_grant_incarnations" ADD CONSTRAINT "access_grants_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "core"."access_roles"("tenant_id","role_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_mandate_grants" ADD CONSTRAINT "access_mandate_grants_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_mandate_grants" ADD CONSTRAINT "access_mandate_grants_mandate_fk" FOREIGN KEY ("tenant_id","mandate_id","scope_id") REFERENCES "core"."access_mandates"("tenant_id","mandate_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_mandate_grants" ADD CONSTRAINT "access_mandate_grants_grant_fk" FOREIGN KEY ("tenant_id","grant_incarnation_id","scope_id","capability_key","mode") REFERENCES "core"."access_grant_incarnations"("tenant_id","grant_incarnation_id","scope_id","capability_key","mode") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_mandate_grants" ADD CONSTRAINT "access_mandate_grants_assignment_fk" FOREIGN KEY ("tenant_id","assignment_incarnation_id","scope_id") REFERENCES "core"."access_assignments"("tenant_id","incarnation_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_frozen_commands" ADD CONSTRAINT "access_frozen_commands_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_frozen_commands" ADD CONSTRAINT "access_frozen_commands_proposal_fk" FOREIGN KEY ("tenant_id","proposal_id","scope_id","capability_key","command_digest") REFERENCES "core"."access_proposals"("tenant_id","proposal_id","scope_id","capability_key","command_digest") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_mandates" ADD CONSTRAINT "access_mandates_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_mandates" ADD CONSTRAINT "access_mandates_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_mandates" ADD CONSTRAINT "access_mandates_proposal_fk" FOREIGN KEY ("tenant_id","proposal_id","scope_id","capability_key","command_digest") REFERENCES "core"."access_proposals"("tenant_id","proposal_id","scope_id","capability_key","command_digest") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_mandates" ADD CONSTRAINT "access_mandates_approver_assignment_fk" FOREIGN KEY ("tenant_id","approver_assignment_incarnation_id") REFERENCES "core"."access_assignments"("tenant_id","incarnation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_mandates" ADD CONSTRAINT "access_mandates_executor_assignment_fk" FOREIGN KEY ("tenant_id","execution_assignment_incarnation_id") REFERENCES "core"."access_assignments"("tenant_id","incarnation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_mandates" ADD CONSTRAINT "access_mandates_approver_fk" FOREIGN KEY ("tenant_id","approver_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ADD CONSTRAINT "access_memberships_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ADD CONSTRAINT "access_memberships_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ADD CONSTRAINT "access_memberships_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ADD CONSTRAINT "access_memberships_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ADD CONSTRAINT "access_memberships_recorder_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_operation_journals" ADD CONSTRAINT "access_operation_journals_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_operation_journals" ADD CONSTRAINT "access_operation_journals_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_proposals" ADD CONSTRAINT "access_proposals_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_proposals" ADD CONSTRAINT "access_proposals_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_proposals" ADD CONSTRAINT "access_proposals_requester_fk" FOREIGN KEY ("tenant_id","requester_principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_proposals" ADD CONSTRAINT "access_proposals_rejecter_fk" FOREIGN KEY ("tenant_id","rejected_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_role_revisions" ADD CONSTRAINT "access_role_revisions_LBx1wzaGbIaJ_fkey" FOREIGN KEY ("catalog_snapshot_id") REFERENCES "core"."access_catalog_snapshots"("catalog_snapshot_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_role_revisions" ADD CONSTRAINT "access_role_revisions_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_role_revisions" ADD CONSTRAINT "access_role_revisions_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "core"."access_roles"("tenant_id","role_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_role_revisions" ADD CONSTRAINT "access_role_revisions_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_roles" ADD CONSTRAINT "access_roles_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_roles" ADD CONSTRAINT "access_roles_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "core"."legal_entities"("tenant_id","legal_entity_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_roles" ADD CONSTRAINT "access_roles_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_scope_fences" ADD CONSTRAINT "access_scope_fences_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_scope_fences" ADD CONSTRAINT "access_scope_fences_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_scope_fences" ADD CONSTRAINT "access_scope_fences_operation_fk" FOREIGN KEY ("tenant_id","scope_id","owning_operation_id") REFERENCES "core"."access_operation_journals"("tenant_id","scope_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_scopes" ADD CONSTRAINT "access_scopes_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_scopes" ADD CONSTRAINT "access_scopes_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "core"."legal_entities"("tenant_id","legal_entity_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_team_members" ADD CONSTRAINT "access_team_members_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_team_members" ADD CONSTRAINT "access_team_members_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "core"."access_teams"("tenant_id","team_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_team_members" ADD CONSTRAINT "access_team_members_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_team_members" ADD CONSTRAINT "access_team_members_agent_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_team_members" ADD CONSTRAINT "access_team_members_adder_fk" FOREIGN KEY ("tenant_id","added_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_teams" ADD CONSTRAINT "access_teams_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_teams" ADD CONSTRAINT "access_teams_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "core"."access_scopes"("tenant_id","scope_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_teams" ADD CONSTRAINT "access_teams_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_workload_bindings" ADD CONSTRAINT "access_workload_bindings_tenant_id_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_workload_bindings" ADD CONSTRAINT "access_workload_bindings_principal_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
-- Guarantee 2: every one of the 19 tenant access tables is forced as well as enabled, so the owner
-- of these tables cannot read or write one tenant's authority intent without that tenant's context.
-- The two release-catalog tables stay without row security: a release is global, never tenant data,
-- and it is written by the Core publication path and read by every runtime (O50).
ALTER TABLE "core"."access_agent_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_assignments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_change_decisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_change_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_consent_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_decision_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_delegations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_grant_incarnations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_mandate_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_frozen_commands" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_mandates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_operation_journals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_proposals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_role_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_scope_fences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_scopes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_team_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_teams" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."access_workload_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "access_agent_connections_select" ON "core"."access_agent_connections" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_agent_connections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_agent_connections_insert" ON "core"."access_agent_connections" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_agent_connections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_agent_connections_update" ON "core"."access_agent_connections" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_agent_connections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_agent_connections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_agent_connections_delete" ON "core"."access_agent_connections" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_agent_connections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_assignments_select" ON "core"."access_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_assignments_insert" ON "core"."access_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_assignments_update" ON "core"."access_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_assignments_delete" ON "core"."access_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_change_decisions_select" ON "core"."access_change_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_change_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_change_decisions_insert" ON "core"."access_change_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_change_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_change_decisions_update" ON "core"."access_change_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_change_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_change_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_change_decisions_delete" ON "core"."access_change_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_change_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_change_items_select" ON "core"."access_change_items" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_change_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_change_items_insert" ON "core"."access_change_items" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_change_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_change_items_update" ON "core"."access_change_items" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_change_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_change_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_change_items_delete" ON "core"."access_change_items" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_change_items"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_consent_snapshots_select" ON "core"."access_consent_snapshots" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_consent_snapshots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_consent_snapshots_insert" ON "core"."access_consent_snapshots" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_consent_snapshots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_consent_snapshots_update" ON "core"."access_consent_snapshots" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_consent_snapshots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_consent_snapshots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_consent_snapshots_delete" ON "core"."access_consent_snapshots" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_consent_snapshots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_decision_logs_select" ON "core"."access_decision_logs" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_decision_logs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_decision_logs_insert" ON "core"."access_decision_logs" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_decision_logs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_decision_logs_update" ON "core"."access_decision_logs" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_decision_logs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_decision_logs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_decision_logs_delete" ON "core"."access_decision_logs" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_decision_logs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_delegations_select" ON "core"."access_delegations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_delegations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_delegations_insert" ON "core"."access_delegations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_delegations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_delegations_update" ON "core"."access_delegations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_delegations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_delegations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_delegations_delete" ON "core"."access_delegations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_delegations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_grant_incarnations_select" ON "core"."access_grant_incarnations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_grant_incarnations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_grant_incarnations_insert" ON "core"."access_grant_incarnations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_grant_incarnations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_grant_incarnations_update" ON "core"."access_grant_incarnations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_grant_incarnations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_grant_incarnations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_grant_incarnations_delete" ON "core"."access_grant_incarnations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_grant_incarnations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_mandate_grants_select" ON "core"."access_mandate_grants" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_mandate_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_mandate_grants_insert" ON "core"."access_mandate_grants" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_mandate_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_mandate_grants_update" ON "core"."access_mandate_grants" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_mandate_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_mandate_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_mandate_grants_delete" ON "core"."access_mandate_grants" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_mandate_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_frozen_commands_select" ON "core"."access_frozen_commands" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_frozen_commands"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_frozen_commands_insert" ON "core"."access_frozen_commands" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_frozen_commands"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_frozen_commands_gateway_request_select" ON "core"."access_frozen_commands" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_frozen_commands"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
GRANT SELECT, INSERT ON core.access_frozen_commands TO ontos_runtime;--> statement-breakpoint
REVOKE UPDATE, DELETE ON core.access_frozen_commands FROM ontos_runtime;--> statement-breakpoint
CREATE POLICY "access_mandates_select" ON "core"."access_mandates" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_mandates"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_mandates_insert" ON "core"."access_mandates" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_mandates"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_mandates_update" ON "core"."access_mandates" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_mandates"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_mandates"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_mandates_delete" ON "core"."access_mandates" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_mandates"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_memberships_select" ON "core"."access_memberships" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_memberships_insert" ON "core"."access_memberships" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_memberships_update" ON "core"."access_memberships" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_memberships_delete" ON "core"."access_memberships" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_operation_journals_select" ON "core"."access_operation_journals" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_operation_journals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_operation_journals_insert" ON "core"."access_operation_journals" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_operation_journals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_operation_journals_update" ON "core"."access_operation_journals" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_operation_journals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_operation_journals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_operation_journals_delete" ON "core"."access_operation_journals" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_operation_journals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_proposals_select" ON "core"."access_proposals" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_proposals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_proposals_insert" ON "core"."access_proposals" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_proposals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_proposals_update" ON "core"."access_proposals" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_proposals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_proposals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_proposals_delete" ON "core"."access_proposals" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_proposals"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_role_revisions_select" ON "core"."access_role_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_role_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_role_revisions_insert" ON "core"."access_role_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_role_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_role_revisions_update" ON "core"."access_role_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_role_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_role_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_role_revisions_delete" ON "core"."access_role_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_role_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_roles_select" ON "core"."access_roles" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_roles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_roles_insert" ON "core"."access_roles" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_roles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_roles_update" ON "core"."access_roles" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_roles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_roles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_roles_delete" ON "core"."access_roles" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_roles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_scope_fences_select" ON "core"."access_scope_fences" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_scope_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_scope_fences_insert" ON "core"."access_scope_fences" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_scope_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_scope_fences_update" ON "core"."access_scope_fences" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_scope_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_scope_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_scope_fences_delete" ON "core"."access_scope_fences" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_scope_fences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_scopes_select" ON "core"."access_scopes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_scopes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_scopes_insert" ON "core"."access_scopes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_scopes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_scopes_update" ON "core"."access_scopes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_scopes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_scopes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_scopes_delete" ON "core"."access_scopes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_scopes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_team_members_select" ON "core"."access_team_members" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_team_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_team_members_insert" ON "core"."access_team_members" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_team_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_team_members_update" ON "core"."access_team_members" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_team_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_team_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_team_members_delete" ON "core"."access_team_members" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_team_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_teams_select" ON "core"."access_teams" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_teams"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_teams_insert" ON "core"."access_teams" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_teams"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_teams_update" ON "core"."access_teams" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_teams"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_teams"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_teams_delete" ON "core"."access_teams" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_teams"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
-- An explicit request identity reaches the gate's intent through the trusted scope it redeemed,
-- never a session setting it could choose itself (D6). Only the tables one decision reads and the
-- one evidence row it appends get a policy; the shared runtime keeps its session-setting policies.
CREATE POLICY "access_agent_connections_gateway_request_select" ON "core"."access_agent_connections" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_agent_connections"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_assignments_gateway_request_select" ON "core"."access_assignments" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_assignments"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_consent_snapshots_gateway_request_select" ON "core"."access_consent_snapshots" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_consent_snapshots"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_decision_logs_gateway_request_insert" ON "core"."access_decision_logs" AS PERMISSIVE FOR INSERT TO "party_registry_runtime" WITH CHECK ("core"."access_decision_logs"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_delegations_gateway_request_select" ON "core"."access_delegations" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_delegations"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_grant_incarnations_gateway_request_select" ON "core"."access_grant_incarnations" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_grant_incarnations"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_memberships_gateway_request_select" ON "core"."access_memberships" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_memberships"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_role_revisions_gateway_request_select" ON "core"."access_role_revisions" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_role_revisions"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_scopes_gateway_request_select" ON "core"."access_scopes" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_scopes"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_team_members_gateway_request_select" ON "core"."access_team_members" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_team_members"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_teams_gateway_request_select" ON "core"."access_teams" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_teams"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
CREATE POLICY "access_workload_bindings_select" ON "core"."access_workload_bindings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("core"."access_workload_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_workload_bindings_insert" ON "core"."access_workload_bindings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("core"."access_workload_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_workload_bindings_update" ON "core"."access_workload_bindings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("core"."access_workload_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("core"."access_workload_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_workload_bindings_delete" ON "core"."access_workload_bindings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("core"."access_workload_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "access_workload_bindings_gateway_request_select" ON "core"."access_workload_bindings" AS PERMISSIVE FOR SELECT TO "party_registry_runtime" USING ("core"."access_workload_bindings"."tenant_id" = (select trust.current_tenant_id()));--> statement-breakpoint
-- The owner Action's terminal 'proposed' receipt is introduced with the access intent (O90).
DO $action_invocation_proposed$
BEGIN
  -- Isolated access-schema suites install only identity stubs; production already has this Core table.
  IF to_regclass('core.action_invocations') IS NOT NULL THEN
    ALTER TABLE core.action_invocations DROP CONSTRAINT core_action_invocations_status_ck;
    ALTER TABLE core.action_invocations ADD CONSTRAINT core_action_invocations_status_ck
      CHECK (status in ('received', 'rejected', 'running', 'succeeded', 'failed', 'indeterminate', 'replayed', 'proposed'));
  END IF;
END;
$action_invocation_proposed$;--> statement-breakpoint
-- Access intent is evidence. PostgreSQL enforces the invariants that no column check can hold:
-- incarnations and revisions never change identity, releases and decisions are append-only, and
-- proposal, mandate, assignment and journal status only ever move forward. Core is the only writer.
CREATE FUNCTION core.reject_access_append_only_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Core access record % is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.reject_access_append_only_change() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION core.reject_access_role_revision_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'A Core access role revision is immutable' USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.reject_access_role_revision_change() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION core.keep_access_assignment_incarnation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_old_revision integer;
  v_new_revision integer;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NEW.incarnation_id <> OLD.incarnation_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.scope_id <> OLD.scope_id
     OR NEW.role_id <> OLD.role_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.valid_from <> OLD.valid_from
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.delegated_by IS DISTINCT FROM OLD.delegated_by
     OR NEW.delegation_envelope_json IS DISTINCT FROM OLD.delegation_envelope_json THEN
    RAISE EXCEPTION 'An assignment incarnation never changes holder, role, scope, period or delegated limits'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.role_revision_id <> OLD.role_revision_id THEN
    IF OLD.status <> 'active' THEN
      RAISE EXCEPTION 'Only a live assignment follows a role revision' USING ERRCODE = '55000';
    END IF;
    EXECUTE format('SELECT r.revision FROM %I.access_role_revisions r WHERE r.tenant_id = $1 AND r.role_revision_id = $2',
                   TG_TABLE_SCHEMA)
      INTO v_old_revision USING OLD.tenant_id, OLD.role_revision_id;
    EXECUTE format('SELECT r.revision FROM %I.access_role_revisions r WHERE r.tenant_id = $1 AND r.role_revision_id = $2',
                   TG_TABLE_SCHEMA)
      INTO v_new_revision USING NEW.tenant_id, NEW.role_revision_id;
    IF v_old_revision IS NULL OR v_new_revision IS NULL OR v_new_revision <= v_old_revision THEN
      RAISE EXCEPTION 'An assignment only follows a newer revision of the same role' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.status <> OLD.status AND OLD.status <> 'active' THEN
    RAISE EXCEPTION 'An assignment status never returns to active' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.keep_access_assignment_incarnation() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION core.keep_access_grant_incarnation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.grant_incarnation_id <> OLD.grant_incarnation_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.scope_id <> OLD.scope_id
     OR NEW.role_id <> OLD.role_id
     OR NEW.capability_key <> OLD.capability_key
     OR NEW.mode <> OLD.mode
     OR NEW.slot <> OLD.slot
     OR NEW.cell_json IS DISTINCT FROM OLD.cell_json
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A grant incarnation never changes its exact cell' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND OLD.status <> 'active' THEN
    RAISE EXCEPTION 'A retired grant incarnation never returns to active' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.keep_access_grant_incarnation() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION core.keep_access_proposal_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.proposal_id <> OLD.proposal_id
     OR NEW.scope_id <> OLD.scope_id
     OR NEW.capability_key <> OLD.capability_key
     OR NEW.command_digest <> OLD.command_digest
     OR NEW.requester_json IS DISTINCT FROM OLD.requester_json
     OR NEW.requester_authority_json IS DISTINCT FROM OLD.requester_authority_json
     OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at
     OR NEW.target IS DISTINCT FROM OLD.target THEN
    RAISE EXCEPTION 'A proposal keeps the frozen command it was made with' USING ERRCODE = '55000';
  END IF;
  IF OLD.execution_operation_id IS NOT NULL
     AND (NEW.execution_operation_id IS DISTINCT FROM OLD.execution_operation_id
          OR NEW.executed_at IS DISTINCT FROM OLD.executed_at) THEN
    RAISE EXCEPTION 'A proposal executes at most once' USING ERRCODE = '55000';
  END IF;
  IF (OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at)
     OR (OLD.rejected_by IS NOT NULL AND NEW.rejected_by IS DISTINCT FROM OLD.rejected_by) THEN
    RAISE EXCEPTION 'A finished proposal keeps how it ended' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status
     AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'lapsed', 'expired'))
       OR (OLD.status = 'approved' AND NEW.status IN ('executed', 'lapsed', 'expired'))
     ) THEN
    RAISE EXCEPTION 'A proposal status only moves forward from %', OLD.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.keep_access_proposal_status() FROM PUBLIC;
--> statement-breakpoint
-- The approval is stored once, on the approval record, so the pairing of a proposal with its approval
-- cannot be a column check: it is required of both rows at commit time, in either write order (M5).
CREATE FUNCTION core.require_access_proposal_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_mandates integer;
  v_purposes integer;
  v_live integer;
  v_status text;
  v_executed timestamp with time zone;
BEGIN
  IF TG_TABLE_NAME = 'access_proposals' THEN
    -- The verdict is about the row as it is committed, never the image of one event: a proposal
    -- written as pending and approved in the same transaction is one approved row (M5).
    EXECUTE format('SELECT p.status, p.executed_at FROM %I.access_proposals p
                     WHERE p.tenant_id = $1 AND p.proposal_id = $2', TG_TABLE_SCHEMA)
      INTO v_status, v_executed USING NEW.tenant_id, NEW.proposal_id;
    EXECUTE format('SELECT count(*) FROM %I.access_mandates m WHERE m.tenant_id = $1 AND m.proposal_id = $2',
                   TG_TABLE_SCHEMA)
      INTO v_mandates USING NEW.tenant_id, NEW.proposal_id;
    IF v_status IN ('approved', 'executed') THEN
      IF v_mandates <> 1 THEN
        RAISE EXCEPTION 'An approved proposal carries exactly one approval record' USING ERRCODE = '23514';
      END IF;
      EXECUTE format('SELECT count(DISTINCT g.purpose)
                        FROM %I.access_mandate_grants g
                        JOIN %I.access_mandates m
                          ON m.tenant_id = g.tenant_id AND m.mandate_id = g.mandate_id
                       WHERE g.tenant_id = $1 AND m.proposal_id = $2
                         AND g.purpose IN (''approval'', ''execution'')',
                     TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
        INTO v_purposes USING NEW.tenant_id, NEW.proposal_id;
      IF v_purposes <> 2 THEN
        RAISE EXCEPTION 'An approved proposal binds one approval and one execution witness'
          USING ERRCODE = '23514';
      END IF;
      IF v_status = 'executed' THEN
        EXECUTE format('SELECT count(*) FROM %I.access_mandates m
                         WHERE m.tenant_id = $1 AND m.proposal_id = $2
                           AND m.approved_at <= $3 AND $3 < m.approval_expires_at', TG_TABLE_SCHEMA)
          INTO v_live USING NEW.tenant_id, NEW.proposal_id, v_executed;
        IF v_live <> 1 THEN
          RAISE EXCEPTION 'An execution happens while its approval is live' USING ERRCODE = '23514';
        END IF;
      END IF;
    ELSIF v_status IN ('pending', 'rejected') AND v_mandates > 0 THEN
      RAISE EXCEPTION 'A pending or rejected proposal carries no approval record' USING ERRCODE = '23514';
    END IF;
  ELSE
    EXECUTE format('SELECT p.status FROM %I.access_proposals p WHERE p.tenant_id = $1 AND p.proposal_id = $2',
                   TG_TABLE_SCHEMA)
      INTO v_status USING NEW.tenant_id, NEW.proposal_id;
    IF v_status IN ('pending', 'rejected') THEN
      RAISE EXCEPTION 'An approval record belongs to a proposal that reached an approval'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.require_access_proposal_approval() FROM PUBLIC;
--> statement-breakpoint
-- An approval binds the approving person's own live assignments, inside the lifetime of the proposal
-- it approves; the capability, the scope and the digest are the proposal's own by foreign key.
CREATE FUNCTION core.check_access_mandate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_created timestamp with time zone;
  v_expires timestamp with time zone;
  v_assignment uuid;
  v_holder uuid;
  v_agent uuid;
  v_status text;
BEGIN
  EXECUTE format('SELECT p.created_at, p.expires_at FROM %I.access_proposals p
                   WHERE p.tenant_id = $1 AND p.proposal_id = $2', TG_TABLE_SCHEMA)
    INTO v_created, v_expires USING NEW.tenant_id, NEW.proposal_id;
  IF v_created IS NULL THEN
    RAISE EXCEPTION 'An approval names the proposal it approves' USING ERRCODE = '23503';
  END IF;
  IF NEW.approved_at < v_created OR NEW.approved_at >= v_expires THEN
    RAISE EXCEPTION 'An approval happens inside the lifetime of the proposal it approves'
      USING ERRCODE = '23514';
  END IF;
  FOR v_assignment IN
    SELECT unnest(array[NEW.approver_assignment_incarnation_id, NEW.execution_assignment_incarnation_id])
  LOOP
    EXECUTE format('SELECT a.principal_id, a.agent_id, a.status FROM %I.access_assignments a
                     WHERE a.tenant_id = $1 AND a.incarnation_id = $2 AND a.scope_id = $3', TG_TABLE_SCHEMA)
      INTO v_holder, v_agent, v_status USING NEW.tenant_id, v_assignment, NEW.scope_id;
    IF v_status IS DISTINCT FROM 'active' OR v_agent IS NOT NULL OR v_holder IS DISTINCT FROM NEW.approver_id THEN
      RAISE EXCEPTION 'An approval binds the approver''s own live assignments' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.check_access_mandate() FROM PUBLIC;
--> statement-breakpoint
-- A witness row is held by the holder its purpose names: the requester's own holder, or the approving
-- person herself in the exact assignment the approval names. An agent never holds an approver's
-- witness, so no mandate is ever executed by an agent (O63).
CREATE FUNCTION core.check_access_mandate_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_approver uuid;
  v_approval_assignment uuid;
  v_capability text;
  v_execution_assignment uuid;
  v_grant_capability text;
  v_grant_role uuid;
  v_grant_status text;
  v_proposal uuid;
  v_requester jsonb;
  v_holder uuid;
  v_agent uuid;
  v_assignment_role uuid;
  v_status text;
BEGIN
  EXECUTE format('SELECT m.approver_id, m.approver_assignment_incarnation_id,
                         m.execution_assignment_incarnation_id, m.proposal_id, m.capability_key
                    FROM %I.access_mandates m WHERE m.tenant_id = $1 AND m.mandate_id = $2', TG_TABLE_SCHEMA)
    INTO v_approver, v_approval_assignment, v_execution_assignment, v_proposal, v_capability
    USING NEW.tenant_id, NEW.mandate_id;
  IF v_approver IS NULL THEN
    RAISE EXCEPTION 'A witness belongs to an approval record' USING ERRCODE = '23503';
  END IF;
  EXECUTE format('SELECT a.principal_id, a.agent_id, a.status, a.role_id FROM %I.access_assignments a
                   WHERE a.tenant_id = $1 AND a.incarnation_id = $2 AND a.scope_id = $3', TG_TABLE_SCHEMA)
    INTO v_holder, v_agent, v_status, v_assignment_role USING NEW.tenant_id, NEW.assignment_incarnation_id, NEW.scope_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'A witness is held by a live assignment' USING ERRCODE = '23514';
  END IF;
  -- The grant the witness names must be a live incarnation of the role its assignment holds (R4-M3):
  -- an assignment of one role can never witness another role's grant, and a retired cell is no cell.
  EXECUTE format('SELECT g.role_id, g.status, g.capability_key FROM %I.access_grant_incarnations g
                   WHERE g.tenant_id = $1 AND g.grant_incarnation_id = $2 AND g.scope_id = $3', TG_TABLE_SCHEMA)
    INTO v_grant_role, v_grant_status, v_grant_capability
    USING NEW.tenant_id, NEW.grant_incarnation_id, NEW.scope_id;
  IF v_grant_role IS NULL THEN
    RAISE EXCEPTION 'A witness names a grant incarnation of this scope' USING ERRCODE = '23503';
  END IF;
  IF v_grant_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'A witness is held by a live grant incarnation' USING ERRCODE = '23514';
  END IF;
  IF v_grant_role IS DISTINCT FROM v_assignment_role THEN
    RAISE EXCEPTION 'A witness grant belongs to the role its assignment holds' USING ERRCODE = '23514';
  END IF;
  -- An approval and an execution witness are held on the capability the proposal commands; only a
  -- parent record read may name another one (R4-M3).
  IF NEW.purpose IN ('approval', 'execution') AND NEW.capability_key IS DISTINCT FROM v_capability THEN
    RAISE EXCEPTION 'The % witness is held on the capability the proposal commands', NEW.purpose USING ERRCODE = '23514';
  END IF;
  IF NEW.purpose = 'requester' THEN
    EXECUTE format('SELECT p.requester_json FROM %I.access_proposals p
                     WHERE p.tenant_id = $1 AND p.proposal_id = $2', TG_TABLE_SCHEMA)
      INTO v_requester USING NEW.tenant_id, v_proposal;
    IF NOT ((v_agent IS NOT NULL AND v_requester ->> '_tag' = 'Agent'
             AND (v_requester ->> 'agentId')::uuid = v_agent)
            OR (v_agent IS NULL AND v_holder IS NOT NULL AND v_requester ->> '_tag' = 'Principal'
                AND (v_requester ->> 'principalId')::uuid = v_holder)) THEN
      RAISE EXCEPTION 'The requester witness belongs to the requester itself' USING ERRCODE = '23514';
    END IF;
  ELSIF v_agent IS NOT NULL OR v_holder IS DISTINCT FROM v_approver THEN
    RAISE EXCEPTION 'The % witness is the approving person''s own', NEW.purpose USING ERRCODE = '23514';
  END IF;
  IF (NEW.purpose = 'approval' AND NEW.assignment_incarnation_id <> v_approval_assignment)
     OR (NEW.purpose = 'execution' AND NEW.assignment_incarnation_id <> v_execution_assignment) THEN
    RAISE EXCEPTION 'A witness is held by the assignment its approval names' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.check_access_mandate_grant() FROM PUBLIC;
--> statement-breakpoint
-- A role is an identity: only its display name ever changes, so the legal entity a role is assignable
-- in can never be widened, narrowed or dropped while its assignments stay live.
CREATE FUNCTION core.keep_access_role_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.role_id <> OLD.role_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
     OR NEW.created_at <> OLD.created_at
     OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'A Core access role keeps its identity; only its name changes' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.keep_access_role_identity() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION core.keep_access_change_item_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.item_id <> OLD.item_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.catalog_snapshot_id <> OLD.catalog_snapshot_id
     OR NEW.capability_key <> OLD.capability_key
     OR NEW.kind <> OLD.kind
     OR NEW.risk <> OLD.risk
     OR NEW.lineage_from IS DISTINCT FROM OLD.lineage_from
     OR NEW.suggested_role_ids IS DISTINCT FROM OLD.suggested_role_ids THEN
    RAISE EXCEPTION 'An access change item keeps the release identity it describes' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status
     AND NOT ((OLD.status = 'pending' AND NEW.status IN ('adopted', 'declined')) OR (OLD.status = 'adopted' AND NEW.status = 'undone')) THEN
    RAISE EXCEPTION 'An access change item is adopted, declined or undone once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.keep_access_change_item_status() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION core.keep_access_operation_phase() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_phases text[] := array['validated', 'fenced', 'projected', 'committed'];
BEGIN
  IF NEW.operation_id <> OLD.operation_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.scope_id <> OLD.scope_id
     OR NEW.command_digest <> OLD.command_digest
     OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'An operation journal belongs to the operation that started it' USING ERRCODE = '55000';
  END IF;
  IF NEW.phase <> OLD.phase THEN
    IF OLD.phase IN ('committed', 'failed') THEN
      RAISE EXCEPTION 'A finished operation journal never reopens' USING ERRCODE = '55000';
    END IF;
    IF NEW.phase <> 'failed'
       AND array_position(v_phases, NEW.phase) <= array_position(v_phases, OLD.phase) THEN
      RAISE EXCEPTION 'An operation journal only advances forward' USING ERRCODE = '55000';
    END IF;
  END IF;
  -- A finished journal is final in its content, not only in its phase: its projection token or failure
  -- code can never be rewritten by a same-phase write (R4-L3). Only the record of the last touch moves.
  IF OLD.phase IN ('committed', 'failed')
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'A finished operation journal is final' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.keep_access_operation_phase() FROM PUBLIC;
--> statement-breakpoint
-- v2 subjects are a verified human or an agent, never a service, integration or system principal
-- (O46, R2-M1). No column check can read another table, so the kind is checked on write.
CREATE FUNCTION core.require_access_principal_kinds() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_index integer := 0;
  v_column text;
  v_kind text;
  v_principal uuid;
  v_actual text;
BEGIN
  WHILE v_index < TG_NARGS LOOP
    v_column := TG_ARGV[v_index];
    v_kind := TG_ARGV[v_index + 1];
    v_principal := (to_jsonb(NEW) ->> v_column)::uuid;
    IF v_principal IS NOT NULL THEN
      -- The guard reads the identity table of the schema the written row lives in, so the
      -- migration stays applicable to any schema and never guesses a neighbour's name.
      EXECUTE format('SELECT p.kind FROM %I.principals p WHERE p.tenant_id = $1 AND p.principal_id = $2',
                     TG_TABLE_SCHEMA)
        INTO v_actual USING NEW.tenant_id, v_principal;
      IF v_actual IS DISTINCT FROM v_kind THEN
        RAISE EXCEPTION 'Core access subject %.% must be a % principal', TG_TABLE_NAME, v_column, v_kind
          USING ERRCODE = '23514';
      END IF;
    END IF;
    v_index := v_index + 2;
  END LOOP;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.require_access_principal_kinds() FROM PUBLIC;
--> statement-breakpoint
-- A delegation and an agent connection never grow in place: only the status may move, and only out
-- of active, so an envelope can never be widened under an approval that already relied on it
-- (P8, R2-M2).
CREATE FUNCTION core.keep_access_revocable_envelope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'A Core access % is immutable except for its status', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND OLD.status <> 'active' THEN
    RAISE EXCEPTION 'A Core access % status only ever leaves active', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.keep_access_revocable_envelope() FROM PUBLIC;
--> statement-breakpoint
-- A company-local role variant is assignable only inside its own legal entity (R2-M3, guarantee 3).
CREATE FUNCTION core.check_access_assignment_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_role_entity uuid;
  v_scope_entity uuid;
BEGIN
  EXECUTE format('SELECT r.legal_entity_id FROM %I.access_roles r WHERE r.tenant_id = $1 AND r.role_id = $2',
                 TG_TABLE_SCHEMA)
    INTO v_role_entity USING NEW.tenant_id, NEW.role_id;
  IF v_role_entity IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT a.legal_entity_id FROM %I.access_scopes a WHERE a.tenant_id = $1 AND a.scope_id = $2',
                 TG_TABLE_SCHEMA)
    INTO v_scope_entity USING NEW.tenant_id, NEW.scope_id;
  IF v_scope_entity IS DISTINCT FROM v_role_entity THEN
    RAISE EXCEPTION 'A company-local role is assigned only inside its own legal entity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.check_access_assignment_scope() FROM PUBLIC;
--> statement-breakpoint
-- Membership is intent with a lifecycle: a holder, a scope and a kind never change, suspension is
-- reversible and revocation is final, so a membership identifier can never be reused for a rejoin
-- (D6, D27). The deadline is frozen too: extending access is a new membership, never a widening of a
-- row a decision already read.
CREATE FUNCTION core.keep_access_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.membership_id <> OLD.membership_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.scope_id <> OLD.scope_id
     OR NEW.kind <> OLD.kind
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.recorded_by <> OLD.recorded_by
     OR NEW.valid_from <> OLD.valid_from
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A membership never changes its holder, scope, kind or period' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status
     AND NOT (
       (OLD.status = 'active' AND NEW.status IN ('suspended', 'revoked'))
       OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'revoked'))
     ) THEN
    RAISE EXCEPTION 'A membership status only moves forward from %', OLD.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.keep_access_membership() FROM PUBLIC;
--> statement-breakpoint
-- Management authority is held in the scope it administers: tenant ownership only in the tenant
-- context and company administration only inside one company (O28, O65). No column check can read the
-- context of the scope a membership names.
CREATE FUNCTION core.check_access_membership_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
DECLARE
  v_context uuid;
  v_entity uuid;
BEGIN
  EXECUTE format('SELECT s.tenant_context_id, s.legal_entity_id FROM %I.access_scopes s WHERE s.tenant_id = $1 AND s.scope_id = $2',
                 TG_TABLE_SCHEMA)
    INTO v_context, v_entity USING NEW.tenant_id, NEW.scope_id;
  IF NEW.kind = 'owner' AND v_context IS NULL THEN
    RAISE EXCEPTION 'Tenant ownership is held in the tenant-context scope only' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'access_admin' AND v_entity IS NULL THEN
    RAISE EXCEPTION 'Company administration is held inside one legal entity only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.check_access_membership_scope() FROM PUBLIC;
--> statement-breakpoint
-- A team is an identity inside one scope: only its display name changes, so a team can never move
-- under the records whose projection team-matches through it (O24).
CREATE FUNCTION core.keep_access_team_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.team_id <> OLD.team_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.scope_id <> OLD.scope_id
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A team never changes its scope' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.keep_access_team_identity() FROM PUBLIC;
--> statement-breakpoint
-- Incarnations, approvals and envelopes are evidence: a row is never deleted or truncated, so an
-- incarnation identifier can never be freed and reused (L3, guarantee 5).
CREATE FUNCTION core.reject_access_record_removal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Core access record % is never removed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION core.reject_access_record_removal() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER core_access_catalog_snapshots_append_only
BEFORE UPDATE OR DELETE ON core.access_catalog_snapshots
FOR EACH ROW EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_catalog_snapshots_no_truncate
BEFORE TRUNCATE ON core.access_catalog_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_catalog_entries_append_only
BEFORE UPDATE OR DELETE ON core.access_catalog_entries
FOR EACH ROW EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_catalog_entries_no_truncate
BEFORE TRUNCATE ON core.access_catalog_entries
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_role_revisions_immutable
BEFORE UPDATE OR DELETE ON core.access_role_revisions
FOR EACH ROW EXECUTE FUNCTION core.reject_access_role_revision_change();
--> statement-breakpoint
CREATE TRIGGER core_access_role_revisions_no_truncate
BEFORE TRUNCATE ON core.access_role_revisions
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_role_revision_change();
--> statement-breakpoint
CREATE TRIGGER core_access_assignments_incarnation
BEFORE UPDATE ON core.access_assignments
FOR EACH ROW EXECUTE FUNCTION core.keep_access_assignment_incarnation();
--> statement-breakpoint
CREATE TRIGGER core_access_grant_incarnations_cell
BEFORE UPDATE ON core.access_grant_incarnations
FOR EACH ROW EXECUTE FUNCTION core.keep_access_grant_incarnation();
--> statement-breakpoint
CREATE TRIGGER core_access_proposals_status
BEFORE UPDATE ON core.access_proposals
FOR EACH ROW EXECUTE FUNCTION core.keep_access_proposal_status();
--> statement-breakpoint
CREATE TRIGGER core_access_frozen_commands_append_only
BEFORE UPDATE OR DELETE ON core.access_frozen_commands
FOR EACH ROW EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_frozen_commands_no_truncate
BEFORE TRUNCATE ON core.access_frozen_commands
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_mandates_append_only
BEFORE UPDATE OR DELETE ON core.access_mandates
FOR EACH ROW EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_mandates_no_truncate
BEFORE TRUNCATE ON core.access_mandates
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_mandate_grants_append_only
BEFORE UPDATE OR DELETE ON core.access_mandate_grants
FOR EACH ROW EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_change_items_status
BEFORE UPDATE ON core.access_change_items
FOR EACH ROW EXECUTE FUNCTION core.keep_access_change_item_status();
--> statement-breakpoint
CREATE TRIGGER core_access_change_decisions_append_only
BEFORE UPDATE OR DELETE ON core.access_change_decisions
FOR EACH ROW EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_consent_snapshots_append_only
BEFORE UPDATE OR DELETE ON core.access_consent_snapshots
FOR EACH ROW EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_decision_logs_append_only
BEFORE UPDATE OR DELETE ON core.access_decision_logs
FOR EACH ROW EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_decision_logs_no_truncate
BEFORE TRUNCATE ON core.access_decision_logs
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_operation_journals_phase
BEFORE UPDATE ON core.access_operation_journals
FOR EACH ROW EXECUTE FUNCTION core.keep_access_operation_phase();
--> statement-breakpoint

-- R2-M1: every access subject is checked against its Core principal kind on write.
CREATE TRIGGER core_access_assignments_subject_kind
BEFORE INSERT OR UPDATE ON core.access_assignments
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('principal_id', 'human', 'agent_id', 'agent', 'assigned_by', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_roles_subject_kind
BEFORE INSERT OR UPDATE ON core.access_roles
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('created_by', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_role_revisions_subject_kind
BEFORE INSERT OR UPDATE ON core.access_role_revisions
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('created_by', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_delegations_subject_kind
BEFORE INSERT OR UPDATE ON core.access_delegations
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('granted_by', 'human', 'manager_id', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_change_decisions_subject_kind
BEFORE INSERT OR UPDATE ON core.access_change_decisions
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('decided_by', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_connections_subject_kind
BEFORE INSERT OR UPDATE ON core.access_agent_connections
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('agent_id', 'agent', 'principal_id', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_consent_snapshots_subject_kind
BEFORE INSERT OR UPDATE ON core.access_consent_snapshots
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('granted_by', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_proposals_subject_kind
BEFORE INSERT OR UPDATE ON core.access_proposals
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('requester_principal_id', 'human', 'rejected_by', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_mandates_subject_kind
BEFORE INSERT OR UPDATE ON core.access_mandates
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('approver_id', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_memberships_subject_kind
BEFORE INSERT OR UPDATE ON core.access_memberships
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('principal_id', 'human', 'agent_id', 'agent', 'recorded_by', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_team_members_subject_kind
BEFORE INSERT OR UPDATE ON core.access_team_members
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('principal_id', 'human', 'agent_id', 'agent', 'added_by', 'human');
--> statement-breakpoint
CREATE TRIGGER core_access_decision_logs_subject_kind
BEFORE INSERT OR UPDATE ON core.access_decision_logs
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('actor_principal_id', 'human');
--> statement-breakpoint
-- R2-M2: an envelope never grows in place.
CREATE TRIGGER core_access_delegations_envelope
BEFORE UPDATE ON core.access_delegations
FOR EACH ROW EXECUTE FUNCTION core.keep_access_revocable_envelope();
--> statement-breakpoint
CREATE TRIGGER core_access_connections_envelope
BEFORE UPDATE ON core.access_agent_connections
FOR EACH ROW EXECUTE FUNCTION core.keep_access_revocable_envelope();
--> statement-breakpoint
-- R2-M3: a company-local role variant stays inside its legal entity.
CREATE TRIGGER core_access_assignments_scope
BEFORE INSERT OR UPDATE ON core.access_assignments
FOR EACH ROW EXECUTE FUNCTION core.check_access_assignment_scope();
--> statement-breakpoint
CREATE TRIGGER core_access_memberships_scope
BEFORE INSERT OR UPDATE ON core.access_memberships
FOR EACH ROW EXECUTE FUNCTION core.check_access_membership_scope();
--> statement-breakpoint
CREATE TRIGGER core_access_memberships_identity
BEFORE UPDATE ON core.access_memberships
FOR EACH ROW EXECUTE FUNCTION core.keep_access_membership();
--> statement-breakpoint
CREATE TRIGGER core_access_teams_identity
BEFORE UPDATE ON core.access_teams
FOR EACH ROW EXECUTE FUNCTION core.keep_access_team_identity();
--> statement-breakpoint
-- L3: evidence is never removed, so no incarnation identifier is ever freed for reuse.
CREATE TRIGGER core_access_assignments_no_delete
BEFORE DELETE ON core.access_assignments
FOR EACH ROW EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_assignments_no_truncate
BEFORE TRUNCATE ON core.access_assignments
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_grant_incarnations_no_delete
BEFORE DELETE ON core.access_grant_incarnations
FOR EACH ROW EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_grant_incarnations_no_truncate
BEFORE TRUNCATE ON core.access_grant_incarnations
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_proposals_no_delete
BEFORE DELETE ON core.access_proposals
FOR EACH ROW EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_proposals_no_truncate
BEFORE TRUNCATE ON core.access_proposals
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_delegations_no_delete
BEFORE DELETE ON core.access_delegations
FOR EACH ROW EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_delegations_no_truncate
BEFORE TRUNCATE ON core.access_delegations
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_change_decisions_no_truncate
BEFORE TRUNCATE ON core.access_change_decisions
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_mandate_grants_no_truncate
BEFORE TRUNCATE ON core.access_mandate_grants
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_consent_snapshots_no_truncate
BEFORE TRUNCATE ON core.access_consent_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
-- Connections, change items, journals and fences are evidence too: removing a row would free an
-- incarnation, reset a fence revision or lose the history of a Novinky item (R3b-N4).
CREATE TRIGGER core_access_connections_no_delete
BEFORE DELETE ON core.access_agent_connections
FOR EACH ROW EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_connections_no_truncate
BEFORE TRUNCATE ON core.access_agent_connections
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_change_items_no_delete
BEFORE DELETE ON core.access_change_items
FOR EACH ROW EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_change_items_no_truncate
BEFORE TRUNCATE ON core.access_change_items
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_operation_journals_no_delete
BEFORE DELETE ON core.access_operation_journals
FOR EACH ROW EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_operation_journals_no_truncate
BEFORE TRUNCATE ON core.access_operation_journals
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_scope_fences_no_delete
BEFORE DELETE ON core.access_scope_fences
FOR EACH ROW EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_scope_fences_no_truncate
BEFORE TRUNCATE ON core.access_scope_fences
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
-- A scope is the context a grant, an assignment and a mandate are held in: it never moves and never
-- disappears, so a live assignment can never escape its role's legal entity through a later scope
-- update (R3b-N4).
CREATE TRIGGER core_access_scopes_append_only
BEFORE UPDATE OR DELETE ON core.access_scopes
FOR EACH ROW EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
CREATE TRIGGER core_access_scopes_no_truncate
BEFORE TRUNCATE ON core.access_scopes
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_append_only_change();
--> statement-breakpoint
-- A membership is evidence: a departure revokes it and a rejoin writes a new one, so no row is ever
-- deleted or truncated. A team identity is equally permanent; only a team membership row is removed,
-- when the holder stops taking part in that team (D27, O24).
CREATE TRIGGER core_access_memberships_no_delete
BEFORE DELETE ON core.access_memberships
FOR EACH ROW EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_memberships_no_truncate
BEFORE TRUNCATE ON core.access_memberships
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_teams_no_delete
BEFORE DELETE ON core.access_teams
FOR EACH ROW EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_teams_no_truncate
BEFORE TRUNCATE ON core.access_teams
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_team_members_no_truncate
BEFORE TRUNCATE ON core.access_team_members
FOR EACH STATEMENT EXECUTE FUNCTION core.reject_access_record_removal();
--> statement-breakpoint
CREATE TRIGGER core_access_roles_identity
BEFORE UPDATE ON core.access_roles
FOR EACH ROW EXECUTE FUNCTION core.keep_access_role_identity();
--> statement-breakpoint
-- O63/M5: the approval record binds the approving person's own live assignments, and every witness
-- row it holds is held by the holder its purpose names, in the assignment the approval names.
CREATE TRIGGER core_access_mandates_authority
BEFORE INSERT ON core.access_mandates
FOR EACH ROW EXECUTE FUNCTION core.check_access_mandate();
--> statement-breakpoint
CREATE TRIGGER core_access_mandate_grants_witness
BEFORE INSERT OR UPDATE ON core.access_mandate_grants
FOR EACH ROW EXECUTE FUNCTION core.check_access_mandate_grant();
--> statement-breakpoint
-- M5: a proposal and its one approval record are required of each other at commit time, so the write
-- order inside an approval is free while no half-approved pair can ever be stored.
CREATE CONSTRAINT TRIGGER core_access_proposals_approval
AFTER INSERT OR UPDATE ON core.access_proposals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION core.require_access_proposal_approval();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER core_access_mandates_proposal
AFTER INSERT OR UPDATE ON core.access_mandates
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION core.require_access_proposal_approval();
