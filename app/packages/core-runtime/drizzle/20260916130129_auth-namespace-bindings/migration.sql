-- Namespace expansion is fail-closed for every populated installation. An
-- operator must stage a reviewed, exact identity inventory before backfill.
-- The staging relation is migration-only and is removed after a successful
-- backfill; it is deliberately absent from src/db/schema.ts and the Core
-- runtime catalog.
LOCK TABLE "core"."principals" IN SHARE MODE;--> statement-breakpoint
LOCK TABLE "core"."principal_auth_bindings" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."principal_auth_binding_namespace_inventory" (
	"principal_auth_binding_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject_type" text NOT NULL,
	"provider_subject_id" text NOT NULL,
	"authentication_namespace_id" text NOT NULL,
	"evidence_ref" text NOT NULL,
	CONSTRAINT "core_auth_binding_namespace_inventory_provider_ck"
		CHECK (length("provider") between 1 and 500),
	CONSTRAINT "core_auth_binding_namespace_inventory_subject_type_ck"
		CHECK ("subject_type" in ('user', 'api_key')),
	CONSTRAINT "core_auth_binding_namespace_inventory_namespace_ck"
		CHECK (length(btrim("authentication_namespace_id")) between 1 and 200 AND "authentication_namespace_id" = btrim("authentication_namespace_id")),
	CONSTRAINT "core_auth_binding_namespace_inventory_subject_id_ck"
		CHECK (length("provider_subject_id") between 1 and 500),
	CONSTRAINT "core_auth_binding_namespace_inventory_evidence_ck"
		CHECK (length(btrim("evidence_ref")) between 1 and 500 AND "evidence_ref" = btrim("evidence_ref"))
);--> statement-breakpoint
DO $$
DECLARE
	binding_count bigint;
	inventory_count bigint;
BEGIN
	SELECT count(*) INTO binding_count
	FROM "core"."principal_auth_bindings";
	SELECT count(*) INTO inventory_count
	FROM "core"."principal_auth_binding_namespace_inventory";

	-- Empty proof is valid only when no legacy bindings exist. Every populated
	-- database must provide one reviewed row for every existing binding.
	IF binding_count <> inventory_count THEN
		RAISE EXCEPTION 'Reviewed namespace inventory is required for every existing Core auth binding (bindings=%, inventory=%)', binding_count, inventory_count;
	END IF;

	-- Revalidate rows even when a previous failed attempt left the staging
	-- relation in place. IF NOT EXISTS does not validate an existing relation.
	IF EXISTS (
		SELECT 1
		FROM "core"."principal_auth_binding_namespace_inventory"
		WHERE "provider" IS NULL
			OR length("provider") NOT BETWEEN 1 AND 500
			OR "subject_type" IS NULL
			OR "subject_type" NOT IN ('user', 'api_key')
			OR "authentication_namespace_id" IS NULL
			OR length(btrim("authentication_namespace_id")) NOT BETWEEN 1 AND 200
			OR "authentication_namespace_id" <> btrim("authentication_namespace_id")
			OR "provider_subject_id" IS NULL
			OR length("provider_subject_id") NOT BETWEEN 1 AND 500
			OR "evidence_ref" IS NULL
			OR length(btrim("evidence_ref")) NOT BETWEEN 1 AND 500
			OR "evidence_ref" <> btrim("evidence_ref")
	) THEN
		RAISE EXCEPTION 'Reviewed namespace inventory contains an unsupported value or malformed evidence reference';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "core"."principal_auth_binding_namespace_inventory"
		GROUP BY "principal_auth_binding_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Reviewed namespace inventory contains duplicate binding identities';
	END IF;

	-- Match every proof row to the complete legacy identity tuple. A namespace
	-- cannot be assigned to another binding by submitting a different ID.
	IF EXISTS (
		SELECT 1
		FROM "core"."principal_auth_bindings" AS binding
		FULL OUTER JOIN "core"."principal_auth_binding_namespace_inventory" AS inventory
			ON inventory."principal_auth_binding_id" = binding."principal_auth_binding_id"
		WHERE binding."principal_auth_binding_id" IS NULL
			OR inventory."principal_auth_binding_id" IS NULL
			OR binding."tenant_id" IS DISTINCT FROM inventory."tenant_id"
			OR binding."principal_id" IS DISTINCT FROM inventory."principal_id"
			OR binding."provider" IS DISTINCT FROM inventory."provider"
			OR binding."subject_type" IS DISTINCT FROM inventory."subject_type"
			OR binding."provider_subject_id" IS DISTINCT FROM inventory."provider_subject_id"
	) THEN
		RAISE EXCEPTION 'Reviewed namespace inventory does not exactly match the existing Core auth bindings';
	END IF;

	-- K is unique across all binding states. Provider is selected by trusted
	-- namespace registration and is intentionally not part of the canonical key.
	IF EXISTS (
		SELECT 1
		FROM "core"."principal_auth_binding_namespace_inventory"
		GROUP BY "tenant_id", "authentication_namespace_id", "subject_type", "provider_subject_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Reviewed namespace inventory violates all-state namespace subject uniqueness';
	END IF;

	-- Preserve the existing provider-wide API-key cardinality.
	IF EXISTS (
		SELECT 1
		FROM "core"."principal_auth_binding_namespace_inventory"
		WHERE "subject_type" = 'api_key'
		GROUP BY "provider", "subject_type", "provider_subject_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Reviewed namespace inventory violates global API-key subject cardinality';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "core"."principal_auth_bindings"
		WHERE length("provider_subject_id") NOT BETWEEN 1 AND 500
	) THEN
		RAISE EXCEPTION 'Existing Core auth bindings contain a provider subject outside the supported 1..500 character range';
	END IF;
END $$;--> statement-breakpoint
-- Expand before tightening. A failed proof therefore never invents a
-- namespace or provenance for an existing row.
ALTER TABLE "core"."principal_auth_bindings" ADD COLUMN "authentication_namespace_id" text;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD COLUMN "binding_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD COLUMN "created_by_invocation_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD COLUMN "last_transition_ref" uuid;--> statement-breakpoint
UPDATE "core"."principal_auth_bindings" AS binding
SET "authentication_namespace_id" = inventory."authentication_namespace_id"
FROM "core"."principal_auth_binding_namespace_inventory" AS inventory
WHERE binding."principal_auth_binding_id" = inventory."principal_auth_binding_id";--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "core"."principal_auth_bindings"
		WHERE "authentication_namespace_id" IS NULL
	) THEN
		RAISE EXCEPTION 'Reviewed namespace backfill left one or more Core auth bindings without a namespace';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" DROP CONSTRAINT "core_auth_bindings_provider_ck";--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_provider_ck" CHECK (length("provider") between 1 and 500);--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_namespace_ck" CHECK (length(btrim("authentication_namespace_id")) between 1 and 200 AND "authentication_namespace_id" = btrim("authentication_namespace_id"));--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_subject_id_ck" CHECK (length("provider_subject_id") between 1 and 500);--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_revision_ck" CHECK ("binding_revision" >= 1);--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ALTER COLUMN "authentication_namespace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" DROP CONSTRAINT "core_auth_bindings_status_ck";--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_status_ck" CHECK ("status" in ('pending', 'active', 'revoked', 'disabled'));--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" DROP CONSTRAINT "core_auth_bindings_lifecycle_ck";--> statement-breakpoint
ALTER TABLE "core"."principal_auth_bindings" ADD CONSTRAINT "core_auth_bindings_lifecycle_ck" CHECK (("status" = 'revoked' and "revoked_at" is not null) or ("status" in ('pending', 'active', 'disabled') and "revoked_at" is null));--> statement-breakpoint
CREATE UNIQUE INDEX "core_auth_bindings_namespace_subject_uk" ON "core"."principal_auth_bindings" ("tenant_id", "authentication_namespace_id", "subject_type", "provider_subject_id");--> statement-breakpoint
DROP INDEX IF EXISTS "core"."core_auth_bindings_subject_uk";--> statement-breakpoint
DROP TABLE "core"."principal_auth_binding_namespace_inventory";
