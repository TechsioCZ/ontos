import { ConfigProvider, Effect, Exit, FileSystem, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { prepareAgentPlatformBatch, SubmissionIntentSchema } from '../demo/prepare-agent-platform-batch.mts';

it.effect('persists the real submission key and payload before dispatch and replays them before mutable reads', () =>
  Effect.gen(function* durableSubmissionIntent() {
    let saved: string | undefined;
    let uncertain = true;
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const fs = FileSystem.makeNoop({
      exists: () => Effect.succeed(saved !== undefined),
      readFileString: () => Effect.succeed(saved ?? ''),
      writeFileString: (_path, body, options) =>
        Effect.sync(() => {
          expect(saved).toBeUndefined();
          expect(options?.flag).toBe('wx');
          expect(options?.mode).toBe(0o600);
          saved = body;
        }),
    });
    const client = HttpClient.make((request, destination) => {
      requests.push(request);
      let response: Response;
      if (destination.pathname.endsWith('/proposals/list')) {
        response = Response.json({
          batches: [],
          company: { legalEntityId: 'company', legalName: 'Company' },
          pendingCount: 0,
          unavailableModules: [],
        });
      } else if (destination.pathname === '/active') {
        response = Response.json({ composition: { revision: 'test-revision' } });
      } else if (destination.pathname.endsWith('/gateway-context')) {
        response = Response.json({ apiBaseUrl: '/merchandise-api', token: 'test-token' });
      } else if (destination.pathname.endsWith('/reads/records')) {
        response = Response.json({
          products: [{ active: true, currentPriceMinor: 10_000, id: 'product', name: 'Product', sku: 'SKU' }],
        });
      } else {
        expect(destination.pathname).toBe('/shell-super-app-api/agent-platform/proposals');
        expect(saved).toBeDefined();
        response = uncertain
          ? Response.json({ detail: 'Lost commit response' }, { status: 503 })
          : Response.json({
              batchId: 'batch',
              proposalIds: ['proposal'],
              replayed: true,
              reviewPath: '/review',
            });
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    });
    const program = prepareAgentPlatformBatch('/virtual/proposal-intent.json').pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ONTOS_AGENT_API_KEY: 'test-key',
          ONTOS_SHELL_URL: 'http://localhost:3020',
        }),
      ),
    );
    expect(Exit.isFailure(yield* Effect.exit(program))).toBe(true);
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SubmissionIntentSchema))(saved);
    const firstWrite = requests.at(-1);
    expect(firstWrite?.headers['idempotency-key']).toBe(manifest.idempotencyKey);
    const count = requests.length;
    uncertain = false;
    expect(Exit.isSuccess(yield* Effect.exit(program))).toBe(true);
    expect(requests).toHaveLength(count + 1);
    const retry = requests.at(-1);
    expect(retry?.url).toBe(firstWrite?.url);
    expect(retry?.headers['idempotency-key']).toBe(firstWrite?.headers['idempotency-key']);
    expect(retry?.body).toEqual(firstWrite?.body);
  }),
);
