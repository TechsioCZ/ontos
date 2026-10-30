// @effect-diagnostics asyncFunction:off nestedEffectGenYield:off nodeBuiltinImport:off preferSchemaOverJson:off strictEffectProvide:off -- Native proof producer child is a process entrypoint that reads private config and writes protocol frames on inherited file descriptors; expires: 2027-03-31.
import { readFileSync, writeSync } from 'node:fs';
import { inspect } from 'node:util';
import { DatabaseConfig, TrustedPrincipalContextSchema, parseDatabaseConfig } from '@app/core-runtime';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Context, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { DefinePricePayloadSchema, DefinePriceResultSchema } from '../../shared/actions/define-price.ts';
import {
  SetSupportedCurrenciesPayloadSchema,
  SetSupportedCurrenciesResultSchema,
} from '../../shared/actions/set-supported-currencies.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { CoreDatabase, CoreDatabaseLive } from '../../../../packages/core-runtime/src/db/client.ts';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { externalPriceSourceAuthorityForScope } from '../../src/persistence/external-price-source-authority-persistence.ts';
import { ExternalPriceSourceAuthorityGrantSchema } from '../../src/services/external-price-input-boundary.service.ts';

const protocol = 'ontos.pricing.preproposal-basis.producer.v1' as const;
const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const transport = {
  authorization: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384))),
  baseUrl: Schema.URLFromString.check(
    Schema.makeFilter((url) =>
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.port !== '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
        ? undefined
        : 'An isolated loopback owner receiver is required',
    ),
  ),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  correlationId: text,
  idempotencyKey: text,
  protocol: Schema.Literal(protocol),
};
const CommandSchema = Schema.Union([
  Schema.Struct({
    ...transport,
    operation: Schema.Literal('SET_SUPPORTED_CURRENCIES'),
    payload: SetSupportedCurrenciesPayloadSchema,
  }).annotate({ parseOptions: { onExcessProperty: 'error' } }),
  Schema.Struct({
    ...transport,
    operation: Schema.Literal('DEFINE_PRICE'),
    payload: DefinePricePayloadSchema,
  }).annotate({ parseOptions: { onExcessProperty: 'error' } }),
  Schema.Struct({
    ...transport,
    operation: Schema.Literal('STORE_PRICE_AUTHORITY'),
    payload: Schema.Struct({
      grant: ExternalPriceSourceAuthorityGrantSchema,
      legalEntityId: LegalEntityIdSchema.pipe(Schema.decodeTo(Schema.String)),
      principalId: PrincipalIdSchema.pipe(Schema.decodeTo(Schema.String)),
      tenantId: TenantIdSchema.pipe(Schema.decodeTo(Schema.String)),
    }),
  }).annotate({ parseOptions: { onExcessProperty: 'error' } }),
]);
const ReceiptSchema = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal('SET_SUPPORTED_CURRENCIES'),
    protocol: Schema.Literal(protocol),
    result: SetSupportedCurrenciesResultSchema,
  }),
  Schema.Struct({
    operation: Schema.Literal('DEFINE_PRICE'),
    protocol: Schema.Literal(protocol),
    result: DefinePriceResultSchema,
  }),
  Schema.Struct({
    operation: Schema.Literal('STORE_PRICE_AUTHORITY'),
    protocol: Schema.Literal(protocol),
    result: Schema.Struct({ outcome: Schema.String }),
  }),
]);

class PreproposalPricingProducerUnavailable extends Schema.TaggedError<PreproposalPricingProducerUnavailable>()(
  'PreproposalPricingProducerUnavailable',
  { stage: Schema.String },
) {}
const unavailable = (stage: string) => new PreproposalPricingProducerUnavailable({ stage });

const describe = Effect.sync(() =>
  process.stdout.write(
    `${JSON.stringify({
      marker: ultramodernApiMarker,
      operations: ['SET_SUPPORTED_CURRENCIES', 'DEFINE_PRICE', 'STORE_PRICE_AUTHORITY'],
      protocol,
      type: 'description',
    })}\n`,
  ),
);

/** One closed command over private stdin, one actual owner receipt over private fd 3. */
const execute = Effect.gen(function* executePreproposalPricingSetup() {
  const document = yield* Effect.sync(() => readFileSync(0, 'utf-8'));
  if (new TextEncoder().encode(document).length > 262_144) {
    return yield* unavailable('command-size');
  }
  const command = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CommandSchema))(document);
  const options = {
    baseUrl: command.baseUrl,
    compositionRevision: command.compositionRevision,
    idempotencyKey: command.idempotencyKey,
  };
  const receipt = yield* Effect.gen(function* invokeRegisteredPricingSetup() {
    if (command.operation === 'SET_SUPPORTED_CURRENCIES') {
      const { executeSetSupportedCurrenciesWithAuthorization } = yield* Effect.tryPromise({
        catch: () => unavailable('currency-client-import'),
        try: async () => await import('../../src/api/set-supported-currencies-action-client.ts'),
      });
      const result = yield* executeSetSupportedCurrenciesWithAuthorization(
        command.payload,
        Redacted.value(command.authorization),
        command.correlationId,
        options,
      );
      return { operation: command.operation, protocol, result };
    }
    if (command.operation === 'STORE_PRICE_AUTHORITY') {
      // The Authority registry is Pricing-private governance data with no registered Action; it is
      // written only inside this closed Pricing process, through Pricing's own scoped persistence.
      const connection = yield* Config.Redacted('DATABASE_URL');
      const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(connection) });
      if (
        !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(configuration.host) ||
        !/^ontos_test_[a-z0-9_]+$/u.test(configuration.database) ||
        configuration.user !== 'ontos_runtime'
      ) {
        return yield* unavailable('isolated-runtime-database');
      }
      const stored = yield* Effect.scoped(
        Effect.gen(function* storeWithinDatabaseScope() {
          const databaseContext = yield* Layer.build(
            CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration))),
          );
          const database = Context.get(databaseContext, CoreDatabase);
          const scope = {
            ...(yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
              authBindingId: command.payload.tenantId,
              authContextRef: `session:preproposal-price-authority:${command.payload.tenantId}`,
              authMethod: 'session',
              legalEntityId: command.payload.legalEntityId,
              principalId: command.payload.principalId,
              tenantId: command.payload.tenantId,
            })),
            correlationId: command.correlationId,
          };
          return yield* database.executor.transaction(
            Effect.fn('PreproposalPricing.storeAuthority')(function* storeAuthority(transaction) {
              const scoped = yield* installOperationalScope(transaction, scope);
              const authority = yield* externalPriceSourceAuthorityForScope(scoped, scope);
              return yield* authority.store(command.payload.grant);
            }),
          );
        }),
      );
      return { operation: command.operation, protocol, result: { outcome: stored.outcome } };
    }
    const { executeDefinePriceWithAuthorization } = yield* Effect.tryPromise({
      catch: () => unavailable('price-client-import'),
      try: async () => await import('../../src/api/define-price-action-client.ts'),
    });
    const result = yield* executeDefinePriceWithAuthorization(
      command.payload,
      Redacted.value(command.authorization),
      command.correlationId,
      options,
    );
    return { operation: command.operation, protocol, result };
  });
  const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(ReceiptSchema))(receipt);
  return yield* Effect.sync(() => writeSync(3, `${encoded}\n`));
});

if (process.argv.includes('--describe-preproposal-basis')) {
  NodeRuntime.runMain(describe);
} else if (process.argv.includes('--execute-preproposal-basis')) {
  NodeRuntime.runMain(
    execute.pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() =>
          process.stderr.write(
            `owner-producer-cause: ${inspect(cause, { depth: 8, maxStringLength: 500 })
              .replaceAll(/(?<scheme>\w+:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$<scheme>[REDACTED]@')
              .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[REDACTED]')
              .replaceAll(/(?<field>Bearer\s+)\S+/gu, '$<field>[REDACTED]')
              .slice(0, 6144)}\n`,
          ),
        ),
      ),
      Effect.mapError(() => unavailable('registered-setup-command')),
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
    { disableErrorReporting: true },
  );
}
