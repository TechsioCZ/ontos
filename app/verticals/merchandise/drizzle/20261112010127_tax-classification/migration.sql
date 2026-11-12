-- Products name a VAT classification instead of a rate; Tax (commerce.tax) holds the rates. Products: 21 -> standard,
-- 12 and 10 -> reduced; any other product rate (0 included) stops the deploy (`pnpm demo:vat-preflight` lists them).
-- Prices are never recomputed: every stored net, gross, tier and market price stays exactly as stored. Order lines keep
-- their stored rate and amounts and gain the classification only where it is unambiguous: 21 -> standard,
-- 12 -> reduced, anything else (10 %, 0 %) none. Each company's materialised rates are seeded from the stored ones, so
-- nothing waits for Tax after the deploy.
-- The release still serving writes these tables while this runs. A long transaction of it would make the ALTERs and
-- UPDATEs below wait, and every later write would queue behind them: fail the deploy fast instead. The migrator then
-- fails, the new container does not publish, the old release keeps serving, and the next deploy runs it again.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DO $$
DECLARE
  blocking text;
BEGIN
  SELECT string_agg(format('%s/%s %s: %s', tenant_id, legal_entity_id, id, coalesce(document->>'vatRate', 'missing')), '; ')
    INTO blocking
    FROM (
      SELECT tenant_id, legal_entity_id, id, document
        FROM "demo_merchandise"."products"
       WHERE coalesce(CASE WHEN (document->>'vatRate') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN trim((document->>'vatRate'))::numeric END, -1) NOT IN (21, 12, 10)
       ORDER BY tenant_id, legal_entity_id, id
       LIMIT 50
    ) AS unmapped;
  IF blocking IS NOT NULL THEN
    RAISE EXCEPTION 'Products without a VAT classification mapping (only 21, 12 and 10 map): %', blocking
      USING ERRCODE = '23514', HINT = 'Run the merchandise VAT preflight and decide these products before deploying.';
  END IF;
  SELECT string_agg(format('%s/%s order %s: %s', tenant_id, legal_entity_id, id, rate), '; ')
    INTO blocking
    FROM (
      SELECT o.tenant_id, o.legal_entity_id, o.id, line->>'vatRate' AS rate
        FROM "demo_merchandise"."orders" AS o
        CROSS JOIN LATERAL jsonb_array_elements(o.document->'lines') AS line
       WHERE coalesce(CASE WHEN (line->>'vatRate') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN trim((line->>'vatRate'))::numeric END, -1) NOT IN (21, 12, 10, 0)
       LIMIT 50
    ) AS unmapped;
  IF blocking IS NOT NULL THEN
    RAISE EXCEPTION 'Order lines with an unknown VAT rate: %', blocking USING ERRCODE = '23514';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "demo_merchandise"."catalog_heads" ADD COLUMN "tax_rates" jsonb;--> statement-breakpoint
ALTER TABLE "demo_merchandise"."products" ADD COLUMN "tax_classification_code" text;--> statement-breakpoint
-- A stored VAT rate as a number, however its JSON spells it (21, 21.0 or "21"); nothing when it is not a number.
-- Every function below has a fixed search path and names its own objects by schema.
CREATE FUNCTION "demo_merchandise"."vat_percent"(p_rate text) RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT CASE WHEN p_rate ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN trim(p_rate)::numeric END $$;--> statement-breakpoint
-- A product's classification from its stored rate: 21 -> standard, 12 and 10 -> reduced, nothing else maps.
CREATE FUNCTION "demo_merchandise"."product_tax_classification"(p_rate text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE "demo_merchandise"."vat_percent"(p_rate)
             WHEN 21 THEN 'cz.vat.standard' WHEN 12 THEN 'cz.vat.reduced' WHEN 10 THEN 'cz.vat.reduced' END
  $$;--> statement-breakpoint
-- The rate a product keeps selling at until Tax first prices its company: a product stored at 10 % (BOOK-IT).
CREATE FUNCTION "demo_merchandise"."held_product_rate"(p_rate text) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT CASE "demo_merchandise"."vat_percent"(p_rate) WHEN 10 THEN 10 END $$;--> statement-breakpoint
-- An order line's classification from its stored rate, only where unambiguous: 21 -> standard, 12 -> reduced.
CREATE FUNCTION "demo_merchandise"."order_line_tax_classification"(p_rate text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE "demo_merchandise"."vat_percent"(p_rate) WHEN 21 THEN 'cz.vat.standard' WHEN 12 THEN 'cz.vat.reduced' END
  $$;--> statement-breakpoint
-- An order document with every line that lacks a classification classified by its rate; others unchanged. A document
-- without a `lines` array (no `lines` key at all included) is left exactly as it is.
CREATE FUNCTION "demo_merchandise"."tax_classified_order"(p_document jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE WHEN jsonb_typeof(p_document -> 'lines') IS DISTINCT FROM 'array' THEN p_document
      ELSE jsonb_set(p_document, '{lines}', (
        SELECT coalesce(jsonb_agg(
          CASE
            WHEN line ? 'taxClassificationCode' THEN line
            WHEN "demo_merchandise"."order_line_tax_classification"(line ->> 'vatRate') IS NULL THEN line
            ELSE line || jsonb_build_object(
              'taxClassificationCode', "demo_merchandise"."order_line_tax_classification"(line ->> 'vatRate'))
          END ORDER BY position), '[]'::jsonb)
          FROM jsonb_array_elements(p_document -> 'lines') WITH ORDINALITY AS lines(line, position)))
    END
  $$;--> statement-breakpoint
-- Every company starts from the rates its products were stored with, as the same materialised state a sync with Tax
-- writes (`catalog_heads.tax_rates`), marked MIGRATION (not yet confirmed by Tax): standard 21 %, reduced 12 %, and each
-- product stored at 10 % (BOOK-IT) held at 10 % until Tax first prices the company. Storefront reads and orders keep
-- working exactly as before without any call to Tax; Tax's first answer that prices the company replaces this state.
CREATE FUNCTION "demo_merchandise"."migration_tax_rates"(p_tenant_id uuid, p_legal_entity_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT jsonb_build_object(
             'book', jsonb_build_object(
               'fingerprint', 'migration:cz.vat.standard=21;cz.vat.reduced=12',
               'periods', jsonb_build_array(
                 jsonb_build_object('code', 'cz.vat.standard', 'effectiveFrom', '1970-01-01T00:00:00.000Z', 'ratePercent', '21'),
                 jsonb_build_object('code', 'cz.vat.reduced', 'effectiveFrom', '1970-01-01T00:00:00.000Z', 'ratePercent', '12')),
               'regime', 'VAT_PAYER'),
             'source', 'MIGRATION',
             'syncedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
           || coalesce((
             SELECT jsonb_build_object(
                      'heldProductRates',
                      jsonb_object_agg(p.id, "demo_merchandise"."held_product_rate"(p.document ->> 'vatRate')))
               FROM "demo_merchandise"."products" AS p
              WHERE p.tenant_id = p_tenant_id AND p.legal_entity_id = p_legal_entity_id
                AND "demo_merchandise"."held_product_rate"(p.document ->> 'vatRate') IS NOT NULL
           ), '{}'::jsonb)
  $$;--> statement-breakpoint
UPDATE "demo_merchandise"."catalog_heads" AS h
   SET tax_rates = "demo_merchandise"."migration_tax_rates"(h.tenant_id, h.legal_entity_id);--> statement-breakpoint
UPDATE "demo_merchandise"."products"
   SET tax_classification_code = "demo_merchandise"."product_tax_classification"(document ->> 'vatRate'),
       document = document || jsonb_build_object(
         'taxClassificationCode', "demo_merchandise"."product_tax_classification"(document ->> 'vatRate'));--> statement-breakpoint
-- A held product (stored at 10 %) whose price has no gross yet gets it now, at its held rate, so no read ever derives
-- one at the reduced classification's 12 %: its variants first, then the product itself (without real variants its
-- own net; with them its variants' lowest gross, active ones first). Rounded exactly as `grossUnitPriceMinor`. A stored
-- gross, in the column or the document, is never touched.
UPDATE "demo_merchandise"."product_variants" AS v
   SET gross_price_minor = v.price_minor
         + (v.price_minor * "demo_merchandise"."held_product_rate"(p.document ->> 'vatRate') + 50) / 100
  FROM "demo_merchandise"."products" AS p
 WHERE v.tenant_id = p.tenant_id AND v.legal_entity_id = p.legal_entity_id AND v.product_id = p.id
   AND "demo_merchandise"."held_product_rate"(p.document ->> 'vatRate') IS NOT NULL
   AND v.gross_price_minor IS NULL AND NOT (v.document ? 'grossPriceMinor') AND v.price_minor IS NOT NULL;--> statement-breakpoint
UPDATE "demo_merchandise"."products" AS p
   SET gross_price_minor = p.current_price_minor
         + (p.current_price_minor * "demo_merchandise"."held_product_rate"(p.document ->> 'vatRate') + 50) / 100
 WHERE "demo_merchandise"."held_product_rate"(p.document ->> 'vatRate') IS NOT NULL
   AND p.gross_price_minor IS NULL AND NOT (p.document ? 'grossPriceMinor')
   AND NOT EXISTS (
     SELECT 1 FROM "demo_merchandise"."product_variants" AS v
      WHERE v.tenant_id = p.tenant_id AND v.legal_entity_id = p.legal_entity_id AND v.product_id = p.id
        AND v.variant_id IS NOT NULL);--> statement-breakpoint
UPDATE "demo_merchandise"."products" AS p
   SET gross_price_minor = coalesce(
         (SELECT min(v.gross_price_minor) FROM "demo_merchandise"."product_variants" AS v
           WHERE v.tenant_id = p.tenant_id AND v.legal_entity_id = p.legal_entity_id AND v.product_id = p.id
             AND v.variant_id IS NOT NULL AND v.active),
         (SELECT min(v.gross_price_minor) FROM "demo_merchandise"."product_variants" AS v
           WHERE v.tenant_id = p.tenant_id AND v.legal_entity_id = p.legal_entity_id AND v.product_id = p.id
             AND v.variant_id IS NOT NULL))
 WHERE "demo_merchandise"."held_product_rate"(p.document ->> 'vatRate') IS NOT NULL
   AND p.gross_price_minor IS NULL AND NOT (p.document ? 'grossPriceMinor')
   AND EXISTS (
     SELECT 1 FROM "demo_merchandise"."product_variants" AS v
      WHERE v.tenant_id = p.tenant_id AND v.legal_entity_id = p.legal_entity_id AND v.product_id = p.id
        AND v.variant_id IS NOT NULL);--> statement-breakpoint
UPDATE "demo_merchandise"."orders"
   SET document = "demo_merchandise"."tax_classified_order"(document)
 WHERE document IS DISTINCT FROM "demo_merchandise"."tax_classified_order"(document);--> statement-breakpoint
ALTER TABLE "demo_merchandise"."products" ALTER COLUMN "tax_classification_code" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "demo_merchandise_products_tax_classification" ON "demo_merchandise"."products" ("tenant_id","legal_entity_id","tax_classification_code");--> statement-breakpoint
ALTER TABLE "demo_merchandise"."products" ADD CONSTRAINT "demo_merchandise_product_tax_classification" CHECK ("tax_classification_code" in ('cz.vat.standard', 'cz.vat.reduced'));--> statement-breakpoint
-- A product written with a `vatRate` gets its classification, in its column and in its document, from that rate on
-- every write, before NOT NULL and the check above see it. The old release writes the rate it chose; this release
-- writes the rate its classification maps back to (`rollbackVatRateOf`), so its own choice stays as it is. A rate
-- nothing maps (0 %) is refused by name, as the preflight above refuses it for stored products.
CREATE FUNCTION "demo_merchandise"."classify_written_product"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
    DECLARE
      code text;
    BEGIN
      IF NOT (NEW.document ? 'vatRate') THEN
        RETURN NEW;
      END IF;
      code := "demo_merchandise"."product_tax_classification"(NEW.document ->> 'vatRate');
      IF code IS NULL THEN
        RAISE EXCEPTION 'Product % has VAT rate % %%, which names no VAT classification (only 21, 12 and 10 do)',
          NEW.id, NEW.document ->> 'vatRate'
          USING ERRCODE = '23514';
      END IF;
      NEW.tax_classification_code := code;
      NEW.document := NEW.document || jsonb_build_object('taxClassificationCode', code);
      RETURN NEW;
    END
  $$;--> statement-breakpoint
CREATE TRIGGER "products_tax_classification"
  BEFORE INSERT OR UPDATE OF "document", "tax_classification_code" ON "demo_merchandise"."products"
  FOR EACH ROW EXECUTE FUNCTION "demo_merchandise"."classify_written_product"();--> statement-breakpoint
-- The same product's hold, kept in its company's migrated rates while they are still MIGRATION: a product written at
-- 10 % is held at 10 %, any other rate drops its hold. Nothing changes once Tax priced the company.
CREATE FUNCTION "demo_merchandise"."hold_written_product"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
    DECLARE
      held integer;
    BEGIN
      IF NOT (NEW.document ? 'vatRate') THEN
        RETURN NULL;
      END IF;
      held := "demo_merchandise"."held_product_rate"(NEW.document ->> 'vatRate');
      UPDATE "demo_merchandise"."catalog_heads" AS h
         SET tax_rates = CASE
               WHEN held IS NOT NULL THEN h.tax_rates || jsonb_build_object(
                 'heldProductRates', coalesce(h.tax_rates -> 'heldProductRates', '{}'::jsonb) || jsonb_build_object(NEW.id, held))
               WHEN h.tax_rates ? 'heldProductRates' THEN jsonb_set(
                 h.tax_rates, '{heldProductRates}', (h.tax_rates -> 'heldProductRates') - NEW.id)
               ELSE h.tax_rates
             END
       WHERE h.tenant_id = NEW.tenant_id AND h.legal_entity_id = NEW.legal_entity_id
         AND h.tax_rates ->> 'source' = 'MIGRATION'
         AND (held IS NOT NULL OR h.tax_rates -> 'heldProductRates' ? NEW.id);
      RETURN NULL;
    END
  $$;--> statement-breakpoint
CREATE TRIGGER "products_tax_hold"
  AFTER INSERT OR UPDATE OF "document" ON "demo_merchandise"."products"
  FOR EACH ROW EXECUTE FUNCTION "demo_merchandise"."hold_written_product"();--> statement-breakpoint
-- An order the old release writes: each line it adds or rewrites without a classification is classified as above.
CREATE FUNCTION "demo_merchandise"."classify_written_order"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
    BEGIN
      NEW.document := "demo_merchandise"."tax_classified_order"(NEW.document);
      RETURN NEW;
    END
  $$;--> statement-breakpoint
CREATE TRIGGER "orders_tax_classification"
  BEFORE INSERT OR UPDATE OF "document" ON "demo_merchandise"."orders"
  FOR EACH ROW EXECUTE FUNCTION "demo_merchandise"."classify_written_order"();--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
