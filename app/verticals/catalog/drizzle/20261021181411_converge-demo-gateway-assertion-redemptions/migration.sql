DO $$ BEGIN
  IF to_regclass('"catalog"."gateway_assertion_redemptions"') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'catalog'
      AND table_name = 'gateway_assertion_redemptions' AND column_name = 'redeemed_at') THEN
    DROP TABLE "catalog"."gateway_assertion_redemptions";
  END IF;
END $$;
