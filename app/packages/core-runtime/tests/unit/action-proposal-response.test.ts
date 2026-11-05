import { Context, DateTime, Effect, Layer, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { expect, it } from 'effect-rstest';

import { ProposalIdSchema } from '../../src/access/ids.ts';
import { ActionProposalAcceptedSchema } from '../../src/actions/proposal-accepted.ts';

const accepted = ActionProposalAcceptedSchema.make({
  _tag: 'ActionProposalAccepted',
  expiresAt: DateTime.makeUnsafe('2026-11-04T12:00:00.000Z'),
  proposalId: ProposalIdSchema.make('10000000-0000-4000-8000-000000000001'),
});

it.effect('encodes a proposal as HTTP 202 even when the ordinary result accepts an empty object', () =>
  Effect.gen(function* proposalResponse() {
    // Match the generated response alternatives. Each status needs its own success entry;
    // an outer Schema.Union would default the entire response to HTTP 200.
    const api = HttpApi.make('ProposalResponseFixture').add(
      HttpApiGroup.make('actions').add(
        HttpApiEndpoint.post('execute', '/proposal', {
          payload: Schema.Struct({ propose: Schema.Boolean }),
          success: [ActionProposalAcceptedSchema, Schema.Struct({})],
        }),
      ),
    );
    const handlers = HttpApiBuilder.group(api, 'actions', (group) =>
      group.handle('execute', ({ payload }) => Effect.succeed(payload.propose ? accepted : {})),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(api).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)),
          { disableLogger: true },
        ),
      ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const responseFor = (propose: boolean) =>
      Effect.promise(() =>
        server.handler(
          new Request('https://fixture.ontos.test/proposal', {
            body: propose ? '{"propose":true}' : '{"propose":false}',
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }),
          Context.empty(),
        ),
      );

    const response = yield* responseFor(true);
    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(yield* Effect.promise(() => response.json())).toEqual(
      yield* Schema.encodeEffect(ActionProposalAcceptedSchema)(accepted),
    );

    const ordinaryResponse = yield* responseFor(false);
    expect(ordinaryResponse.status).toBe(200);
    expect(yield* Effect.promise(() => ordinaryResponse.json())).toEqual({});
  }),
);
