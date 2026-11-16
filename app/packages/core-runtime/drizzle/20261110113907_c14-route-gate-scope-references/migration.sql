-- An unbound route without real owner scope conveys no write authority.
DELETE FROM core.source_execution_gates g
WHERE NOT EXISTS (SELECT 1 FROM core.source_execution_fences f WHERE f.tenant_id=g.tenant_id AND f.gate_id=g.gate_id)
  AND (
    NOT EXISTS (SELECT 1 FROM core.principals p WHERE p.tenant_id=g.tenant_id AND p.principal_id=g.principal_id)
    OR (g.legal_entity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM core.legal_entities e WHERE e.tenant_id=g.tenant_id AND e.legal_entity_id=g.legal_entity_id
    ))
  );
--> statement-breakpoint
ALTER TABLE "core"."source_execution_gates" ADD CONSTRAINT "source_execution_gates_principal_scope_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "core"."principals"("tenant_id","principal_id");--> statement-breakpoint
ALTER TABLE "core"."source_execution_gates" ADD CONSTRAINT "source_execution_gates_legal_entity_scope_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "core"."legal_entities"("tenant_id","legal_entity_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trust.publish_source_execution_gate(
  p_tenant_id uuid, p_gate_id uuid, p_owner_key text, p_principal_id uuid, p_legal_entity_id uuid,
  p_revision text, p_mapping_version text, p_active boolean, p_replace_enrollment boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.principals p WHERE p.tenant_id=p_tenant_id AND p.principal_id=p_principal_id)
    OR (p_legal_entity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM core.legal_entities e WHERE e.tenant_id=p_tenant_id AND e.legal_entity_id=p_legal_entity_id
    )) THEN
    UPDATE core.source_execution_gates g SET active=false, epoch=pg_catalog.gen_random_uuid()
      WHERE g.tenant_id=p_tenant_id AND g.gate_id=p_gate_id AND g.owner_key=p_owner_key AND g.active;
    RETURN;
  END IF;
  INSERT INTO core.source_execution_gates AS existing
    (tenant_id,gate_id,owner_key,principal_id,legal_entity_id,revision,mapping_version,epoch,active)
  VALUES (p_tenant_id,p_gate_id,p_owner_key,p_principal_id,p_legal_entity_id,p_revision,p_mapping_version,
    pg_catalog.gen_random_uuid(),p_active)
  ON CONFLICT (tenant_id,gate_id) DO UPDATE SET
    principal_id=excluded.principal_id,
    legal_entity_id=excluded.legal_entity_id,
    revision=excluded.revision,
    mapping_version=excluded.mapping_version,
    epoch=CASE
      WHEN p_replace_enrollment OR
        (existing.principal_id,existing.legal_entity_id,existing.revision,existing.mapping_version)
          IS DISTINCT FROM
        (excluded.principal_id,excluded.legal_entity_id,excluded.revision,excluded.mapping_version)
      THEN excluded.epoch ELSE existing.epoch END,
    active=excluded.active
  WHERE existing.owner_key=excluded.owner_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source execution gate is already owned by a different publisher';
  END IF;
END $$;

--> statement-breakpoint
DROP FUNCTION IF EXISTS trust.backfill_source_execution_gate(uuid,uuid,uuid,text,text);
