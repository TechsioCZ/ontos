-- Storefront Registry routines are SECURITY DEFINER; ontos_runtime needs only schema USAGE to
-- resolve them. Raw table privileges stay revoked.
grant usage on schema storefront_registry to ontos_runtime;
