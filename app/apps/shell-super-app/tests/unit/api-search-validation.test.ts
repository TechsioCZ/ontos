import {
  ContextAccess,
  LegalEntityContext,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ReadCoreError } from '@app/core-runtime';
import { Effect, Exit, Layer, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { AuthenticationService } from '../../api/auth/service.ts';
import type { ShellContextResult } from '../../api/auth/service.ts';
import { shellSearchHandler } from '../../api/index.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { ShellGovernedReads } from '../../api/modules/shell-governed-reads.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';
import { makeAuthenticationServiceDouble } from '../support/impersonation-service-doubles.ts';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:search-validation',
  authenticationNamespaceId: 'staff',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
});
const company = { legalEntityId: principal.legalEntityId ?? '', legalName: 'Search company' };
const authenticated: ShellContextResult = {
  availableLegalEntities: [company],
  identity: {
    displayName: 'Search user',
    email: 'search@example.test',
    principalId: principal.principalId,
    tenantId: principal.tenantId,
    ...company,
  },
  principal,
  setCookieHeaders: [],
  state: 'authenticated',
};
const request = { headers: { cookie: 'session=search', 'x-correlation-id': 'search-validation' } };

const failedSearch = Effect.fn('test.failedSearch')(function* failedSearch(failure: ReadCoreError) {
  const snapshot = yield* makeCompositionSnapshot([]);
  const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  return yield* shellSearchHandler(request, {
    compositionRevision: catalog.composition.revision,
    query: 'Eva',
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          AuthenticationService,
          makeAuthenticationServiceDouble({ resolveShellContext: () => Effect.succeed(authenticated) }),
        ),
        Layer.succeed(ContextAccess, makeContextAccessDouble('allowed')),
        Layer.mock(LegalEntityContext, {}),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
        Layer.mock(ShellGovernedReads, { search: () => Effect.fail(failure) }),
        Layer.succeed(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://shell.test/shell/search')),
        ),
      ),
    ),
    Effect.exit,
  );
});

it.effect('maps invalid search selectors to a generic 400 without echoing private validation details', () =>
  Effect.gen(function* invalidSelector() {
    const exit = yield* failedSearch(
      new ReadInputValidationError({ code: 'read_input_invalid', reason: 'SECRET unadmitted resource type' }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const serialized = JSON.stringify(exit);
    expect(serialized).toContain('ShellInvalidRequestProblem');
    expect(serialized).toContain('"status":400');
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('ShellInternalProblem');
  }),
);

it.effect('keeps an actual search permission denial forbidden rather than classifying it as invalid input', () =>
  Effect.gen(function* permissionDenied() {
    const exit = yield* failedSearch(
      new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'Read denied' }),
    );
    expect(JSON.stringify(exit)).toContain('ShellTargetForbiddenProblem');
    expect(JSON.stringify(exit)).toContain('"status":403');
  }),
);

it.effect('keeps an unavailable search owner retryable rather than reporting invalid input', () =>
  Effect.gen(function* ownerUnavailable() {
    const exit = yield* failedSearch(
      new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Owner unavailable' }),
    );
    expect(JSON.stringify(exit)).toContain('ShellCapabilityUnavailableProblem');
    expect(JSON.stringify(exit)).toContain('"status":503');
  }),
);
