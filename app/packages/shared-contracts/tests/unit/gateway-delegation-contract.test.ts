import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { OutboxMessageCompany } from '@app/core-runtime/outbox/message-company';
import { readFileSync } from 'node:fs';

import { ConfigProvider, Crypto, Effect, Match, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { holdTestModuleCredentials } from '../../../core-runtime/tests/support/module-credentials.ts';
import { GatewayDelegationSourceError, acquireDelegatedGatewayContext } from '../../src/gateway-context-server.ts';
import {
  GATEWAY_AUDIENCE_MAX_LENGTH,
  GatewayAudienceSchema,
  GatewayDelegatedContextRequestSchema,
} from '../../src/gateway-context.ts';

type DecodedSubject = Schema.Schema.Type<typeof GatewayDelegatedContextRequestSchema>['subject'];

const compositionRevision = 'a'.repeat(64);
const originatorInvocationId = '80000000-0000-4000-8000-000000000001';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:delegation-contract',
  authMethod: 'session',
  principalId: '10000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
});
const configuration = ConfigProvider.fromEnvRecord({
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});
/** The calling module's key, handed over the way the host does. */
const holdCallerKey = holdTestModuleCredentials({ catalog: 'fixture-module-credential' });
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => new Uint8Array(size).fill(1),
});

const recordingFetch =
  (revision: string, requests: Request[]): typeof globalThis.fetch =>
  (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(
      Response.json({
        apiBaseUrl: '/party-registry-api',
        compositionRevision: revision,
        expiresAt: 1_700_000_300,
        token: 'fixture-destination-assertion',
      }),
    );
  };

const sourceAssertionOf = (subject: DecodedSubject): string | null =>
  Match.value(subject).pipe(
    Match.tag('Assertion', (assertion) => Redacted.value(assertion.sourceAssertion)),
    Match.tag('Originator', () => null),
    Match.exhaustive,
  );

const originatorOf = (subject: DecodedSubject) =>
  Match.value(subject).pipe(
    Match.tag('Assertion', () => null),
    Match.tag('Originator', ({ actionInvocationId, tenantId }) => ({ actionInvocationId, tenantId })),
    Match.exhaustive,
  );

const requestBodyOf = (request: Request | undefined) =>
  Effect.promise(() => (request ?? new Request('https://invalid.example')).json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)),
  );

it.effect('decodes both subject variants and keeps the source assertion redacted', () =>
  Effect.gen(function* delegatedSubjectCodec() {
    const assertionWire = {
      audience: 'party-registry',
      compositionRevision,
      exchangeId: '10000000-0000-4000-8000-000000000001',
      legalEntityScope: 'subject',
      subject: { _tag: 'Assertion', sourceAssertion: 'fixture-signed-source-proof' },
    };
    const decoded = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema, {
      onExcessProperty: 'error',
    })(assertionWire);
    expect(sourceAssertionOf(decoded.subject)).toBe('fixture-signed-source-proof');
    expect(
      Match.value(decoded.subject).pipe(
        Match.tag('Assertion', (assertion) => Redacted.isRedacted(assertion.sourceAssertion)),
        Match.tag('Originator', () => false),
        Match.exhaustive,
      ),
    ).toBe(true);
    const encoded = yield* Schema.encodeEffect(GatewayDelegatedContextRequestSchema)(decoded);
    expect(encoded).toEqual(assertionWire);

    const originatorWire = {
      audience: 'party-registry',
      compositionRevision,
      exchangeId: '10000000-0000-4000-8000-000000000002',
      legalEntityScope: 'tenant',
      subject: {
        _tag: 'Originator',
        actionInvocationId: originatorInvocationId,
        tenantId: principal.tenantId,
      },
    };
    const originator = yield* Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema, {
      onExcessProperty: 'error',
    })(originatorWire);
    expect(originatorOf(originator.subject)).toEqual({
      actionInvocationId: originatorInvocationId,
      tenantId: principal.tenantId,
    });
    expect(originator.legalEntityScope).toBe('tenant');
  }),
);

it.effect('rejects unknown subject tags, extra fields, and malformed identities', () =>
  Effect.gen(function* delegatedSubjectRejection() {
    const base = {
      audience: 'party-registry',
      compositionRevision,
      exchangeId: '10000000-0000-4000-8000-000000000001',
      legalEntityScope: 'subject',
    };
    const decode = Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema, { onExcessProperty: 'error' });
    const invalid: readonly unknown[] = [
      { ...base, subject: { _tag: 'System', jobKey: 'job' } },
      {
        ...base,
        subject: { _tag: 'Assertion', actionInvocationId: originatorInvocationId, sourceAssertion: 'proof' },
      },
      {
        ...base,
        subject: { _tag: 'Originator', actionInvocationId: 'not-a-uuid', tenantId: principal.tenantId },
      },
      { ...base, subject: { _tag: 'Originator', actionInvocationId: originatorInvocationId } },
      {
        ...base,
        operationKey: 'party.registry.api.party-detail',
        subject: { _tag: 'Assertion', sourceAssertion: 'proof' },
      },
      { ...base, legalEntityScope: 'organization', subject: { _tag: 'Assertion', sourceAssertion: 'proof' } },
    ];
    for (const payload of invalid) {
      expect(yield* Effect.flip(decode(payload))).toBeDefined();
    }
  }),
);

it.effect('authenticates with the module credential and sends the Originator subject', () =>
  Effect.gen(function* delegatedOriginatorWire() {
    yield* holdCallerKey;
    const requests: Request[] = [];
    const issued = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'tenant',
        requestCorrelation: 'delegation-wire-correlation',
        subject: {
          _tag: 'Originator',
          actionInvocationId: originatorInvocationId,
          compositionRevision,
          tenantId: principal.tenantId,
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
    );

    expect(issued).toEqual({
      apiBaseUrl: 'https://shell.example.test/party-registry-api',
      authorization: 'Bearer fixture-destination-assertion',
      compositionRevision,
      expiresAt: 1_700_000_300,
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe('https://shell.example.test/shell-super-app-api/auth/delegated/gateway-context');
    expect(request?.headers.get('x-api-key')).toBe('fixture-module-credential');
    expect(request?.headers.get('x-correlation-id')).toBe('delegation-wire-correlation');
    expect(request?.headers.get('authorization')).toBeNull();
    const wire = yield* requestBodyOf(request);
    expect(wire.audience).toBe('party-registry');
    expect(wire.compositionRevision).toBe(compositionRevision);
    expect(wire.legalEntityScope).toBe('tenant');
    expect(originatorOf(wire.subject)).toEqual({
      actionInvocationId: originatorInvocationId,
      tenantId: principal.tenantId,
    });
  }),
);

const messageCompany = '30000000-0000-4000-8000-00000000000a';

/** Sends one Originator delegation with the Outbox message company the runtime provides; returns the wire's company. */
const sendOriginatorWith = (company: Option.Option<string>) =>
  Effect.gen(function* sendOriginator() {
    const requests: Request[] = [];
    yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'subject',
        requestCorrelation: 'delegation-message-company',
        subject: {
          _tag: 'Originator',
          actionInvocationId: originatorInvocationId,
          compositionRevision,
          tenantId: principal.tenantId,
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(OutboxMessageCompany, company),
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
    );
    const [request] = requests;
    const wire = yield* requestBodyOf(request);
    return Match.value(wire.subject).pipe(
      Match.tag('Assertion', () => null),
      Match.tag('Originator', ({ messageLegalEntityId }) => messageLegalEntityId ?? null),
      Match.exhaustive,
    );
  });

it.effect('carries the Outbox message company of Originator work only when the Outbox provides one', () =>
  Effect.gen(function* delegatedOriginatorMessageCompany() {
    yield* holdCallerKey;
    expect(yield* sendOriginatorWith(Option.some(messageCompany))).toBe(messageCompany);
    expect(yield* sendOriginatorWith(Option.none())).toBeNull();
  }),
);

it.effect('sends the verified incoming assertion and the requested legal entity for an Assertion subject', () =>
  Effect.gen(function* delegatedAssertionWire() {
    yield* holdCallerKey;
    const scope = trustVerifiedGatewayPrincipalContext(principal, compositionRevision, {
      assertion: Redacted.make('fixture-signed-source-proof'),
      audience: 'commerce-market-catalog',
    });
    const requests: Request[] = [];
    const issued = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'subject',
        requestCorrelation: 'delegation-assertion-correlation',
        subject: { _tag: 'Assertion', scope },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
    );

    expect(issued.authorization).toBe('Bearer fixture-destination-assertion');
    const wire = yield* requestBodyOf(requests[0]);
    expect(wire.legalEntityScope).toBe('subject');
    expect(sourceAssertionOf(wire.subject)).toBe('fixture-signed-source-proof');
  }),
);

it.effect('fails typed without requests when an Assertion subject has no verified scope', () =>
  Effect.gen(function* delegatedMissingScope() {
    yield* holdCallerKey;
    const requests: Request[] = [];
    const failure = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'subject',
        requestCorrelation: 'delegation-missing-scope',
        subject: { _tag: 'Assertion', scope: principal },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch(compositionRevision, requests)),
      Effect.flip,
    );

    expect(Schema.is(GatewayDelegationSourceError)(failure)).toBe(true);
    expect(requests).toHaveLength(0);
  }),
);

it.effect('refuses a response for a different admitted release', () =>
  Effect.gen(function* delegatedRevisionChange() {
    yield* holdCallerKey;
    const failure = yield* acquireDelegatedGatewayContext(
      {
        audience: 'party-registry',
        callingAppId: 'catalog',
        legalEntityScope: 'subject',
        requestCorrelation: 'delegation-revision-change',
        subject: {
          _tag: 'Originator',
          actionInvocationId: originatorInvocationId,
          compositionRevision,
          tenantId: principal.tenantId,
        },
      },
      crypto,
    ).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configuration),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch('b'.repeat(64), [])),
      Effect.flip,
    );

    expect(Schema.is(GatewayDelegationSourceError)(failure)).toBe(true);
  }),
);

it('bounds an audience: every topology app id fits, and an oversized one is refused before anything reads it', () => {
  const TopologySchema = Schema.Struct({ verticals: Schema.Array(Schema.Struct({ id: Schema.String })) });
  const topology = Schema.decodeUnknownSync(Schema.fromJsonString(TopologySchema))(
    readFileSync(new URL('../../../../topology/reference-topology.json', import.meta.url), 'utf-8'),
  );
  const appIds = [...topology.verticals.map(({ id }) => id), 'shell-super-app'];
  for (const appId of appIds) {
    expect(appId.length).toBeLessThanOrEqual(GATEWAY_AUDIENCE_MAX_LENGTH);
    expect(Schema.is(GatewayAudienceSchema)(appId)).toBe(true);
  }
  expect(Schema.is(GatewayAudienceSchema)('a'.repeat(GATEWAY_AUDIENCE_MAX_LENGTH))).toBe(true);
  expect(Schema.is(GatewayAudienceSchema)('a'.repeat(GATEWAY_AUDIENCE_MAX_LENGTH + 1))).toBe(false);
});
