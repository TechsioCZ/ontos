-- Invoice lines, recurring-template lines and price-list items name the Tax VAT classification of their rate.
-- A stored 21 % becomes the standard classification (cz.vat.standard) and 12 % the reduced one (cz.vat.reduced).
-- Every other stored rate (10 %, 15 %, 0 %) keeps its rate and gets no classification, and an entry that already
-- names a classification or a VAT treatment is left as it is. Rates, amounts, totals and VAT recaps do not change,
-- so every invoice keeps exactly the amounts it was issued with. A stored line gets no Tax rule revision reference:
-- only lines priced from Tax carry one.
--
-- Expand step. The release before this one keeps serving until the new one publishes (minutes), and it rewrites a
-- company's whole ledger on every write, dropping the classification it does not know. So the mapping is one
-- function, used by the backfill below and by a trigger that applies it to every ledger the old release writes in that
-- window: whatever it writes is classified exactly as the backfill classifies it. Applying it to a ledger the new
-- release writes changes nothing (its entries already carry a classification or a treatment). The contract step drops
-- the trigger and the function.
-- Every function below has a fixed search path and names its own objects by schema.
CREATE FUNCTION "finance_billing"."vat_classified_entry"(p_entry jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE
             WHEN p_entry ? 'vatClassification' OR p_entry ? 'vatTreatment' THEN p_entry
             WHEN p_entry -> 'vatRate' = '21'::jsonb THEN p_entry || '{"vatClassification":"cz.vat.standard"}'::jsonb
             WHEN p_entry -> 'vatRate' = '12'::jsonb THEN p_entry || '{"vatClassification":"cz.vat.reduced"}'::jsonb
             ELSE p_entry
           END
  $$;--> statement-breakpoint
CREATE FUNCTION "finance_billing"."vat_classified_lines"(p_lines jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce(jsonb_agg("finance_billing"."vat_classified_entry"(entry) ORDER BY position), '[]'::jsonb)
      FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS entries(entry, position)
  $$;--> statement-breakpoint
-- Classifies a ledger: the lines of every invoice and recurring template and every price-list item.
CREATE FUNCTION "finance_billing"."vat_classified_state"(p_state jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT p_state
             || CASE WHEN jsonb_typeof(p_state -> 'invoices') = 'array' THEN jsonb_build_object(
                  'invoices',
                  (SELECT coalesce(jsonb_agg(
                            CASE WHEN jsonb_typeof(invoice -> 'lines') = 'array'
                              THEN invoice || jsonb_build_object(
                                'lines', "finance_billing"."vat_classified_lines"(invoice -> 'lines'))
                              ELSE invoice END ORDER BY position), '[]'::jsonb)
                     FROM jsonb_array_elements(p_state -> 'invoices') WITH ORDINALITY AS invoices(invoice, position)))
                ELSE '{}'::jsonb END
             || CASE WHEN jsonb_typeof(p_state -> 'recurringTemplates') = 'array' THEN jsonb_build_object(
                  'recurringTemplates',
                  (SELECT coalesce(jsonb_agg(
                            CASE WHEN jsonb_typeof(template -> 'lines') = 'array'
                              THEN template || jsonb_build_object(
                                'lines', "finance_billing"."vat_classified_lines"(template -> 'lines'))
                              ELSE template END ORDER BY position), '[]'::jsonb)
                     FROM jsonb_array_elements(p_state -> 'recurringTemplates')
                          WITH ORDINALITY AS templates(template, position)))
                ELSE '{}'::jsonb END
             || CASE WHEN jsonb_typeof(p_state -> 'priceList') = 'array'
                  THEN jsonb_build_object('priceList', "finance_billing"."vat_classified_lines"(p_state -> 'priceList'))
                ELSE '{}'::jsonb END
  $$;--> statement-breakpoint
UPDATE "finance_billing"."finance_states"
   SET "state" = "finance_billing"."vat_classified_state"("state")
 WHERE "state" IS DISTINCT FROM "finance_billing"."vat_classified_state"("state");--> statement-breakpoint
CREATE FUNCTION "finance_billing"."vat_classify_finance_state"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
    BEGIN
      NEW."state" := "finance_billing"."vat_classified_state"(NEW."state");
      RETURN NEW;
    END
  $$;--> statement-breakpoint
CREATE TRIGGER "finance_states_vat_classification"
  BEFORE INSERT OR UPDATE OF "state" ON "finance_billing"."finance_states"
  FOR EACH ROW EXECUTE FUNCTION "finance_billing"."vat_classify_finance_state"();
