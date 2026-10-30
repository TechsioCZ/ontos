import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Schema, Stdio, Stream } from 'effect';
import { GatewayScopeGrantRegistrar, GatewayScopeGrantRegistrarLive } from '../../src/auth/gateway-scope-grant.ts';
import { PrincipalIdSchema, TenantIdSchema } from '../../src/auth/external-identity-contracts.ts';

const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PreproposalLegalEntityId'));
const commandSchema = Schema.Struct({
  assertion: Schema.RedactedFromValue(Schema.String),
  audience: Schema.String,
  expiresAtEpochSeconds: Schema.Int,
  jti: Schema.String.check(Schema.isUUID()),
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
const responseSchema = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literals(['ready', 'registered', 'failed']) }),
);

// Authentication test seam only. Dedicated piped stdin/stdout carry commands and
// acknowledgments; no command or parser Cause is logged. The real registrar and
// issuer login enforce the same exact signed assertion grant as the Shell issuer.
const serve = Effect.gen(function* serveSignedAssertionRegistration() {
  const registrar = yield* GatewayScopeGrantRegistrar;
  const stdio = yield* Stdio.Stdio;
  const write = (type: (typeof responseSchema.Type)['type']) =>
    Schema.encodeEffect(responseSchema)({ type }).pipe(
      Effect.flatMap((document) => Stream.run(Stream.make(`${document}\n`), stdio.stdout())),
    );
  yield* write('ready');
  yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((document) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(commandSchema))(document).pipe(
        Effect.flatMap((command) => registrar.register(command)),
        Effect.andThen(write('registered')),
      ),
    ),
    Effect.catchCause(() => write('failed')),
  );
});

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* scopeGrantMain() {
      const services = yield* Layer.build(GatewayScopeGrantRegistrarLive.pipe(Layer.provideMerge(NodeServices.layer)));
      yield* serve.pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
        Effect.provideContext(services),
      );
    }),
  ),
);
