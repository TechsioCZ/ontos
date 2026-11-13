-- Repairs companies the tax-classification migration left unreadable: for a company with a catalogue but no product
-- held at a stored rate, `migration_tax_rates` aggregated zero holds into `"heldProductRates": null`, which Merchandise
-- refuses to decode (the key is optional, never null), so every catalogue read of that company answered unavailable.
-- The key goes; nothing else in the document changes. Idempotent: a database without such a row changes nothing. Safe
-- while either release serves: the release before classifications never reads `tax_rates`, and this release reads the
-- repaired document as "no holds". The head's revision and update time advance as a sync with Tax that changes the
-- stored rates advances them, so nothing keyed on the revision keeps the unreadable state.
-- The table is locked by every catalogue write; never queue them behind this statement for long.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
UPDATE "demo_merchandise"."catalog_heads"
   SET tax_rates = tax_rates - 'heldProductRates',
       revision = revision + 1,
       updated_at = now()
 WHERE tax_rates -> 'heldProductRates' = 'null'::jsonb;--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
