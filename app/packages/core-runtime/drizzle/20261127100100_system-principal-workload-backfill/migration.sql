-- A system Principal an enrollment made before core.principals.system_workload_key existed records no workload, so
-- the enrollment's holder reader, which reads only a Principal recorded for the key, would no longer find it and the
-- next enrollment (the boot's release enrollment, an administrator's ENROLL) would make a second one. Record the key
-- for each unrecorded one that is unambiguously that workload's enrollment: a system Principal without a platform
-- role, not archived, named by the enrollment writer after the key ('System workload <key>') and holding an active
-- binding of that key, when it is the only such Principal of its Tenant and no Principal is recorded for the key yet.
-- The name decides, not the bindings: the Symmy executor also holds the owner workloads its routes need (Inventory's
-- 'commerce.inventory.source-provision' among them), so two enrolled Principals of one Tenant hold that key and each
-- is still recorded for the workload it was enrolled for. Anything else is left as it is. Running it again changes
-- nothing. The declared system workload keys are the composition's at this point.
WITH "declared" ("workload_key") AS (
  VALUES ('integration.symmy.execute-symmy-job'), ('commerce.inventory.source-provision'), ('core.media.integrity')
),
"enrolled" AS (
  SELECT p."tenant_id", p."principal_id", d."workload_key"
  FROM "core"."principals" AS p
  JOIN "declared" AS d ON p."display_name" = 'System workload ' || d."workload_key"
  WHERE p."kind" = 'system' AND p."platform_role" IS NULL AND p."status" <> 'archived'
    AND p."system_workload_key" IS NULL
    AND EXISTS (
      SELECT 1 FROM "core"."access_workload_bindings" AS b
      WHERE b."tenant_id" = p."tenant_id" AND b."principal_id" = p."principal_id"
        AND b."workload_key" = d."workload_key" AND b."status" = 'active'
    )
),
"candidate" AS (
  SELECT e."tenant_id", e."principal_id", e."workload_key"
  FROM "enrolled" AS e
  WHERE NOT EXISTS (
      SELECT 1 FROM "enrolled" AS rival
      WHERE rival."tenant_id" = e."tenant_id" AND rival."workload_key" = e."workload_key"
        AND rival."principal_id" <> e."principal_id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "core"."principals" AS recorded
      WHERE recorded."tenant_id" = e."tenant_id" AND recorded."system_workload_key" = e."workload_key"
        AND recorded."status" <> 'archived'
    )
)
UPDATE "core"."principals" AS p SET "system_workload_key" = c."workload_key"
FROM "candidate" AS c
WHERE p."tenant_id" = c."tenant_id" AND p."principal_id" = c."principal_id" AND p."system_workload_key" IS NULL;
