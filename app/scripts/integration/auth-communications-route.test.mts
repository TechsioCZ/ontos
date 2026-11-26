import { randomUUID } from 'node:crypto';

import {
  CommercePortalAuthAccountCreationUnavailable,
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentTenantIdSchema,
  PASSWORD,
  makeProductionRouteRealm,
  verification,
} from '@app/commerce-customer-context/testing/portal-auth-communications';
import { eq } from 'drizzle-orm';
import { Effect, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

/**
 * #1406 D.1, D.9, R-D13: the COMMUNICATIONS-SELECTED composition of Portal Auth, as the production composition root builds it for a
 * deployment that opted in. Nothing of Auth's e-mail route is a test double here: the delivery behind the ledger registration,
 * the verification replay rule, Auth's protected handoff (sealed store, ledger probe over the recovery ledger), the trusted Tenant,
 * the stored-facts reader and the outcome reader are the layers `api/index.ts` selects (`commercePortalAuthCommunicationsRouteLive`),
 * over the real Better Auth realm and the real `commerce_auth` schema in native PostgreSQL.
 *
 * What it proves: an enrollment commits the account, the issuance (under its deterministic identity, so the callback and the
 * replay rule share ONE handoff) and its Communication Request into the Auth-local outbox, in the Auth transaction; and a replay
 * of the same operation sends and issues nothing, because the replay rule is required and the API process has no request-time
 * authority to read the Communications outcome (a typed unavailable, never a re-issued link).
 *
 * What it does NOT prove, by design: Communications deciding the request (the sibling suites), the worker host relaying it,
 * Privacy (its production scope is still undeclared, #1396 J: on the production composition the decision stops as an unresolved
 * Privacy context), a provider, or the production flip. Every address and text here is FICTIONAL.
 */

const decodeInvocation = Schema.decodeSync(EnrollmentActionInvocationIdSchema);
const decodeAttempt = Schema.decodeSync(EnrollmentAttemptIdSchema);
const decodeTenant = Schema.decodeSync(EnrollmentTenantIdSchema);

describe('Portal Auth on the Communications-selected composition (#1406, R-D13)', () => {
  it.live(
    'an enrollment commits its issuance with its request into the Auth-local outbox, and a replay sends and issues nothing',
    () =>
      Effect.gen(function* communicationsRoute() {
        const tenantId = randomUUID();
        const { gateway, outbox, realm } = yield* makeProductionRouteRealm(tenantId, 'route');
        const enrollment = {
          email: realm.email,
          enrollmentAttemptId: decodeAttempt(randomUUID()),
          name: 'Route composition fixture',
          ownerInvocationId: decodeInvocation(randomUUID()),
          password: Redacted.make(PASSWORD),
          tenantId: decodeTenant(randomUUID()),
        };
        const created = yield* gateway.create(enrollment);

        // the issuance and its request were committed together under the issuance identity the replay rule reserved
        const [row, ...others] = yield* outbox;
        expect(others).toHaveLength(0);
        expect(row?.state).toBe('PENDING');
        expect(row?.issuanceRef).toMatch(/^pae-[0-9a-f]{40}$/u);
        expect(row?.request).not.toContain(realm.email);
        const ledgerBefore = yield* realm.database.executor
          .select({ id: verification.id })
          .from(verification)
          .where(eq(verification.value, created.providerSubjectId));

        // a replay of the SAME operation: nothing is issued, nothing new is committed, and the Attempt stays retryable
        const failure = yield* Effect.flip(gateway.create(enrollment));
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(failure)).toBe(true);
        expect(failure.reason).toContain('could not establish the previous verification message');
        expect(yield* outbox).toHaveLength(1);
        const ledgerAfter = yield* realm.database.executor
          .select({ id: verification.id })
          .from(verification)
          .where(eq(verification.value, created.providerSubjectId));
        expect(ledgerAfter).toHaveLength(ledgerBefore.length);
      }).pipe(Effect.scoped),
  );
});
