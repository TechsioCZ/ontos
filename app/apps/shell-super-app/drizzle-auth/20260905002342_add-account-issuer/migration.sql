-- Better Auth 1.7 keys provider identities on (issuer, account_id). Expand as nullable, backfill
-- the synthetic issuer for every existing row, prove the new identity is unique, then tighten.
-- Backfill rule (Better Auth 1.7 upgrade guide, "provider-id" strategy):
--   credential accounts -> 'local:credential'; other providers -> 'local:oauth:<providerId>'.
ALTER TABLE "auth"."account" ADD COLUMN "issuer" text;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM auth.account
    WHERE provider_id !~ '^[A-Za-z0-9_.~-]+$'
  ) THEN
    RAISE EXCEPTION 'auth.account.provider_id contains characters that require URI encoding; backfill the issuer manually before rerunning this migration';
  END IF;
END $$;--> statement-breakpoint
UPDATE "auth"."account"
SET "issuer" = CASE
  WHEN "provider_id" = 'credential' THEN 'local:credential'
  ELSE 'local:oauth:' || "provider_id"
END
WHERE "issuer" IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM auth.account
    GROUP BY issuer, account_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'auth.account has duplicate (issuer, account_id) identities; resolve them before rerunning this migration';
  END IF;
END $$;--> statement-breakpoint
-- Expand/contract compatibility: Better Auth 1.6 writers do not supply "issuer". Derive it with the
-- same rule on insert so the previous Shell release keeps working against the expanded schema.
-- Contraction (a later release, once no 1.6 writer remains): DROP TRIGGER + DROP FUNCTION.
CREATE FUNCTION "auth"."account_issuer_compat"() RETURNS trigger LANGUAGE plpgsql AS $$
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
BEFORE INSERT ON "auth"."account"
FOR EACH ROW EXECUTE FUNCTION "auth"."account_issuer_compat"();--> statement-breakpoint
ALTER TABLE "auth"."account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_account_issuer_account_id_uk" ON "auth"."account" ("issuer","account_id");
