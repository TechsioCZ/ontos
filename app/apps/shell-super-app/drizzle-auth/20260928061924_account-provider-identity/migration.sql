-- Expand for Better Auth 1.7.3+, which keys accounts on (provider_id, account_id) and no longer
-- writes "issuer". The previous release still writes and reads "issuer", so it stays, nullable,
-- until a later contraction release drops it and its index. Each provider has one issuer, so
-- the new unique index holds for every existing row.
ALTER TABLE "auth"."account" ALTER COLUMN "issuer" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_account_provider_id_account_id_uk" ON "auth"."account" ("provider_id","account_id");