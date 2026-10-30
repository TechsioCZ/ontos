-- Drizzle exposes enabled RLS but has no typed FORCE RLS declaration.
ALTER TABLE "projects"."projects" FORCE ROW LEVEL SECURITY;
