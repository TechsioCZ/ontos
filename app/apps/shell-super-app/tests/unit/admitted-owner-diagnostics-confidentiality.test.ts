// @rstest-environment node
import {
  ActiveApplicationCompositionService,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime/modules/active-application-composition';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { Effect, Tracer } from 'effect';
import { expect, it } from 'effect-rstest';

import { dispatchModuleApiRequest } from '../../src/module-api/transport.ts';
import { makeCompositionSnapshot, sealComposition } from '../fixtures/application-composition.ts';
import { startNativeHttpServer } from '../support/native-http-server.ts';

it.live(
  'records the admitted owner and numeric phases without copying private response diagnostics into its span',
  () =>
    Effect.gen(function* admittedOwnerDiagnostics() {
      const server = yield* startNativeHttpServer(() =>
        Promise.resolve(
          Response.json(
            { revision: 7 },
            {
              headers: {
                'server-timing': 'owner-total;dur=40, private;desc="secret", owner-gate;dur=12, owner-sql-count;dur=7',
              },
            },
          ),
        ),
      );
      const original = yield* makeCompositionSnapshot([
        makeModuleContractFixture({ appId: 'fixture-notes', buildMarker: 'build', moduleId: 'fixture.notes' }),
      ]);
      const snapshot = {
        ...original,
        composition: sealComposition({
          ...original.composition,
          modules: original.composition.modules.map((module) => ({
            ...module,
            backend: { baseUrl: `${server.origin}/`, transport: 'node-http' as const },
          })),
        }),
      };
      const spans: Tracer.Span[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const response = yield* dispatchModuleApiRequest(
        new Request('https://shell.test/module-api/fixture-notes/build/fixture-notes-api/reads/records', {
          body: '{}',
          headers: { 'x-ontos-composition-revision': snapshot.composition.revision },
          method: 'POST',
        }),
      ).pipe(
        Effect.provideService(
          ActiveApplicationCompositionService,
          makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
        ),
        Effect.withTracer(tracer),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ revision: 7 });
      expect(response.headers.get('server-timing')).toBeNull();
      const dispatch = spans.find((span) => span.name === 'ModuleApi.dispatchApprovedRequest');
      expect(dispatch).toBeDefined();
      expect(dispatch?.attributes.get('ontos.owner_app')).toBe('fixture-notes');
      expect(dispatch?.attributes.get('ontos.owner_timing')).toBe(
        'owner-total;dur=40, owner-gate;dur=12, owner-sql-count;dur=7',
      );
      expect(JSON.stringify([...(dispatch?.attributes.entries() ?? [])])).not.toContain('secret');
    }).pipe(Effect.scoped),
);
