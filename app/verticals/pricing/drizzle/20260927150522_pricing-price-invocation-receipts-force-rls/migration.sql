-- #755: invocation receipts are immutable owner evidence and must remain scoped even for the table owner.
ALTER TABLE "pricing"."price_invocation_receipts" FORCE ROW LEVEL SECURITY;
