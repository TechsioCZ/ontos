-- A product holding stock it cannot sell is no longer „Skladem“. Availability now needs stock that covers the unit's
-- first orderable quantity: its minimum (1 when not stated) rounded up to whole packages (`availabilityOf` with
-- `firstOrderableQuantity`); a variant is judged by its own minimum and package, as checkout reads them. The column
-- `products.availability` is derived only when a product or its stock is written, so every row untouched since keeps the
-- old verdict: 6 pieces sold in packages of 10 still read IN_STOCK in the staff list and under the storefront „Skladem“
-- filter, while the shop refuses to sell them. This recomputes exactly those rows with the release's rule.
-- Only IN_STOCK and LOW_STOCK rows can change: the rule only adds a refusal. A product without real variants (an id and
-- a price) is judged by its own stock, minimum and package; one with real variants takes its best active variant
-- (IN_STOCK above the product's low-stock threshold, else LOW_STOCK, else OUT_OF_STOCK), as `toProductRecord` does.
-- Nothing else changes: no document, no stock, no revision, no timestamp. Idempotent: a second run changes no row.
-- Safe while either release serves: the release before writes the old verdict for a product it changes in the overlap,
-- and the next write of that product by this release corrects it.
-- The migration administrator is not bound by the table's row-level security: every tenant's rows change.
-- The table is locked by every catalogue write; never queue them behind this statement for long.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
UPDATE "demo_merchandise"."products" p
   SET availability = 'OUT_OF_STOCK'
 WHERE p.availability IN ('IN_STOCK', 'LOW_STOCK')
   AND NOT EXISTS (
     SELECT 1
       FROM "demo_merchandise"."product_variants" v
      WHERE v.tenant_id = p.tenant_id AND v.legal_entity_id = p.legal_entity_id AND v.product_id = p.id
        AND v.variant_id IS NOT NULL AND v.price_minor IS NOT NULL)
   AND p.stock_on_hand < CASE WHEN (p.document->>'packageQuantity')::numeric > 0
         THEN ceil(coalesce((p.document->>'minimumQuantity')::numeric, 1)
                / (p.document->>'packageQuantity')::numeric - 0.000001)
              * (p.document->>'packageQuantity')::numeric
         ELSE coalesce((p.document->>'minimumQuantity')::numeric, 1) END;--> statement-breakpoint
WITH candidates AS (
  SELECT tenant_id, legal_entity_id, id, availability,
         coalesce((document->>'lowStockThreshold')::numeric, 0) AS threshold
    FROM "demo_merchandise"."products"
   WHERE availability IN ('IN_STOCK', 'LOW_STOCK')
), units AS (
  SELECT v.tenant_id, v.legal_entity_id, v.product_id, v.active, v.stock_on_hand,
         CASE WHEN (v.document->>'packageQuantity')::numeric > 0
         THEN ceil(coalesce((v.document->>'minimumQuantity')::numeric, 1)
                / (v.document->>'packageQuantity')::numeric - 0.000001)
              * (v.document->>'packageQuantity')::numeric
         ELSE coalesce((v.document->>'minimumQuantity')::numeric, 1) END AS first_order
    FROM "demo_merchandise"."product_variants" v
   WHERE v.variant_id IS NOT NULL AND v.price_minor IS NOT NULL
), judged AS (
  SELECT c.tenant_id, c.legal_entity_id, c.id, c.availability AS stored,
         CASE
           WHEN bool_or(u.active AND u.stock_on_hand > 0 AND u.stock_on_hand >= u.first_order
                        AND u.stock_on_hand > c.threshold) THEN 'IN_STOCK'
           WHEN bool_or(u.active AND u.stock_on_hand > 0 AND u.stock_on_hand >= u.first_order) THEN 'LOW_STOCK'
           ELSE 'OUT_OF_STOCK'
         END AS availability
    FROM candidates c
    JOIN units u ON u.tenant_id = c.tenant_id AND u.legal_entity_id = c.legal_entity_id AND u.product_id = c.id
   GROUP BY c.tenant_id, c.legal_entity_id, c.id, c.availability, c.threshold
)
UPDATE "demo_merchandise"."products" p
   SET availability = j.availability
  FROM judged j
 WHERE p.tenant_id = j.tenant_id AND p.legal_entity_id = j.legal_entity_id AND p.id = j.id
   AND j.availability <> j.stored;--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
