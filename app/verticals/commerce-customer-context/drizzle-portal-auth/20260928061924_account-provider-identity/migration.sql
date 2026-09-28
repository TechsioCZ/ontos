-- Expand for Better Auth 1.7.3+, which keys accounts on (provider_id, account_id) and no longer
-- writes "issuer". The previous release still writes and reads "issuer", so it stays, nullable,
-- until a later contraction release drops it and its index. Each provider has one issuer, so
-- the new unique index holds for every existing row. Until then a trigger derives the legacy issuer
-- for rows written without one, as `auth.account_issuer_compat` does for the Auth owner, so a
-- previous-release provider still finds accounts the new release creates.
ALTER TABLE "commerce_auth"."account" ALTER COLUMN "issuer" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_auth_account_provider_id_account_id_uk" ON "commerce_auth"."account" ("provider_id","account_id");--> statement-breakpoint
CREATE FUNCTION "commerce_auth"."account_issuer_compat"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."issuer" IS NULL THEN
    NEW."issuer" := CASE
      WHEN NEW."provider_id" = 'credential' THEN 'local:credential'
      ELSE 'local:oauth:' || NEW."provider_id"
    END;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "account_issuer_compat"
BEFORE INSERT ON "commerce_auth"."account"
FOR EACH ROW EXECUTE FUNCTION "commerce_auth"."account_issuer_compat"();
