-- The route triggers became SECURITY DEFINER in 20261126101057_symmy-runtime-route-data so the runtime role can write
-- route rows. Every Symmy definer routine pins row_security, so these two do too.
ALTER FUNCTION symmy_integration.advance_route_change_token() SET row_security = on;
--> statement-breakpoint
ALTER FUNCTION symmy_integration.publish_route_execution_gate() SET row_security = on;
