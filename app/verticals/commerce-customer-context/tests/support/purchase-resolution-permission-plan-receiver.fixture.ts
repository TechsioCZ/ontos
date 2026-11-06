import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { defineRead } from '@app/core-runtime';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import {
  getReadHandler,
  getReadPermissionTargetResolver,
  getReadServiceFactory,
} from '@app/core-runtime/testing/reads';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { ActionPrincipalVerifierLive, authenticateOperationPrincipal } from '../../api/auth/action-principal.ts';
import apiRuntime, { configuredGatewayAssertionRedemptionLive, productionReadRuntimeLive } from '../../api/index.ts';
import { CommerceAuthenticationNamespaceRegistryLive } from '../../api/portal-auth/authentication-namespace-registry.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import {
  InvoiceRecipientResolutionApi,
  InvoiceRecipientResolutionAuthenticationProblemSchema,
  InvoiceRecipientResolutionForbiddenProblemSchema,
  InvoiceRecipientResolutionInternalProblemSchema,
  InvoiceRecipientResolutionInvalidProblemSchema,
  InvoiceRecipientResolutionNotFoundProblemSchema,
  InvoiceRecipientResolutionPolicyConflictProblemSchema,
  InvoiceRecipientResolutionPolicyProblemSchema,
  InvoiceRecipientResolutionUnavailableProblemSchema,
} from '../../shared/apis/invoice-recipient-resolution.ts';
import type {
  InvoiceRecipientCurrentFacts,
  ResolutionDecisionEvidence,
} from '../../shared/domain/address-resolution.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { invoiceRecipientResolutionRead } from '../../src/api/invoice-recipient-resolution.read.ts';

class PurchaseReceiverFixtureError extends Schema.TaggedError<PurchaseReceiverFixtureError>()(
  'PurchaseReceiverFixtureError',
  { reason: Schema.String },
) {}

const InvoiceOwnerFixtureScopeSchema = Schema.Struct({
  legalEntityId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('InvoiceFixtureLegalEntityId')),
  principalId: PrincipalIdSchema,
  profileId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('InvoiceFixtureProfileId')),
  tenantId: TenantIdSchema,
});

const fixtureCurrentFacts = ({
  legalEntityId,
  principalId,
  profileId,
  tenantId,
}: typeof InvoiceOwnerFixtureScopeSchema.Type): InvoiceRecipientCurrentFacts => ({
  identity: {
    displayName: 'Fixture Buyer',
    kind: 'RETAIL_PARTY',
    legalName: 'Fixture Buyer',
    officialIdentifiers: [
      {
        identifierType: 'CZ_DIC',
        normalizedValue: 'CZ12345678',
        officialIdentifierRef: {
          moduleId: 'party.registry',
          resourceId: 'fixture-party-identifier',
          resourceType: 'party.registry.party-official-identifier',
          tenantId,
        },
        source: 'PARTY_REGISTRY',
        sourceRevision: 3,
      },
      {
        evidenceRef: 'fixture-purchase-evidence',
        identifierType: 'CZ_DIC',
        normalizedValue: 'CZ87654321',
        source: 'PURCHASE_EVIDENCE',
        sourceRevision: 4,
      },
    ],
    partyRef: {
      moduleId: 'party.registry',
      resourceId: 'fixture-party',
      resourceType: 'party.registry.party',
      tenantId,
    },
    sourceRevision: 3,
  },
  purchasingContext: {
    actor: { kind: 'PRINCIPAL', principalId },
    cartId: 'native-cart',
    channelId: 'web',
    decidedAt: '2026-11-05T10:00:00.000Z',
    marketId: 'cz',
    proposalRevision: 1,
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    storefrontId: 'native-storefront',
    tenantId,
  },
  sourceRevisions: [{ revision: '1', source: 'cart' }],
  subject: {
    kind: 'PROFILE',
    profile: {
      kind: 'RETAIL',
      profileRef: {
        moduleId: 'commerce.customer-context',
        resourceId: profileId,
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId,
      },
    },
  },
});

const fixtureDecision = (owner: ResolutionDecisionEvidence['owner']): ResolutionDecisionEvidence => ({
  decidedAt: '2026-11-05T10:00:00.000Z',
  decisionRef: `fixture-${owner.toLowerCase()}-decision`,
  owner,
  revision: '1',
});

/** Replace only uninstalled foreign Current and validation authorities. The Commerce handler,
 * owner-local service factory, conditional permission plan, and public request/response contracts stay real. */
const invoiceFixtureRuntime = (scope: typeof InvoiceOwnerFixtureScopeSchema.Type) => {
  const original = invoiceRecipientResolutionRead;
  const factory = getReadServiceFactory(original);
  const current = fixtureCurrentFacts(scope);
  const registration = defineRead(
    original.descriptor,
    getReadHandler(original),
    (...args: Parameters<typeof factory>) =>
      factory(...args).pipe(
        Effect.map((services) => ({
          ...services,
          loadCurrent: () => Effect.succeed(current),
          validateRecipient: () =>
            Effect.succeed({
              billingEvidence: fixtureDecision('BILLING_DOCUMENTS'),
              kind: 'ACCEPTED' as const,
              legalEvidence: fixtureDecision('CUSTOMER_COMMERCE_POLICY'),
              taxEvidence: fixtureDecision('TAX'),
            }),
        })),
      ),
    getReadPermissionTargetResolver(original),
  );
  const problems = makeGovernedReadProblems({
    authentication: InvoiceRecipientResolutionAuthenticationProblemSchema,
    forbidden: InvoiceRecipientResolutionForbiddenProblemSchema,
    internal: InvoiceRecipientResolutionInternalProblemSchema,
    invalid: InvoiceRecipientResolutionInvalidProblemSchema,
    notFound: InvoiceRecipientResolutionNotFoundProblemSchema,
    policyConflict: InvoiceRecipientResolutionPolicyConflictProblemSchema,
    policyIneligible: InvoiceRecipientResolutionPolicyProblemSchema,
    unavailable: InvoiceRecipientResolutionUnavailableProblemSchema,
  });
  const group = HttpApiBuilder.group(InvoiceRecipientResolutionApi, 'invoiceRecipientResolution', (handlers) =>
    handlers.handle(
      'execute',
      makeGovernedReadHttpHandler({
        authenticatePrincipal: authenticateOperationPrincipal,
        problems,
        registration,
      }),
    ),
  );
  const compositionSource = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer));
  const handlers = group.pipe(
    Layer.provide(
      Layer.mergeAll(
        productionReadRuntimeLive,
        ActionPrincipalVerifierLive.pipe(Layer.provide(compositionSource)),
        CommerceAuthenticationNamespaceRegistryLive,
        configuredGatewayAssertionRedemptionLive,
        RequestSchemaProblemLive,
        commercePortalAuthPlatformCryptoLive,
      ),
    ),
    Layer.orDie,
  );
  return assembleEffectBffRuntime({ api: InvoiceRecipientResolutionApi, handlers, transport: Layer.empty });
};

const describe = Effect.sync(() => process.stdout.write(`${JSON.stringify(ultramodernApiMarker)}\n`));
const serve = Effect.scoped(
  Effect.gen(function* serveDefaultPurchaseReceiver() {
    const [fixtureArgument] = process.argv.slice(2);
    const assembly =
      fixtureArgument === undefined
        ? apiRuntime
        : invoiceFixtureRuntime(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InvoiceOwnerFixtureScopeSchema))(fixtureArgument),
          );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => assembly.createHandler()),
      (handler) => Effect.promise(async () => await handler.dispose()),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* defaultPurchaseReceiverRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise({
          catch: () => new PurchaseReceiverFixtureError({ reason: 'The default purchase HTTP adapter failed' }),
          try: async () => await runtime.handler(webRequest),
        });
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const { address } = server;
    if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
      return yield* new PurchaseReceiverFixtureError({
        reason: 'The purchase receiver requires a loopback TCP address',
      });
    }
    yield* Effect.sync(() =>
      process.stdout.write(`${JSON.stringify({ marker: ultramodernApiMarker, port: address.port, type: 'ready' })}\n`),
    );
    return yield* Effect.never;
  }),
);
NodeRuntime.runMain(
  process.argv.includes('--describe')
    ? describe.pipe(Effect.provide(NodeServices.layer))
    : serve.pipe(Effect.provide(NodeHttpServer.layerTest)),
);
