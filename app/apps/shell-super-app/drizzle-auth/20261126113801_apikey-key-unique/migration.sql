-- A key value is registered once (an integration's existing value can be pasted into one key only). The index blocks
-- key writes while it is built, never verification reads; never wait long for the table.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- Two keys already holding one value are never resolved here: no row is deleted, the migration refuses instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "auth"."apikey" GROUP BY "key" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'auth.apikey holds the same API key value in more than one row; resolve those keys by hand before auth_apikey_key_uk is created'
      USING ERRCODE = '23505';
  END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_apikey_key_uk" ON "auth"."apikey" ("key");--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
