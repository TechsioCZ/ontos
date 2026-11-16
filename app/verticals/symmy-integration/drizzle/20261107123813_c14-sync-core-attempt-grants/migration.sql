ALTER TABLE symmy_integration.sync_admission_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE symmy_integration.sync_admission_attempts FROM PUBLIC, ontos_runtime;
GRANT SELECT,INSERT ON TABLE symmy_integration.sync_admission_attempts TO ontos_runtime;
