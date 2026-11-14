-- Keep the owner subject to the same tenant and legal-entity policies as the runtime.
ALTER TABLE "demo_crm"."crm_states" FORCE ROW LEVEL SECURITY;
