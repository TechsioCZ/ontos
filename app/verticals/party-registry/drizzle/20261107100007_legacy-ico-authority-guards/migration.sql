CREATE FUNCTION party.guard_legacy_ico_authority() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, party
AS $function$
DECLARE
  affected_tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'party_legacy_ico_authority_fences' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'Party legacy ICO authority fence is permanent' USING ERRCODE = '23514';
    END IF;
    affected_tenant := NEW.tenant_id;
  ELSE
    -- DIČ remains Party-owned and retains its existing lifecycle.
    IF NEW.identifier_type_key <> 'ICO' AND (TG_OP = 'INSERT' OR OLD.identifier_type_key <> 'ICO') THEN
      RETURN NEW;
    END IF;
    affected_tenant := NEW.tenant_id;
    IF TG_OP = 'UPDATE' AND OLD.tenant_id <> NEW.tenant_id THEN
      RAISE EXCEPTION 'Party assertion Tenant is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Identical to tenantIdentityWriteLockKey: serialize direct owner writes with the governed fence.
  PERFORM pg_advisory_xact_lock(hashtextextended('["party.registry.identity-write.v1",' || to_json(affected_tenant::text)::text || ']', 0));
  IF TG_TABLE_NAME = 'party_official_identifiers' AND EXISTS (
    SELECT 1 FROM party.party_legacy_ico_authority_fences WHERE tenant_id = affected_tenant
  ) THEN
    RAISE EXCEPTION 'Party ICO authority has transferred to Commerce' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION party.guard_legacy_ico_authority() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER party_legacy_ico_authority_fence_guard
BEFORE INSERT OR UPDATE OR DELETE ON party.party_legacy_ico_authority_fences
FOR EACH ROW EXECUTE FUNCTION party.guard_legacy_ico_authority();
--> statement-breakpoint
CREATE TRIGGER party_official_identifiers_ico_authority_guard
BEFORE INSERT OR UPDATE ON party.party_official_identifiers
FOR EACH ROW EXECUTE FUNCTION party.guard_legacy_ico_authority();
