-- Synchronous admission receipts never create import_jobs or delivery records.
ALTER TABLE symmy_integration.sync_admissions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE symmy_integration.sync_admissions FROM PUBLIC,ontos_runtime;
GRANT SELECT,INSERT ON TABLE symmy_integration.sync_admissions TO ontos_runtime;
