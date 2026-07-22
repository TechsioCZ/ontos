ALTER TABLE "core"."action_invocations" ADD COLUMN "originating_principal_id" uuid;--> statement-breakpoint
UPDATE "core"."action_invocations" AS "action"
SET "originating_principal_id" = "action"."principal_id"
FROM "core"."principals" AS "principal"
WHERE "principal"."principal_id" = "action"."principal_id"
  AND "principal"."tenant_id" = "action"."tenant_id"
  AND "principal"."kind" = 'human';--> statement-breakpoint
ALTER TABLE "core"."action_invocations" ADD CONSTRAINT "action_invocations_originating_principal_id_principals_principal_id_fk" FOREIGN KEY ("originating_principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;
