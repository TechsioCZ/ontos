import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { ReadPermissionUnavailable } from '../../src/reads/errors.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';

/**
 * A tenant Read with `forbidden` legal-entity scope cannot leave its permission target undecided. The target
 * is legal-entity scoped, so without a legal entity it can only be skipped, and skipping it used to mean
 * `allowed`. Two entrypoint shapes leave it undecided and are rejected at definition time:
 *
 * - `authenticated_principal`, because nothing else evaluates a gate; and
 * - `module.access`, because `checkEntrypointContextPermission` reuses the primary decision for the read's own
 *   module, so the gate would restate the decision that is missing.
 *
 * A custom context permission is not undecided: it is evaluated against a tenant-scoped object and is the
 * shape the shipped catalog reads use.
 */

const MODULE_KEY = 'probe.inventory';
const GUARD_MESSAGE = 'forbidden legal-entity scope needs a permission target';

type Authorization =
  | { readonly kind: 'authenticated_principal' }
  | { readonly kind: 'context_permission'; readonly permission: string };

interface RegistrationInput {
  readonly authorization: Authorization;
  readonly entrypointScope: 'system' | 'tenant';
  readonly legalEntityScope: 'forbidden' | 'optional' | 'required';
  readonly onHandler?: () => void;
  readonly permissionTarget: 'module' | 'resource';
}

const moduleResolver = () => ({ kind: 'module' as const, moduleId: MODULE_KEY });
const resourceResolver = () => ({
  kind: 'resource' as const,
  permission: 'read' as const,
  resource: { moduleId: MODULE_KEY, resourceId: 'conflict-1', resourceType: 'probe.inventory.conflict' },
});

const registration = (input: RegistrationInput) => {
  const moduleKey = input.entrypointScope === 'system' ? 'core.shell' : MODULE_KEY;
  return defineRead(
    {
      accessKind: 'detail',
      entrypoint:
        input.entrypointScope === 'system'
          ? defineSystemModuleEntrypoint({
              access: 'read',
              authorization: { kind: 'context_permission', permission: 'module.access' },
              entrypointKey: 'core.shell.probe-read',
              moduleKey,
              role: 'api',
            })
          : defineTenantModuleEntrypoint({
              access: 'read',
              authorization: input.authorization,
              entrypointKey: 'probe.inventory.detail',
              moduleKey,
              role: 'api',
            }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: 'probe.inventory.detail.v1' },
      inputSchema: Schema.Struct({}),
      legalEntityScope: input.legalEntityScope,
      owningModuleKey: moduleKey,
      permissionTarget: input.permissionTarget,
      policies: [],
      readKey: 'probe.inventory.detail',
      resultSchema: Schema.String,
      schemaVersion: '1',
    },
    {
      load: () => {
        input.onHandler?.();
        return Effect.succeed({ evidence: { resultCount: 1 }, result: 'probe-result' });
      },
    },
    () => Effect.succeed({}),
    input.permissionTarget === 'resource' ? resourceResolver : moduleResolver,
  );
};

/** `undefined` when the descriptor is accepted, otherwise the definition-time rejection message. */
const rejectionMessage = (input: RegistrationInput): string | undefined => {
  try {
    registration(input);
    return undefined;
  } catch (error) {
    return String(error);
  }
};

const AUTHENTICATED_PRINCIPAL: Authorization = { kind: 'authenticated_principal' };
/** A custom context permission, as the shipped catalog reads declare. */
const CATALOG_CONTEXT_PERMISSION: Authorization = {
  kind: 'context_permission',
  permission: 'commerce.catalog.read.list-recorded-variants',
};

it('rejects a tenant Read whose only gate would be an unevaluable module target', () => {
  expect(
    rejectionMessage({
      authorization: AUTHENTICATED_PRINCIPAL,
      entrypointScope: 'tenant',
      legalEntityScope: 'forbidden',
      permissionTarget: 'module',
    }),
  ).toContain(GUARD_MESSAGE);
});

it('rejects a tenant Read whose only gate would be an unevaluable resource target', () => {
  expect(
    rejectionMessage({
      authorization: AUTHENTICATED_PRINCIPAL,
      entrypointScope: 'tenant',
      legalEntityScope: 'forbidden',
      permissionTarget: 'resource',
    }),
  ).toContain(GUARD_MESSAGE);
});

it('rejects a module.access gate, because it restates the decision that is missing', () => {
  expect(
    rejectionMessage({
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointScope: 'tenant',
      legalEntityScope: 'forbidden',
      permissionTarget: 'module',
    }),
  ).toContain(GUARD_MESSAGE);
});

it('accepts the shipped catalog shape: forbidden scope, module target, custom context permission', () => {
  expect(
    rejectionMessage({
      authorization: CATALOG_CONTEXT_PERMISSION,
      entrypointScope: 'tenant',
      legalEntityScope: 'forbidden',
      permissionTarget: 'module',
    }),
  ).toBeUndefined();
});

it('accepts a tenant Read that has a legal entity, so its target is evaluable', () => {
  expect(
    rejectionMessage({
      authorization: AUTHENTICATED_PRINCIPAL,
      entrypointScope: 'tenant',
      legalEntityScope: 'required',
      permissionTarget: 'module',
    }),
  ).toBeUndefined();
});

it('still accepts a system Read whose Core-internal target has no legal entity to bind', () => {
  expect(
    rejectionMessage({
      authorization: CATALOG_CONTEXT_PERMISSION,
      entrypointScope: 'system',
      legalEntityScope: 'forbidden',
      permissionTarget: 'module',
    }),
  ).toBeUndefined();
});

const scopeWithoutLegalEntity = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'better-auth-session:probe',
    authMethod: 'session',
    principalId: '00000000-0000-4000-8000-000000000003',
    tenantId: '00000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'probe-correlation',
});
const scopeWithLegalEntity = Object.freeze({
  ...scopeWithoutLegalEntity,
  legalEntityId: '00000000-0000-4000-8000-000000000002',
});
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-09-28T09:00:00.000Z')));

/**
 * The shipped `optional` shape: a tenant entrypoint gated by `module.access` with a module target. With no
 * legal entity the target cannot be evaluated, so the read must stop before the handler runs.
 */
const makeOptionalModuleAccessRegistration = (onHandler: () => void) =>
  registration({
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointScope: 'tenant',
    legalEntityScope: 'optional',
    onHandler,
    permissionTarget: 'module',
  });

it.layer(NodeCrypto.layer)('read permission targets that need a legal entity', (suite) => {
  suite.effect('denies an optional module.access read when the scope has no legal entity', () =>
    Effect.gen(function* optionalModuleAccessWithoutLegalEntity() {
      let handlerRuns = 0;
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.succeed([]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope: scopeWithoutLegalEntity,
      });
      const failure = yield* harness.runtime
        .runRead({
          input: {},
          principal: scopeWithoutLegalEntity,
          registration: makeOptionalModuleAccessRegistration(() => {
            handlerRuns += 1;
          }),
          transport: { correlationId: 'probe-correlation' },
        })
        .pipe(Effect.flip);
      expect(Schema.is(ReadPermissionUnavailable)(failure)).toBe(true);
      expect(handlerRuns).toBe(0);
    }),
  );

  suite.effect('executes the same read for a caller that does carry a legal entity (control)', () =>
    Effect.gen(function* optionalModuleAccessWithLegalEntity() {
      let handlerRuns = 0;
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.succeed([]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope: scopeWithLegalEntity,
      });
      const exit = yield* Effect.exit(
        harness.runtime.runRead({
          input: {},
          principal: scopeWithLegalEntity,
          registration: makeOptionalModuleAccessRegistration(() => {
            handlerRuns += 1;
          }),
          transport: { correlationId: 'probe-correlation' },
        }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(handlerRuns).toBe(1);
    }),
  );

  suite.effect('bounds the correlation identifier for direct runtime callers, not only the HTTP adapters', () =>
    Effect.gen(function* directRuntimeCorrelationBound() {
      // Shell routes call ReadRuntime directly with the raw request header, so the transport schema has to
      // bound the identifier itself.
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.succeed([]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope: scopeWithLegalEntity,
      });
      let handlerRuns = 0;
      const exit = yield* Effect.exit(
        harness.runtime.runRead({
          input: {},
          principal: scopeWithLegalEntity,
          registration: makeOptionalModuleAccessRegistration(() => {
            handlerRuns += 1;
          }),
          transport: { correlationId: 'c'.repeat(201) },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(handlerRuns).toBe(0);
    }),
  );
});
