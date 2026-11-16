// @rstest-environment node
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { Effect, Tracer } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { dispatchModuleApiRequest } from '../../src/module-api/transport.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

/*
 * A request that waits on a module owner waits on another process, whose own work no counter of the request sees.
 * The dispatch span therefore names the owner and carries the phases the owner reported itself, already reduced to
 * fixed names and numbers, so the request's log line can say which owner took the time and on what.
 */
rs.mock('../../src/module-api/admission.ts', () => ({
  admitModuleApiRequest: (request: Request) =>
    Effect.succeed({
      forwardedRequest: request,
      module: { deployment: { appId: 'work-tasks' } },
      responseCookieNames: [],
    }),
}));
rs.mock('@app/core-runtime/unit-service-fetch', () => ({
  moduleReleaseFetch: () =>
    Effect.succeed(
      new Response('{}', {
        headers: {
          'server-timing': 'owner-total;dur=40, private;desc="secret", owner-gate;dur=12, owner-sql-count;dur=7',
        },
        status: 200,
      }),
    ),
}));

it.effect('names the owner and the phases it reported on the dispatch span, never anything else it sent', () =>
  Effect.gen(function* ownerSpan() {
    const attributes = new Map<string, unknown>();
    const parent = yield* Effect.tracer;
    const recording = Tracer.make({
      span: (options) => {
        const opened = parent.span(options);
        if (options.name === 'ModuleApi.dispatchApprovedRequest') {
          const attribute = opened.attribute.bind(opened);
          opened.attribute = (key, value) => {
            attributes.set(key, value);
            attribute(key, value);
          };
        }
        return opened;
      },
    });
    const snapshot = yield* makeCompositionSnapshot([]);
    const response = yield* dispatchModuleApiRequest(
      new Request('https://shell.internal/module-api/work-tasks/build/api/x', { method: 'POST' }),
    ).pipe(
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      Effect.withTracer(recording),
    );
    expect(response.status).toBe(200);
    expect(attributes.get('ontos.owner_app')).toBe('work-tasks');
    expect(attributes.get('ontos.owner_timing')).toBe('owner-total;dur=40, owner-gate;dur=12, owner-sql-count;dur=7');
  }),
);
