CREATE TABLE "core"."legal_entity_navigation_exclusions" (
	"tenant_id" uuid,
	"legal_entity_id" uuid,
	"entrypoint_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_legal_entity_navigation_exclusions_pk" PRIMARY KEY("tenant_id","legal_entity_id","entrypoint_key"),
	CONSTRAINT "core_legal_entity_navigation_exclusions_entrypoint_ck" CHECK ("entrypoint_key" ~ '^[a-z][a-z0-9]*([.-][a-z0-9]+)*$' and length("entrypoint_key") <= 200)
);
--> statement-breakpoint
ALTER TABLE "core"."legal_entity_navigation_exclusions" ADD CONSTRAINT "core_legal_entity_navigation_exclusions_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "core"."legal_entities"("tenant_id","legal_entity_id") ON DELETE CASCADE;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontos_runtime') THEN
    GRANT SELECT ON TABLE "core"."legal_entity_navigation_exclusions" TO ontos_runtime;
  END IF;
END $$;
