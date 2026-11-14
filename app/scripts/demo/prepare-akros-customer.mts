#!/usr/bin/env node
import path from 'node:path';

import { executeCustomerListWithAuthorization } from '@app/party-registry/api/client';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { connectSeedClient } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';

export class AkrosCustomerPreparationError extends Schema.TaggedError<AkrosCustomerPreparationError>()(
  'AkrosCustomerPreparationError',
  { httpStatus: Schema.optionalKey(Schema.Int), step: Schema.String },
) {}
const failed = (step: string) => new AkrosCustomerPreparationError({ step });
const RegistrationResult = Schema.Struct({ outcome: Schema.Literal('ENROLLMENT_STARTED') });

/** Fixed real AKROS scope. No demo-company or other storefront account can satisfy this operator. */
export const AKROS_CUSTOMER_TARGET = {
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  storefrontOrigin: 'https://ontos-stage-akros.web-revolution.cz',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
} as const;

export const AkrosCustomerEnrollmentInput = Schema.Struct({
  approvedMailboxRecipient: Schema.String,
  email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/u)),
  legalEntityId: Schema.Literal(AKROS_CUSTOMER_TARGET.legalEntityId),
  password: Schema.Redacted(Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(128))),
  requestId: Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand('AkrosCustomerRequestId')),
  storefrontOrigin: Schema.Literal(AKROS_CUSTOMER_TARGET.storefrontOrigin),
  tenantId: Schema.Literal(AKROS_CUSTOMER_TARGET.tenantId),
});
type PreparedAkrosCustomerInput = typeof AkrosCustomerEnrollmentInput.Type;
const partyRegistryAudience = 'party-registry';

/** One explicitly admitted request. A refused or uncertain write is never retried here. */
export const startAkrosCustomerEnrollment = Effect.fn('StageDemo.startAkrosCustomerEnrollment')(
  function* startAkrosCustomerEnrollment(input: PreparedAkrosCustomerInput) {
    const prepared = yield* Schema.decodeUnknownEffect(AkrosCustomerEnrollmentInput)(input).pipe(
      Effect.mapError(() => failed('akros_customer_input_invalid')),
    );
    if (prepared.approvedMailboxRecipient !== prepared.email) {
      return yield* failed('akros_customer_approved_mailbox_required');
    }
    if (/\.(?:demo|test|invalid|example|playground)$/u.test(prepared.email)) {
      return yield* failed('akros_customer_deliverable_mailbox_required');
    }
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${prepared.storefrontOrigin}/api/ontos/account`).pipe(
          HttpClientRequest.setHeaders({ origin: prepared.storefrontOrigin }),
          HttpClientRequest.bodyJsonUnsafe({
            email: prepared.email,
            firstName: 'Ukázkový',
            lastName: 'Zákazník AKROS',
            operation: 'register',
            password: Redacted.value(prepared.password),
            passwordConfirmation: Redacted.value(prepared.password),
            requestId: prepared.requestId,
            termsAccepted: true,
          }),
        ),
      )
      .pipe(Effect.mapError(() => failed('akros_customer_enrollment_transport_unconfirmed')));
    if (response.status < 200 || response.status >= 300) {
      return yield* new AkrosCustomerPreparationError({
        httpStatus: response.status,
        step: 'akros_customer_enrollment_refused',
      });
    }
    yield* HttpClientResponse.schemaBodyJson(RegistrationResult)(response).pipe(
      Effect.mapError(() => failed('akros_customer_enrollment_response_unconfirmed')),
    );
    // An acknowledgement is not proof of verification, a completed enrollment, or a customer binding.
    return { outcome: 'ENROLLMENT_STARTED', requestId: prepared.requestId } as const;
  },
);

export interface AkrosCustomerLinkEvidence {
  readonly account: { readonly id: string; readonly partyId: string; readonly tenantId: string };
  readonly counterparty: {
    readonly counterpartyRef: { readonly resourceId: string; readonly tenantId: string };
    readonly currentRoles: readonly { readonly roleType: string; readonly state: string }[];
    readonly legalEntityRef: { readonly resourceId: string; readonly tenantId: string };
    readonly party: { readonly canonicalPartyRef: { readonly resourceId: string; readonly tenantId: string } };
  };
  readonly customer: {
    readonly counterpartyId: string;
    readonly counterpartyRef: { readonly resourceId: string; readonly tenantId: string };
    readonly partyId: string;
    readonly partyRef: { readonly resourceId: string; readonly tenantId: string };
  };
}

/** Compare owner-returned identities, never display names, email equality, or guessed UUIDs. */
export const proveAkrosCustomerLink = (evidence: AkrosCustomerLinkEvidence) =>
  Effect.gen(function* proveCustomerLink() {
    const { account, counterparty, customer } = evidence;
    const target = AKROS_CUSTOMER_TARGET;
    const parties = [customer.partyId, customer.partyRef.resourceId, counterparty.party.canonicalPartyRef.resourceId];
    const counterparties = [customer.counterpartyRef.resourceId, counterparty.counterpartyRef.resourceId];
    const tenants = [
      account.tenantId,
      customer.partyRef.tenantId,
      customer.counterpartyRef.tenantId,
      counterparty.counterpartyRef.tenantId,
      counterparty.party.canonicalPartyRef.tenantId,
      counterparty.legalEntityRef.tenantId,
    ];
    if (
      !account.id ||
      !account.partyId ||
      !customer.counterpartyId ||
      parties.some((id) => id !== account.partyId) ||
      counterparties.some((id) => id !== customer.counterpartyId) ||
      tenants.some((id) => id !== target.tenantId) ||
      counterparty.legalEntityRef.resourceId !== target.legalEntityId ||
      !counterparty.currentRoles.some(({ roleType, state }) => roleType === 'CUSTOMER' && state === 'ACTIVE')
    ) {
      return yield* failed('akros_customer_native_link_unproved');
    }
    return {
      accountId: account.id,
      customerId: customer.counterpartyId,
      legalEntityId: target.legalEntityId,
      partyId: account.partyId,
      tenantId: target.tenantId,
    };
  });

/** Existing reviewed real-AKROS operator only. Its independent HTTP session never touches Edge cookies. */
const withAkrosCustomerOperator = <A, E, R>(use: (client: SeedClient) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* useRealAkrosOperator() {
    const password = yield* Config.Redacted('ONTOS_AKROS_PLAYGROUND_PASSWORD').pipe(
      Config.withDefault(Redacted.make('password1234')),
    );
    return yield* Effect.acquireUseRelease(
      connectSeedClient(
        { ...AKROS_CUSTOMER_TARGET, shellUrl: 'https://ontos-stage.web-revolution.cz' },
        'admin@akros.playground',
        password,
      ),
      use,
      (client) => client.signOut,
    );
  });

const inspectAkrosCustomerDirectory = withAkrosCustomerOperator((client) =>
  Effect.gen(function* inspectDirectory() {
    const authorization = yield* client.authorize(partyRegistryAudience);
    const customers = yield* executeCustomerListWithAuthorization(
      { limit: 500 },
      Redacted.value(authorization.credential),
      'akros-customer-preparation-read-20261103',
      authorization.options,
    );
    return {
      customerCount: customers.items.length,
      legalEntityId: AKROS_CUSTOMER_TARGET.legalEntityId,
      tenantId: AKROS_CUSTOMER_TARGET.tenantId,
    };
  }),
);

/** The password is an owner-created 0600 file inside a 0700 directory, never an argument or JSON input. */
const readAkrosCustomerPassword = (passwordPath: string) =>
  Effect.gen(function* readPrivatePassword() {
    const fs = yield* FileSystem.FileSystem;
    const [file, directory] = yield* Effect.all([fs.stat(passwordPath), fs.stat(path.dirname(passwordPath))]);
    if (file.type !== 'File' || file.mode % 0o1000 !== 0o600 || directory.mode % 0o1000 !== 0o700) {
      return yield* failed('akros_customer_password_permissions_required');
    }
    return Redacted.make((yield* fs.readFileString(passwordPath)).trim());
  });

const command = Command.make(
  'prepare-akros-customer',
  {
    coordinatorGo: Flag.String('coordinator-go').pipe(Flag.optional),
    mailbox: Flag.String('mailbox').pipe(Flag.optional),
    mode: Flag.Literals('mode', ['inspect', 'enroll']),
    passwordFile: Flag.String('password-file').pipe(Flag.optional),
    requestId: Flag.String('request-id').pipe(Flag.optional),
  },
  ({ coordinatorGo, mailbox, mode, passwordFile, requestId }) =>
    Effect.gen(function* runPublicOperator() {
      if ((yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')) !== 'stage') {
        return yield* failed('stage_environment_required');
      }
      if (mode === 'inspect') {
        return yield* Console.log(yield* inspectAkrosCustomerDirectory);
      }
      if (
        Option.isNone(mailbox) ||
        Option.isNone(passwordFile) ||
        Option.isNone(requestId) ||
        Option.isNone(coordinatorGo) ||
        coordinatorGo.value !== requestId.value
      ) {
        return yield* failed('akros_customer_mailbox_private_password_and_exact_go_required');
      }
      const password = yield* readAkrosCustomerPassword(passwordFile.value);
      const input = yield* Schema.decodeUnknownEffect(AkrosCustomerEnrollmentInput)({
        ...AKROS_CUSTOMER_TARGET,
        approvedMailboxRecipient: mailbox.value,
        email: mailbox.value,
        password,
        requestId: requestId.value,
      }).pipe(Effect.mapError(() => failed('akros_customer_input_invalid')));
      const result = yield* startAkrosCustomerEnrollment(input);
      return yield* Console.log(result);
    }),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.scoped,
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeServices.layer),
      Effect.mapError((cause) =>
        Schema.is(AkrosCustomerPreparationError)(cause) ? cause : failed('akros_customer_operator_unavailable'),
      ),
      Effect.tapError((cause) =>
        Console.error({
          httpStatus: cause.httpStatus ?? null,
          message: 'AKROS customer preparation stopped. Secrets withheld.',
          step: cause.step,
        }),
      ),
    ),
    { disableErrorReporting: true },
  );
}
