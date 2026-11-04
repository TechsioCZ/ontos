CREATE SCHEMA scoped_migration_recovery_fixture;
--> statement-breakpoint
CREATE TABLE scoped_migration_recovery_fixture.proof (
  id integer PRIMARY KEY,
  effects integer NOT NULL
);
--> statement-breakpoint
INSERT INTO scoped_migration_recovery_fixture.proof (id, effects) VALUES (1, 1);
--> statement-breakpoint
ALTER TABLE scoped_migration_recovery_fixture.proof ADD COLUMN native_applied integer NOT NULL DEFAULT 1;
--> statement-breakpoint
DO $scoped_recovery_fixture$
BEGIN
  IF current_setting('ontos.scoped_recovery_failure', true) = 'on' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Owned recovery fixture rollback control';
  END IF;
END
$scoped_recovery_fixture$;
