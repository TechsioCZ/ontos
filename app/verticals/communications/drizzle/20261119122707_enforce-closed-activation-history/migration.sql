-- A closed activation is history: it can be neither rewritten, reopened nor removed, by any role. Column privileges let the
-- runtime role close an open row once; this trigger makes that the only change a row can ever undergo.
CREATE FUNCTION "communications"."reject_closed_template_activation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'closed template activations are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "communications"."reject_closed_template_activation_mutation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "communications_template_activations_closed_append_only" BEFORE UPDATE OR DELETE ON "communications"."template_activations" FOR EACH ROW WHEN (OLD."ended_at" IS NOT NULL) EXECUTE FUNCTION "communications"."reject_closed_template_activation_mutation"();
