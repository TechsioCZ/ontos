CREATE TABLE "assortment"."c14_rule_fixture_permits" (
	"command_digest" text NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"permit_digest" text PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"source_principal_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "assortment_c14_permits_command_digest_ck" CHECK ("command_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assortment_c14_permits_permit_digest_ck" CHECK ("permit_digest" ~ '^[0-9a-f]{64}$')
);

--> statement-breakpoint
ALTER TABLE assortment.c14_rule_fixture_permits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assortment.c14_rule_fixture_permits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The migration identity administers permits. A definer called by runtime reads only its exact scope.
CREATE POLICY c14_rule_fixture_permits_owner ON assortment.c14_rule_fixture_permits TO CURRENT_USER
  USING (
    SESSION_USER = CURRENT_USER
    OR (
      tenant_id = nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
      AND legal_entity_id = nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
    )
  )
  WITH CHECK (SESSION_USER = CURRENT_USER);
