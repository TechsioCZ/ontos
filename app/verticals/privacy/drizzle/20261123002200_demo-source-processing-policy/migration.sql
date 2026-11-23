CREATE TABLE privacy.demo_source_processing_policies (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  policy_id text NOT NULL,
  policy_record jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by text NOT NULL DEFAULT current_user,
  PRIMARY KEY (tenant_id, legal_entity_id, policy_id)
);
--> statement-breakpoint
ALTER TABLE privacy.demo_source_processing_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE privacy.demo_source_processing_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY privacy_demo_source_processing_policies_select
  ON privacy.demo_source_processing_policies FOR SELECT TO ontos_runtime
  USING (
    tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid
    AND legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid
  );
--> statement-breakpoint
REVOKE ALL ON privacy.demo_source_processing_policies FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
GRANT SELECT ON privacy.demo_source_processing_policies TO ontos_runtime;
