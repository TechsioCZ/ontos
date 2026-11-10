ALTER TABLE "core"."access_memberships" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ADD COLUMN "ended_by" uuid;--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ADD COLUMN "ended_reason" text;--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ADD CONSTRAINT "access_memberships_ender_fk" FOREIGN KEY ("tenant_id","ended_by") REFERENCES "core"."principals"("tenant_id","principal_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ADD CONSTRAINT "access_memberships_end_ck" CHECK (("ended_by" is null and "ended_at" is null and "ended_reason" is null) or ("status" = 'revoked' and "ended_by" is not null and "ended_at" is not null));--> statement-breakpoint
ALTER TABLE "core"."access_memberships" ADD CONSTRAINT "access_memberships_end_reason_ck" CHECK ("ended_reason" is null or length("ended_reason") between 1 and 500);--> statement-breakpoint
-- A6: the end of a membership is attributed once. The people commands record who ended a row, when
-- and why on its move to 'revoked'; every other writer that revokes leaves the three columns null.
-- Afterwards they never change, and they never change on any other transition, so an ended row
-- cannot be re-attributed and a live row cannot carry an end.
CREATE OR REPLACE FUNCTION core.keep_access_membership() RETURNS trigger
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
  IF (NEW.ended_by IS DISTINCT FROM OLD.ended_by
      OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
      OR NEW.ended_reason IS DISTINCT FROM OLD.ended_reason)
     AND NOT (OLD.status <> 'revoked' AND NEW.status = 'revoked') THEN
    RAISE EXCEPTION 'A membership end is recorded once, by its revocation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
-- The person who ends a membership is a verified human, like the one who recorded it (R2-M1).
DROP TRIGGER core_access_memberships_subject_kind ON core.access_memberships;
--> statement-breakpoint
CREATE TRIGGER core_access_memberships_subject_kind
BEFORE INSERT OR UPDATE ON core.access_memberships
FOR EACH ROW EXECUTE FUNCTION core.require_access_principal_kinds('principal_id', 'human', 'agent_id', 'agent', 'recorded_by', 'human', 'ended_by', 'human');
