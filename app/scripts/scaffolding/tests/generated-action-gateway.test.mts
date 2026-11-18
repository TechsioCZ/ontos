// @rstest-environment happy-dom
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  OperationGateway,
  OperationGatewayIssuer,
} from '../../../packages/shared-contracts/src/operation-gateway.ts';
import { pinDocumentCompositionRevision } from '../../../packages/shared-contracts/src/document-composition-revision.ts';
import { renderActionGatewayClient } from '../microvertical-action-boundary/scaffold.mts';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const inventorySlug = 'inventory-stock';
const inventoryApiBaseUrl = '/inventory-stock-api';
const compositionRevision = 'c'.repeat(64);

interface GeneratedOperationGatewayModule {
  readonly makeOperationGateway: <IssuerFailure>(
    acquire: OperationGatewayIssuer<string, IssuerFailure>,
  ) => OperationGateway<IssuerFailure>;
}

const GeneratedOperationGatewayModuleSchema = Schema.Struct({
  makeOperationGateway: Schema.declare<GeneratedOperationGatewayModule['makeOperationGateway']>(
    (value): value is GeneratedOperationGatewayModule['makeOperationGateway'] => Predicate.isFunction(value),
  ),
});

/** The generated browser gateway, written as the scaffold writes it, beside the workspace shared contracts. */
const generatedGatewayModule = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-generated-gateway-'))),
  (root) => Effect.promise(() => rm(root, { force: true, recursive: true })),
).pipe(
  Effect.flatMap((root) =>
    Effect.gen(function* writeGeneratedGateway() {
      yield* Effect.promise(() => mkdir(path.join(root, 'node_modules/@app'), { recursive: true }));
      yield* Effect.promise(() =>
        symlink(
          path.join(appRoot, 'packages/shared-contracts'),
          path.join(root, 'node_modules/@app/shared-contracts'),
          'dir',
        ),
      );
      const gatewayFile = path.join(root, 'src/api/action-gateway.ts');
      yield* Effect.promise(() => mkdir(path.dirname(gatewayFile), { recursive: true }));
      yield* Effect.promise(() => writeFile(gatewayFile, renderActionGatewayClient({ appId: inventorySlug }), 'utf-8'));
      return yield* Schema.decodeUnknownEffect(GeneratedOperationGatewayModuleSchema)(
        yield* Effect.promise(() => import(pathToFileURL(gatewayFile).href)),
      );
    }),
  ),
);

it.live('the generated action gateway acquires a fresh audience assertion for the pinned browser document', () =>
  Effect.gen(function* generatedGatewayAssertions() {
    const generatedClientModule = yield* generatedGatewayModule;
    let acquisitions = 0;
    const authorizations: string[] = [];
    // The test environment's real browser document admits exactly one release.
    yield* pinDocumentCompositionRevision(compositionRevision);
    const idempotencyKey = 'caller-owned-idempotency-key';
    const operationGateway = generatedClientModule.makeOperationGateway(
      ({ audience, compositionRevision: requested }) => {
        acquisitions += 1;
        expect(audience).toBe(inventorySlug);
        expect(requested).toBe(compositionRevision);
        return Effect.succeed({
          apiBaseUrl: inventoryApiBaseUrl,
          compositionRevision: requested,
          expiresAt: 2_000_000_000,
          token: `attempt-${acquisitions}`,
        });
      },
    );
    const attempt = (
      authorization: string,
      target: { readonly apiBaseUrl: string; readonly compositionRevision: string },
    ) => {
      authorizations.push(authorization);
      expect(target).toEqual({ apiBaseUrl: inventoryApiBaseUrl, compositionRevision });
      return Effect.succeed(idempotencyKey);
    };
    expect(yield* operationGateway.invoke(attempt)).toBe(idempotencyKey);
    expect(yield* operationGateway.invoke(attempt)).toBe(idempotencyKey);
    expect(authorizations).toEqual(['Bearer attempt-1', 'Bearer attempt-2']);
  }).pipe(Effect.scoped),
);
