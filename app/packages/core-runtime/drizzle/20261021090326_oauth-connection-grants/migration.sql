CREATE TABLE "core"."oauth_connection_grants" (
	"grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"user_principal_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"acting_kind" text NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"client_host" text NOT NULL,
	"client_kind" text NOT NULL,
	"client_logo_uri" text,
	"modules_json" jsonb NOT NULL,
	"write_policy" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"auth_binding_id" uuid,
	"consent_id" text,
	"session_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consented_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_principal_id" uuid,
	"revoke_reason" text,
	CONSTRAINT "core_oauth_grants_status_ck" CHECK ("status" in ('draft', 'active', 'denied', 'revoked', 'superseded')),
	CONSTRAINT "core_oauth_grants_acting_kind_ck" CHECK ("acting_kind" in ('human', 'agent')),
	CONSTRAINT "core_oauth_grants_client_kind_ck" CHECK ("client_kind" in ('cimd', 'loopback')),
	CONSTRAINT "core_oauth_grants_write_policy_ck" CHECK ("write_policy" in ('read_only', 'approval', 'direct')),
	CONSTRAINT "core_oauth_grants_revoke_reason_ck" CHECK ("revoke_reason" is null or "revoke_reason" in ('user', 'admin', 'superseded', 'operator_removed', 'agent_disabled', 'user_disabled', 'password_changed'))
);
--> statement-breakpoint
CREATE INDEX "core_oauth_grants_company_status_idx" ON "core"."oauth_connection_grants" ("tenant_id","legal_entity_id","status");--> statement-breakpoint
CREATE INDEX "core_oauth_grants_user_status_idx" ON "core"."oauth_connection_grants" ("user_id","status");--> statement-breakpoint
CREATE INDEX "core_oauth_grants_acting_status_idx" ON "core"."oauth_connection_grants" ("acting_principal_id","status");--> statement-breakpoint
CREATE INDEX "core_oauth_grants_client_idx" ON "core"."oauth_connection_grants" ("client_id");--> statement-breakpoint
CREATE INDEX "core_oauth_grants_session_idx" ON "core"."oauth_connection_grants" ("session_id");--> statement-breakpoint
ALTER TABLE "core"."action_invocations" DROP CONSTRAINT "core_action_invocations_auth_method_ck", ADD CONSTRAINT "core_action_invocations_auth_method_ck" CHECK ("auth_method" is null or "auth_method" in ('session', 'api_key', 'system', 'support_impersonation', 'oauth_connection'));--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" DROP CONSTRAINT "core_auth_bindings_subject_type_ck", ADD CONSTRAINT "core_auth_bindings_subject_type_ck" CHECK ("subject_type" in ('user', 'api_key', 'oauth_grant'));