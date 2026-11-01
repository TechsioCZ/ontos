import { NodeRuntime, NodeSocket } from '@effect/platform-node';
import { Config, Effect, Layer, Stream, Schema } from 'effect';
import { Socket } from 'effect/socket';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  marketRevisionNativeBackend,
  MarketRevisionNativeIssueUnavailable,
  marketRevisionNativeServices,
} from '../fixtures/market-revision-native-backend.ts';
import {
  MarketRevisionNativeCommandSchema,
  marketRevisionNativeLines,
  marketRevisionNativeSocketEnvironment,
  validateMarketRevisionNativeSocket,
  MarketRevisionNativeResponseSchema,
} from './market-revision-native-protocol.ts';
import type { CreateMarketResultSchema } from '../../shared/action-contracts.ts';

class MarketRevisionNativeChildError extends Schema.TaggedError<MarketRevisionNativeChildError>()(
  'MarketRevisionNativeChildError',
  {},
) {}
const unavailable = () => new MarketRevisionNativeChildError({});
const serve = Effect.scoped(
  Effect.gen(function* serveOwnerNativeMarket() {
    const socketPath = yield* Config.String(marketRevisionNativeSocketEnvironment).pipe(Effect.mapError(unavailable));
    yield* validateMarketRevisionNativeSocket(socketPath);
    const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: socketPath });
    // Retain the opened reader through READY and the complete fixed-command loop.
    const pull = yield* Socket.readerBytes(socket);
    const writer = yield* socket.writer;
    const send = (response: typeof MarketRevisionNativeResponseSchema.Type) =>
      Schema.encodeEffect(Schema.fromJsonString(MarketRevisionNativeResponseSchema))(response).pipe(
        Effect.flatMap((line) => writer.write(`${line}\n`)),
        Effect.mapError(unavailable),
      );
    const managementExecutor = yield* Config.String('ONTOS_NATIVE_MARKET_MANAGEMENT_EXECUTOR').pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literals(['allowed', 'denied']))),
      Effect.mapError(unavailable),
    );
    const owner = yield* marketRevisionNativeBackend(managementExecutor);
    let original: typeof CreateMarketResultSchema.Type | undefined;
    let revised = false;
    const ready = yield* Schema.decodeUnknownEffect(Schema.toType(MarketRevisionNativeResponseSchema))({
      ...owner,
      type: 'READY',
    });
    yield* send(ready);
    yield* marketRevisionNativeLines(pull).pipe(
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(MarketRevisionNativeCommandSchema), {
          onExcessProperty: 'error',
        })(line),
      ),
      Stream.takeUntil((command) => command.type === 'STOP'),
      Stream.runForEach((command) =>
        Effect.gen(function* runFixedOwnerCommand() {
          if (command.type === 'STOP') {
            return yield* send({ type: 'STOPPED' });
          }
          if (command.type === 'CREATE_R1') {
            if (original !== undefined) {
              return yield* unavailable();
            }
            original = yield* owner.createR1();
            return yield* send({ result: original, type: 'CREATED' });
          }
          if (command.type === 'REVISE_R2') {
            if (original === undefined || revised) {
              return yield* unavailable();
            }
            const result = yield* owner.reviseR2(original);
            revised = true;
            return yield* send({ result, type: 'REVISED' });
          }
          if (command.type === 'ISSUE') {
            return yield* owner.issue(command.input).pipe(
              Effect.map((result): typeof MarketRevisionNativeResponseSchema.Type => ({ type: 'ISSUED', ...result })),
              Effect.catchIf(Schema.is(MarketRevisionNativeIssueUnavailable), (error) =>
                Schema.decodeUnknownEffect(MarketRevisionNativeResponseSchema)({ stage: error.stage, type: 'FAILED' }),
              ),
              Effect.flatMap(send),
            );
          }
          if (command.type === 'SET_CCC_STATE') {
            const actual = yield* owner.setCustomerContextState(command.state);
            return yield* send({ state: actual.state, type: 'CCC_STATE_SET' });
          }
          if (command.type === 'CLOSE_STOREFRONT') {
            yield* owner.closeStorefront();
            return yield* send({ type: 'STOREFRONT_CLOSED' });
          }
          if (command.type === 'EVIDENCE') {
            return yield* owner.evidence().pipe(Effect.flatMap((value) => send({ ...value, type: 'EVIDENCE' })));
          }
          return yield* unavailable();
        }),
      ),
    );
  }),
);
const describe = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
  marker: ultramodernApiMarker,
  protocolVersion: 2,
  responseTransport: 'private-unix-duplex',
}).pipe(Effect.flatMap((line) => Effect.sync(() => process.stdout.write(`${line}\n`))));
NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* ownedChildEntry() {
      if (process.argv.includes('--describe')) {
        return yield* describe;
      }
      const services = yield* Layer.build(marketRevisionNativeServices);
      return yield* serve.pipe(Effect.provideContext(services));
    }),
  ),
  { disableErrorReporting: true },
);
