-- Earlier fixture databases applied the permit table before row security was added.
ALTER TABLE assortment.c14_rule_fixture_permits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assortment.c14_rule_fixture_permits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_policy
    WHERE polrelid = 'assortment.c14_rule_fixture_permits'::regclass
      AND polname = 'c14_rule_fixture_permits_owner'
  ) THEN
    CREATE POLICY c14_rule_fixture_permits_owner ON assortment.c14_rule_fixture_permits TO CURRENT_USER
      USING (
        SESSION_USER = CURRENT_USER
        OR (
          tenant_id = nullif(pg_catalog.current_setting('ontos.tenant_id', true), '')::uuid
          AND legal_entity_id = nullif(pg_catalog.current_setting('ontos.legal_entity_id', true), '')::uuid
        )
      )
      WITH CHECK (SESSION_USER = CURRENT_USER);
  END IF;
END;
$$;
