import { Effect, Exit, Match, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';
import {
  AKROS_CUSTOMER_TARGET,
  AkrosCustomerEnrollmentInput,
  proveAkrosCustomerLink,
  startAkrosCustomerEnrollment,
} from '../demo/prepare-akros-customer.mts';
import type { AkrosCustomerLinkEvidence } from '../demo/prepare-akros-customer.mts';

const privateInput = 'operator-input-that-must-not-be-printed';

const enrollmentInput = Schema.decodeUnknownSync(AkrosCustomerEnrollmentInput)({
  ...AKROS_CUSTOMER_TARGET,
  approvedMailboxRecipient: 'akros-customer-demo-20261103@example.org',
  email: 'akros-customer-demo-20261103@example.org',
  password: Redacted.make(privateInput),
  requestId: '68e78e42-31b8-4dfe-b16e-b872c40eb71a',
});

it.effect('uses only one public AKROS registration request and returns no credentials or completion claim', () =>
  Effect.gen(function* publicEnrollment() {
    const calls: string[] = [];
    const http = HttpClient.make((request, url) => {
      calls.push(url.toString());
      expect(request.method).toBe('POST');
      expect(request.headers.origin).toBe(AKROS_CUSTOMER_TARGET.storefrontOrigin);
      expect(request.headers['content-type']).toBe('application/json');
      const checkedBody = Match.value(request.body).pipe(
        Match.tag('Uint8Array', (body) => {
          const payload: unknown = JSON.parse(new TextDecoder().decode(body.body));
          expect(payload).toEqual({
            email: enrollmentInput.email,
            firstName: 'Ukázkový',
            lastName: 'Zákazník AKROS',
            operation: 'register',
            password: privateInput,
            passwordConfirmation: privateInput,
            requestId: enrollmentInput.requestId,
            termsAccepted: true,
          });
          return true;
        }),
        Match.orElse(() => false),
      );
      expect(checkedBody).toBe(true);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ outcome: 'ENROLLMENT_STARTED' })));
    });
    const result = yield* startAkrosCustomerEnrollment(enrollmentInput).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    expect(calls).toEqual([`${AKROS_CUSTOMER_TARGET.storefrontOrigin}/api/ontos/account`]);
    expect(result).toEqual({ outcome: 'ENROLLMENT_STARTED', requestId: enrollmentInput.requestId });
    expect(JSON.stringify(result)).not.toContain(privateInput);
  }),
);

it.effect('rejects the demo tenant, another company and another origin before sending any request', () =>
  Effect.gen(function* scopeBoundaries() {
    for (const wrongScope of [
      { ...enrollmentInput, tenantId: '00000000-0000-0000-0000-000000000020' },
      { ...enrollmentInput, legalEntityId: '00000000-0000-0000-0000-000000000024' },
      { ...enrollmentInput, storefrontOrigin: 'https://ontos-stage-shop.web-revolution.cz' },
    ]) {
      const result = yield* Schema.decodeUnknownEffect(AkrosCustomerEnrollmentInput)(wrongScope).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }
  }),
);

it.effect('refuses unreceivable synthetic mailboxes before any request', () =>
  Effect.gen(function* unreceivableRecipient() {
    let calls = 0;
    const http = HttpClient.make((request) => {
      calls += 1;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ outcome: 'UNEXPECTED_TRANSPORT' })));
    });
    const email = 'akros-customer-demo-20261103@ontos.demo';
    const error = yield* startAkrosCustomerEnrollment({
      ...enrollmentInput,
      approvedMailboxRecipient: email,
      email,
    }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip);
    expect(calls).toBe(0);
    expect(error.step).toBe('akros_customer_deliverable_mailbox_required');
  }),
);

it.effect('preserves a 503 response without retrying or claiming that no account exists', () =>
  Effect.gen(function* uncertainEnrollment() {
    let calls = 0;
    const http = HttpClient.make((request) => {
      calls += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ message: privateInput }, { status: 503 })),
      );
    });
    const error = yield* startAkrosCustomerEnrollment(enrollmentInput).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
    );
    expect(calls).toBe(1);
    expect(error.httpStatus).toBe(503);
    expect(JSON.stringify(error)).not.toContain(privateInput);
  }),
);

it.effect('refuses a recipient not explicitly approved before any transport call', () =>
  startAkrosCustomerEnrollment({ ...enrollmentInput, approvedMailboxRecipient: 'other@example.invalid' }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ outcome: 'UNEXPECTED_TRANSPORT' }))),
      ),
    ),
    Effect.flip,
    Effect.map((error) => expect(error.step).toBe('akros_customer_approved_mailbox_required')),
  ),
);

it.effect('does not retry a refused registration or disclose its provider response', () =>
  Effect.gen(function* refusedEnrollment() {
    let calls = 0;
    const http = HttpClient.make((request) => {
      calls += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ secret: privateInput }, { status: 403 })),
      );
    });
    const error = yield* startAkrosCustomerEnrollment(enrollmentInput).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
    );
    expect(calls).toBe(1);
    expect(error.step).toBe('akros_customer_enrollment_refused');
    expect(error.httpStatus).toBe(403);
    expect(JSON.stringify(error)).not.toContain(privateInput);
  }),
);

const linkEvidence = (): AkrosCustomerLinkEvidence => {
  const { tenantId } = AKROS_CUSTOMER_TARGET;
  const partyId = '82dc9c82-f022-4862-b84a-e04f066bbbe9';
  const counterpartyId = '6844cce9-b4c5-4108-b66e-f197ae2f6937';
  const partyRef = { resourceId: partyId, tenantId };
  const counterpartyRef = { resourceId: counterpartyId, tenantId };
  return {
    account: { id: 'native-provider-subject', partyId, tenantId },
    counterparty: {
      counterpartyRef,
      currentRoles: [{ roleType: 'CUSTOMER', state: 'ACTIVE' }],
      legalEntityRef: { resourceId: AKROS_CUSTOMER_TARGET.legalEntityId, tenantId },
      party: { canonicalPartyRef: partyRef },
    },
    customer: { counterpartyId, counterpartyRef, partyId, partyRef },
  };
};

it.effect('proves a customer only by matching actual account, Party and legal-entity owner references', () =>
  Effect.gen(function* nativeLink() {
    const evidence = linkEvidence();
    const result = yield* proveAkrosCustomerLink(evidence);
    expect(result).toEqual({
      accountId: evidence.account.id,
      customerId: evidence.customer.counterpartyId,
      legalEntityId: AKROS_CUSTOMER_TARGET.legalEntityId,
      partyId: evidence.account.partyId,
      tenantId: AKROS_CUSTOMER_TARGET.tenantId,
    });
  }),
);

it.effect('refuses unrelated account or Party identities even when labels could match', () =>
  Effect.gen(function* mismatchedParties() {
    const evidence = linkEvidence();
    const error = yield* proveAkrosCustomerLink({
      ...evidence,
      account: { ...evidence.account, partyId: 'different-party' },
    }).pipe(Effect.flip);
    expect(error.step).toBe('akros_customer_native_link_unproved');
  }),
);

it.effect('refuses a matching Party in the wrong company or without a current CUSTOMER role', () =>
  Effect.gen(function* wrongCompanyOrRole() {
    const evidence = linkEvidence();
    for (const counterparty of [
      {
        ...evidence.counterparty,
        legalEntityRef: { ...evidence.counterparty.legalEntityRef, resourceId: 'other-company' },
      },
      { ...evidence.counterparty, currentRoles: [{ roleType: 'CUSTOMER', state: 'ENDED' }] },
      { ...evidence.counterparty, currentRoles: [{ roleType: 'SUPPLIER', state: 'ACTIVE' }] },
    ]) {
      const error = yield* proveAkrosCustomerLink({ ...evidence, counterparty }).pipe(Effect.flip);
      expect(error.step).toBe('akros_customer_native_link_unproved');
    }
  }),
);
