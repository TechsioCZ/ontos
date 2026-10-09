-- #797: a VALUE_ONLY_CURRENT request at a later effective boundary is an immutable successor,
-- even when its monetary value is unchanged. Preserve UNCHANGED only for the exact existing
-- interval. Patch the deployed routine without rewriting the historical migration that owns it.
DO $migration$
DECLARE
  v_definition text;
  v_old_predicate constant text :=
    'IF v_intent = ''VALUE_ONLY_CURRENT'' AND v_amount = v_target_amount AND v_currency = v_target_currency THEN';
  v_new_predicate constant text :=
    'IF v_intent = ''VALUE_ONLY_CURRENT''
      AND v_amount = v_target_amount
      AND v_currency = v_target_currency
      AND v_new_from = v_target_from
    THEN';
  v_match_at integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
           'pricing.revise_price_v1(uuid,uuid,jsonb)'::pg_catalog.regprocedure
         )
    INTO v_definition;

  v_match_at := pg_catalog.strpos(v_definition, v_old_predicate);
  IF v_match_at = 0
    OR pg_catalog.strpos(
         pg_catalog.substr(v_definition, v_match_at + pg_catalog.length(v_old_predicate)),
         v_old_predicate
       ) > 0
  THEN
    RAISE EXCEPTION 'Pricing revise_price_v1 VALUE_ONLY_CURRENT predicate does not match the expected deployed contract'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE pg_catalog.replace(v_definition, v_old_predicate, v_new_predicate);
END;
$migration$;
--> statement-breakpoint
