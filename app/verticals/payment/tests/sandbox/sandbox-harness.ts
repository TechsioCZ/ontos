import { randomBytes, randomUUID } from 'node:crypto';

import {
  Config,
  Console,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
} from 'effect';
import type { Redacted, Scope } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import type { TestContext } from 'effect-rstest';

import { PaymentOperationIdSchema } from '../../shared/domain/payment-identifiers.ts';
import type { GatewayMerchantIdentity } from '../../shared/domain/psp-configuration.ts';
import {
  ComgatePaymentService,
  ComgatePaymentServiceLive,
} from '../../src/integrations/comgate/comgate-payment.service.ts';
import { GopayOAuthTokenLive } from '../../src/integrations/gopay/gopay-oauth-token.ts';
import { GopayPaymentService, GopayPaymentServiceLive } from '../../src/integrations/gopay/gopay-payment.service.ts';
import { ProviderCredentialStore } from '../../src/integrations/psp/credentials.ts';
import type { ProviderCredentialMaterial } from '../../src/integrations/psp/credentials.ts';
import { RawProviderNotificationSchema } from '../../src/integrations/psp/notification-envelope.ts';
import type { RawProviderNotification } from '../../src/integrations/psp/notification-envelope.ts';
import { ProviderHttp } from '../../src/integrations/psp/provider-http.ts';
import type { ProviderHttpContract } from '../../src/integrations/psp/provider-http.ts';
import { ProviderHttpLive } from '../../src/integrations/psp/provider-http-live.ts';
import type { GatewayProviderAdapter } from '../../src/integrations/psp/psp-adapter.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import type { ProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayProviderOutcomeUnknown, GatewayProviderUnavailable } from '../../src/integrations/psp/psp-errors.ts';
import {
  GatewayCancelRequestSchema,
  GatewayCollectRequestSchema,
  GatewayExecutionTargetSchema,
  GatewayExpectedEffectSchema,
  GatewayRefundRequestSchema,
  ProviderObjectRefSchema,
} from '../../src/integrations/psp/psp-request.ts';
import type {
  GatewayCancelRequest,
  GatewayCollectRequest,
  GatewayExecutionTarget,
  GatewayExpectedEffect,
  GatewayLookupRequest,
  GatewayRefundRequest,
  ProviderObjectRef,
} from '../../src/integrations/psp/psp-request.ts';
import type { ProviderDispatchResponse, ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import {
  StripePaymentService,
  StripePaymentServiceLive,
} from '../../src/integrations/stripe/stripe-payment.service.ts';

/**
 * Opt-in provider sandbox conformance (#1159 evidence level 4, plan §6). Run from `app/` with
 * `pnpm --filter @app/payment exec rstest --project sandbox`.
 *
 * Every suite reads only its own `ONTOS_C17_SANDBOX_*` variables through `Config` (never `process.env`):
 * - GoPay: `ONTOS_C17_SANDBOX_GOPAY_CLIENT_ID`, `ONTOS_C17_SANDBOX_GOPAY_CLIENT_SECRET`,
 *   `ONTOS_C17_SANDBOX_GOPAY_GOID` (scope `payment-all`); optional public `ONTOS_C17_SANDBOX_GOPAY_NOTIFICATION_URL`.
 * - Stripe: `ONTOS_C17_SANDBOX_STRIPE_SECRET_KEY` (`sk_test_`/`rk_test_`), `ONTOS_C17_SANDBOX_STRIPE_WEBHOOK_SECRET`
 *   (`whsec_`), `ONTOS_C17_SANDBOX_STRIPE_ACCOUNT_ID` (`acct_`).
 * - Comgate: `ONTOS_C17_SANDBOX_COMGATE_MERCHANT_ID`, `ONTOS_C17_SANDBOX_COMGATE_SECRET` (a shop connection with
 *   test payments allowed and this runner's public IPv4 on its allowed-IP list).
 *
 * Without a provider's required variables every scenario of that provider prints
 * `NOT RUN (credentials absent: <names>)` and is skipped; it is never reported as passed. With them, the
 * scenarios talk to the real sandbox through the production adapters and the production
 * `ProviderHttpLive`, over a fetch client configured like the composition roots (`no-store`,
 * `redirect: 'manual'`, no client span, no retry layer).
 *
 * The hosted payment step needs a human: the scenario prints the redirect URL and polls lookup for up to
 * 15 minutes. Nothing here opens a browser or prints a secret.
 */

export const HOSTED_PAYMENT_WAIT = '15 minutes';
/** Rstest timeout of a scenario that waits for the hosted payment step (wait plus provider calls). */
export const HOSTED_SCENARIO_TIMEOUT_MS = 20 * 60 * 1000;
/** Polling of provider states that settle without a human (refunds, search indexing, events). */
export const SETTLE_POLL = { every: '5 seconds', within: '2 minutes' } as const;
export const HOSTED_POLL = { every: '10 seconds', within: HOSTED_PAYMENT_WAIT } as const;

// ---------------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------------

/** The credentials, or the names of the absent variables. A malformed value fails the scenario instead. */
type SandboxCredentials<C> = Result.Result<C, readonly string[]>;

const absentNames = (variables: readonly (readonly [string, Option.Option<unknown>])[]): readonly string[] =>
  variables.filter(([, value]) => Option.isNone(value)).map(([name]) => name);

const GOPAY_CLIENT_ID = 'ONTOS_C17_SANDBOX_GOPAY_CLIENT_ID';
const GOPAY_CLIENT_SECRET = 'ONTOS_C17_SANDBOX_GOPAY_CLIENT_SECRET';
const GOPAY_GOID = 'ONTOS_C17_SANDBOX_GOPAY_GOID';
const GOPAY_NOTIFICATION_URL = 'ONTOS_C17_SANDBOX_GOPAY_NOTIFICATION_URL';
const STRIPE_SECRET_KEY = 'ONTOS_C17_SANDBOX_STRIPE_SECRET_KEY';
const STRIPE_WEBHOOK_SECRET = 'ONTOS_C17_SANDBOX_STRIPE_WEBHOOK_SECRET';
const STRIPE_ACCOUNT_ID = 'ONTOS_C17_SANDBOX_STRIPE_ACCOUNT_ID';
const COMGATE_MERCHANT_ID = 'ONTOS_C17_SANDBOX_COMGATE_MERCHANT_ID';
const COMGATE_SECRET = 'ONTOS_C17_SANDBOX_COMGATE_SECRET';

export interface GopaySandboxCredentials {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
  readonly goid: string;
  readonly notificationUrl: Option.Option<string>;
}

export interface StripeSandboxCredentials {
  readonly accountId: string;
  readonly secretKey: Redacted.Redacted;
  readonly webhookSecret: Redacted.Redacted;
}

export interface ComgateSandboxCredentials {
  readonly merchantId: string;
  readonly secret: Redacted.Redacted;
}

export const gopaySandboxCredentials: Effect.Effect<
  SandboxCredentials<GopaySandboxCredentials>,
  Config.ConfigError
> = Effect.gen(function* readGopaySandboxCredentials() {
  const read = yield* Config.all({
    clientId: Config.option(Config.String(GOPAY_CLIENT_ID)),
    clientSecret: Config.option(Config.Redacted(GOPAY_CLIENT_SECRET)),
    goid: Config.option(Config.String(GOPAY_GOID)),
    notificationUrl: Config.option(Config.String(GOPAY_NOTIFICATION_URL)),
  });
  const { notificationUrl, ...requiredValues } = read;
  return Option.match(Option.all(requiredValues), {
    onNone: () =>
      Result.fail(
        absentNames([
          [GOPAY_CLIENT_ID, read.clientId],
          [GOPAY_CLIENT_SECRET, read.clientSecret],
          [GOPAY_GOID, read.goid],
        ]),
      ),
    onSome: (values) => Result.succeed({ ...values, notificationUrl }),
  });
});

export const stripeSandboxCredentials: Effect.Effect<
  SandboxCredentials<StripeSandboxCredentials>,
  Config.ConfigError
> = Effect.gen(function* readStripeSandboxCredentials() {
  const read = yield* Config.all({
    accountId: Config.option(Config.String(STRIPE_ACCOUNT_ID)),
    secretKey: Config.option(Config.Redacted(STRIPE_SECRET_KEY)),
    webhookSecret: Config.option(Config.Redacted(STRIPE_WEBHOOK_SECRET)),
  });
  return Option.match(Option.all(read), {
    onNone: () =>
      Result.fail(
        absentNames([
          [STRIPE_SECRET_KEY, read.secretKey],
          [STRIPE_WEBHOOK_SECRET, read.webhookSecret],
          [STRIPE_ACCOUNT_ID, read.accountId],
        ]),
      ),
    onSome: (values) => Result.succeed(values),
  });
});

export const comgateSandboxCredentials: Effect.Effect<
  SandboxCredentials<ComgateSandboxCredentials>,
  Config.ConfigError
> = Effect.gen(function* readComgateSandboxCredentials() {
  const read = yield* Config.all({
    merchantId: Config.option(Config.String(COMGATE_MERCHANT_ID)),
    secret: Config.option(Config.Redacted(COMGATE_SECRET)),
  });
  return Option.match(Option.all(read), {
    onNone: () =>
      Result.fail(
        absentNames([
          [COMGATE_MERCHANT_ID, read.merchantId],
          [COMGATE_SECRET, read.secret],
        ]),
      ),
    onSome: (values) => Result.succeed(values),
  });
});

/** Prints the reason, then skips the running test: rstest counts it as skipped, never as passed. */
export const notRun = (ctx: TestContext, reason: string): Effect.Effect<void> =>
  Console.log(reason).pipe(
    Effect.andThen(
      Effect.sync(() => {
        ctx.skip();
      }),
    ),
  );

// ---------------------------------------------------------------------------------------------------
// Live adapters over the production provider HTTP seam
// ---------------------------------------------------------------------------------------------------

const noStoreManualRedirectFetchLive = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
);

/** The client the composition roots build: no client span or trace headers, no redirect, no retry. */
const providerHttpClientLive = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* makeSandboxProviderHttpClient() {
    const client = yield* HttpClient.HttpClient;
    return client.pipe(
      HttpClient.transform((effect) => Effect.updateService(effect, HttpClient.TracerDisabledWhen, () => () => true)),
    );
  }),
).pipe(Layer.provide(noStoreManualRedirectFetchLive));

const SANDBOX_SECRET_REF = 'c17-sandbox';

/** Credential store holding exactly one entry, the sandbox material, under `c17-sandbox`. */
const sandboxCredentialStore = (material: ProviderCredentialMaterial) =>
  Layer.succeed(ProviderCredentialStore, {
    resolve: ({ family, secretRef }) =>
      secretRef === SANDBOX_SECRET_REF
        ? Effect.succeed(material)
        : Effect.fail(
            new GatewayProviderUnavailable({
              code: 'gateway_provider_unavailable',
              family,
              reason: 'credential_ref_unknown',
            }),
          ),
  });

/**
 * Lost-response simulation. The mutation really reaches the provider and completes; its answer is then
 * withheld and the adapter sees OUTCOME_UNKNOWN, as after a timeout once the request was written. The
 * withheld body is kept so a scenario can tell which provider object the lost call created.
 */
const withholdingProviderHttp = (
  live: ProviderHttpContract,
  withheld: Ref.Ref<readonly string[]>,
): ProviderHttpContract => ({
  mutate: (request) =>
    live.mutate(request).pipe(
      Effect.flatMap((response) => Ref.update(withheld, (bodies) => [...bodies, response.bodyText])),
      Effect.andThen(
        Effect.fail(
          new GatewayProviderOutcomeUnknown({
            code: 'gateway_provider_outcome_unknown',
            family: request.family,
            operationId: request.operationId,
            reason: 'sandbox_response_withheld',
          }),
        ),
      ),
    ),
  read: live.read,
});

export interface SandboxProvider {
  /** The production adapter over the live provider HTTP seam. */
  readonly adapter: GatewayProviderAdapter;
  /** The live seam itself, for fixture calls that are not adapter operations. */
  readonly http: ProviderHttpContract;
  /** The same adapter whose mutations reach the provider but whose answers are withheld. */
  readonly lossy: GatewayProviderAdapter;
  /** Answers withheld from `lossy`, in order. */
  readonly withheld: Ref.Ref<readonly string[]>;
}

const buildAdapter = (
  material: ProviderCredentialMaterial,
  http: ProviderHttpContract,
): Effect.Effect<GatewayProviderAdapter, never, Scope.Scope> => {
  const seam = Layer.mergeAll(Layer.succeed(ProviderHttp, http), sandboxCredentialStore(material));
  return Match.value(material).pipe(
    Match.tag('COMGATE', () =>
      Effect.map(Layer.build(ComgatePaymentServiceLive.pipe(Layer.provide(seam))), (context) =>
        Context.get(context, ComgatePaymentService),
      ),
    ),
    Match.tag('GOPAY', () =>
      Effect.map(
        Layer.build(GopayPaymentServiceLive.pipe(Layer.provide(GopayOAuthTokenLive), Layer.provide(seam))),
        (context) => Context.get(context, GopayPaymentService),
      ),
    ),
    Match.tag('STRIPE', () =>
      Effect.map(Layer.build(StripePaymentServiceLive.pipe(Layer.provide(seam))), (context) =>
        Context.get(context, StripePaymentService),
      ),
    ),
    Match.exhaustive,
  );
};

/** Builds the provider's production adapter twice over one live seam: plain and answer-withholding. */
const buildSandboxProvider = (
  material: ProviderCredentialMaterial,
): Effect.Effect<SandboxProvider, never, Scope.Scope> =>
  Effect.gen(function* buildSandboxProviderEffect() {
    const [seam, withheld] = yield* Effect.all(
      [Layer.build(ProviderHttpLive.pipe(Layer.provide(providerHttpClientLive))), Ref.make<readonly string[]>([])],
      { concurrency: 1 },
    );
    const http = Context.get(seam, ProviderHttp);
    const [adapter, lossy] = yield* Effect.all(
      [buildAdapter(material, http), buildAdapter(material, withholdingProviderHttp(http, withheld))],
      { concurrency: 1 },
    );
    return { adapter, http, lossy, withheld };
  });

export interface SandboxScenarioInput<C> {
  readonly credentials: C;
  readonly provider: SandboxProvider;
  readonly target: GatewayExecutionTarget;
}

/**
 * Runs `scenario` against the live provider, or reports it NOT RUN when the provider's credentials are
 * absent. The provider's layers are released when the scenario ends.
 */
export const sandboxScenario = <C, A, E>(
  ctx: TestContext,
  setup: {
    readonly credentials: Effect.Effect<SandboxCredentials<C>, Config.ConfigError>;
    readonly material: (credentials: C) => ProviderCredentialMaterial;
    readonly target: (credentials: C) => GatewayExecutionTarget;
  },
  scenario: (input: SandboxScenarioInput<C>) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<void, E | Config.ConfigError> =>
  setup.credentials.pipe(
    Effect.flatMap(
      Result.match({
        onFailure: (missing) => notRun(ctx, `NOT RUN (credentials absent: ${missing.join(', ')})`),
        onSuccess: (credentials) =>
          Effect.scoped(
            Effect.flatMap(buildSandboxProvider(setup.material(credentials)), (provider) =>
              Effect.asVoid(scenario({ credentials, provider, target: setup.target(credentials) })),
            ),
          ),
      }),
    ),
  );

// ---------------------------------------------------------------------------------------------------
// Targets and operations
// ---------------------------------------------------------------------------------------------------

/** Public placeholder URLs; the hosted page redirects to the return URL after payment. Nothing is served there. */
export const SANDBOX_RETURN_URL = 'https://example.com/ontos-c17-sandbox/return';
export const SANDBOX_NOTIFICATION_URL = 'https://example.com/ontos-c17-sandbox/notification';

type SandboxFamily = GatewayMerchantIdentity['_tag'];

const PROVIDER_ACCOUNT_REFS = {
  COMGATE: `pab_${'c0'.repeat(16)}`,
  GOPAY: `pab_${'60'.repeat(16)}`,
  STRIPE: `pab_${'57'.repeat(16)}`,
} as const;

/** An execution target for the sandbox binding; tenant, legal entity and binding ids are synthetic. */
export const sandboxTarget = (input: {
  readonly merchantIdentity: { readonly _tag: SandboxFamily } & Readonly<Record<string, string>>;
  readonly notificationUrl: string;
  readonly returnUrl: Option.Option<string>;
}): GatewayExecutionTarget =>
  Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
    binding: {
      _tag: 'GATEWAY_ACCOUNT',
      environment: 'SANDBOX',
      providerAccountRef: PROVIDER_ACCOUNT_REFS[input.merchantIdentity._tag],
      providerFamily: input.merchantIdentity._tag,
    },
    bindingId: 'c17c17c1-7000-4000-8000-000000000001',
    credentialRevision: 1,
    credentialSecretRef: SANDBOX_SECRET_REF,
    legalEntityId: 'c17c17c1-7000-4000-8000-000000000002',
    merchantIdentity: input.merchantIdentity,
    notificationUrl: input.notificationUrl,
    returnUrl: input.returnUrl,
    tenantId: 'c17c17c1-7000-4000-8000-000000000003',
  });

export interface SandboxOperation {
  readonly correlation: ProviderCorrelation;
  readonly operationId: typeof PaymentOperationIdSchema.Type;
  readonly paymentId: string;
}

/** A fresh Payment Operation per scenario, so reruns never collide with earlier provider objects. */
export const newOperation: Effect.Effect<SandboxOperation> = Effect.sync(() => {
  const operationId = Schema.decodeUnknownSync(PaymentOperationIdSchema)(randomUUID());
  return { correlation: deriveProviderCorrelation(operationId), operationId, paymentId: randomUUID() };
});

/** A fresh 22-character base64url return token. */
export const newReturnToken: Effect.Effect<string> = Effect.sync(() => randomBytes(16).toString('base64url'));

/** The real instant (the sandbox project runs on the live clock). */
export const sandboxNow: Effect.Effect<DateTime.Utc> = DateTime.now;

/** A relay-shaped raw notification addressed to the sandbox binding of `family`. */
export const rawNotification = (input: {
  readonly contentType: Option.Option<string>;
  readonly family: SandboxFamily;
  readonly paymentRef: Option.Option<string>;
  readonly rawBody: Uint8Array;
  readonly receivedAt: DateTime.Utc;
  readonly stripeSignature: Option.Option<string>;
  readonly transportDeliveryRef: string;
}): RawProviderNotification =>
  Schema.decodeUnknownSync(RawProviderNotificationSchema)({
    environment: 'SANDBOX',
    family: input.family,
    headers: { contentType: input.contentType, stripeSignature: input.stripeSignature },
    providerAccountRef: PROVIDER_ACCOUNT_REFS[input.family],
    query: { parentPaymentRef: Option.none(), paymentRef: input.paymentRef },
    rawBody: input.rawBody,
    receivedAt: input.receivedAt,
    transportDeliveryRef: input.transportDeliveryRef,
  });

// ---------------------------------------------------------------------------------------------------
// Requests and expectations
// ---------------------------------------------------------------------------------------------------

/** A CZK amount in minor units. */
export interface SandboxAmount {
  readonly amountMinor: number;
  readonly currency: 'CZK';
}

export const collectRequestOf = (input: {
  readonly amount: SandboxAmount;
  readonly issuedAt: DateTime.Utc;
  readonly operation: SandboxOperation;
  readonly payerContact: Option.Option<{
    readonly email: Option.Option<string>;
    readonly fullName: Option.Option<string>;
    readonly phone: Option.Option<string>;
  }>;
  readonly returnToken: string;
}): GatewayCollectRequest =>
  Schema.decodeUnknownSync(GatewayCollectRequestSchema)({
    amount: input.amount,
    correlation: input.operation.correlation,
    issuedAt: input.issuedAt,
    operationId: input.operation.operationId,
    payerContact: input.payerContact,
    paymentId: input.operation.paymentId,
    returnToken: input.returnToken,
  });

export const refundRequestOf = (input: {
  readonly amount: SandboxAmount;
  readonly collection: SandboxOperation;
  readonly providerTarget: ProviderObjectRef;
  readonly refund: SandboxOperation;
}): GatewayRefundRequest =>
  Schema.decodeUnknownSync(GatewayRefundRequestSchema)({
    amount: input.amount,
    correlation: input.refund.correlation,
    operationId: input.refund.operationId,
    providerTarget: input.providerTarget,
    refundBasisKind: 'REFUNDABLE_ITEMS',
    targetOperationId: input.collection.operationId,
  });

export const cancelRequestOf = (input: {
  readonly cancel: SandboxOperation;
  readonly collection: SandboxOperation;
  readonly providerTarget: ProviderObjectRef;
}): GatewayCancelRequest =>
  Schema.decodeUnknownSync(GatewayCancelRequestSchema)({
    operationId: input.cancel.operationId,
    providerTarget: input.providerTarget,
    targetOperationId: input.collection.operationId,
  });

const [CollectExpectedSchema, RefundExpectedSchema, CancelExpectedSchema] = GatewayExpectedEffectSchema.members;

export const collectExpected = (operation: SandboxOperation, amount: SandboxAmount): GatewayExpectedEffect =>
  Schema.decodeUnknownSync(CollectExpectedSchema)({ _tag: 'COLLECT', amount, operationId: operation.operationId });

export const refundExpected = (operation: SandboxOperation, amount: SandboxAmount): GatewayExpectedEffect =>
  Schema.decodeUnknownSync(RefundExpectedSchema)({ _tag: 'REFUND', amount, operationId: operation.operationId });

export const cancelExpected = (
  cancel: SandboxOperation,
  collection: SandboxOperation,
  amount: SandboxAmount,
): GatewayExpectedEffect =>
  Schema.decodeUnknownSync(CancelExpectedSchema)({
    _tag: 'CANCEL_OR_VOID',
    operationId: cancel.operationId,
    target: { amount, operationId: collection.operationId },
  });

/** A lookup of one provider object for `expected`, dispatched at `dispatchedAt`. */
export const objectLookup = (
  ref: ProviderObjectRef,
  expected: GatewayExpectedEffect,
  dispatchedAt: DateTime.Utc,
): GatewayLookupRequest => ({
  dispatchedAt: Option.some(dispatchedAt),
  expected,
  target: { _tag: 'PROVIDER_OBJECT', ref },
});

/** A lookup by the operation's order reference (Stripe PaymentIntent search; Unsupported elsewhere). */
export const orderReferenceLookup = (
  operation: SandboxOperation,
  expected: GatewayExpectedEffect,
  dispatchedAt: DateTime.Utc,
): GatewayLookupRequest => ({
  dispatchedAt: Option.some(dispatchedAt),
  expected,
  target: { _tag: 'ORDER_REFERENCE', orderReference: operation.correlation.orderReference },
});

// ---------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------

export const [
  GopayPaymentRefSchema,
  StripeCheckoutSessionRefSchema,
  StripePaymentIntentRefSchema,
  StripeRefundRefSchema,
  ComgateTransactionRefSchema,
] = ProviderObjectRefSchema.members;

/** The first provider object of the member schema's kind named by a finding. */
export const providerRefOf = <S extends Schema.Top>(
  finding: ProviderFindingResult,
  schema: S,
): Option.Option<S['Type']> => Option.fromUndefinedOr(finding.providerRefs.find(Schema.is(schema)));

/** `ACKNOWLEDGED` or `REJECTED_BEFORE_EFFECT`. */
export const dispatchOutcomeOf = (response: ProviderDispatchResponse): string =>
  Match.value(response).pipe(
    Match.tag('ACKNOWLEDGED', () => 'ACKNOWLEDGED'),
    Match.tag('REJECTED_BEFORE_EFFECT', () => 'REJECTED_BEFORE_EFFECT'),
    Match.exhaustive,
  );

/** The finding kind reported for `operationId`, or `none`. */
export const findingKindFor = (findings: readonly ProviderFindingResult[], operationId: string): string =>
  Option.fromUndefinedOr(findings.find((finding) => finding.target.operationId === operationId)).pipe(
    Option.match({ onNone: () => 'none', onSome: (finding) => finding.finding }),
  );

/**
 * Repeats `attempt` every `every` until `settled` holds or about `within` has passed, and returns the
 * last value. A failure of `attempt` ends the poll with that failure.
 */
export const pollUntil = <A, E, R>(
  attempt: Effect.Effect<A, E, R>,
  settled: (value: A) => boolean,
  options: { readonly every: Duration.Input; readonly within: Duration.Input },
): Effect.Effect<A, E, R> =>
  Effect.repeat(attempt, {
    schedule: Schedule.spaced(options.every),
    times: Math.ceil(
      Duration.toMillis(Duration.fromInputUnsafe(options.within)) /
        Duration.toMillis(Duration.fromInputUnsafe(options.every)),
    ),
    until: settled,
  });

/** The answer last withheld from `lossy`, decoded by the family's minimal id decoder. */
export const withheldObjectId = <A>(
  withheld: Ref.Ref<readonly string[]>,
  decode: (bodyText: string) => Option.Option<A>,
): Effect.Effect<Option.Option<A>> =>
  Effect.map(Ref.get(withheld), (bodies) => Option.flatMap(Option.fromUndefinedOr(bodies.at(-1)), decode));

export const announce = (lines: readonly string[]): Effect.Effect<void> => Console.log(lines.join('\n'));
