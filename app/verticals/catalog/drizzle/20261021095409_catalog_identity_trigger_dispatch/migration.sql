-- Dispatch on the trigger table before resolving table-specific record fields.
CREATE OR REPLACE FUNCTION "catalog"."protect_410_identity"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.current_revision <= OLD.current_revision THEN
    RAISE EXCEPTION 'catalog descriptive identity or revision is invalid' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'product_localized_facts' THEN
    IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.locale IS DISTINCT FROM OLD.locale THEN
      RAISE EXCEPTION 'catalog descriptive identity is immutable' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'variant_localized_facts' THEN
    IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.locale IS DISTINCT FROM OLD.locale THEN
      RAISE EXCEPTION 'catalog descriptive identity is immutable' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'catalog_media_assignment_sets' THEN
    IF NEW.assignment_set_id IS DISTINCT FROM OLD.assignment_set_id OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id THEN
      RAISE EXCEPTION 'catalog descriptive identity is immutable' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'catalog_media_assignments' THEN
    IF NEW.assignment_id IS DISTINCT FROM OLD.assignment_id OR NEW.assignment_set_id IS DISTINCT FROM OLD.assignment_set_id THEN
      RAISE EXCEPTION 'catalog descriptive identity is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
