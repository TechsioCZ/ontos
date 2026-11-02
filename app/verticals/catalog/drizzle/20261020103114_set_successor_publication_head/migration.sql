CREATE OR REPLACE FUNCTION "catalog"."validate_set_composition_current"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM catalog.set_composition_revisions r
    WHERE r.tenant_id = NEW.tenant_id AND r.composition_id = NEW.composition_id
      AND r.product_id = NEW.product_id AND r.variant_id = NEW.variant_id
      AND r.revision = NEW.current_revision
      AND (
        NEW.current_revision > 1
        OR (
          r.effective_from <= now()
          AND (r.effective_to IS NULL OR r.effective_to > now())
        )
      )
      AND (r.lifecycle_state <> 'ACTIVE' OR (
        SELECT count(*) FROM catalog.set_composition_components c
        WHERE c.tenant_id = r.tenant_id AND c.composition_id = r.composition_id AND c.revision = r.revision
      ) >= 2)
  ) THEN
    RAISE EXCEPTION 'Catalog Set current revision is absent, ineffective, or incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
