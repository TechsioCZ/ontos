import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { Crypto, Effect, Layer, Schema } from 'effect';
import { HttpServerRequest } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';
import { runActionOwnerSteps } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { insideDatabaseTransaction } from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { ApplyCommandPayloadSchema, AgreementsConflict } from '../../shared/actions/apply-command.ts';
import { AgreementsStateSchema } from '../../shared/apis/records.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';

const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '10000000-0000-4000-8000-000000000001',
    authContextRef: 'session:preparation',
    authMethod: 'session',
    legalEntityId: '30000000-0000-4000-8000-000000000001',
    principalId: '40000000-0000-4000-8000-000000000001',
    tenantId: '20000000-0000-4000-8000-000000000001',
  }),
  correlationId: 'command-preparation',
};
const dependencies = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, {
    load: Effect.die('This local transition must not read a foreign module'),
  }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, {
    configuration: Effect.die('This local transition needs no assertion'),
  }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('http://localhost/preparation-test')),
  ),
  Layer.succeed(
    Crypto.Crypto,
    Crypto.make({ digest: (_algorithm, data) => Effect.succeed(data), randomBytes: (size) => new Uint8Array(size) }),
  ),
);

it.effect('rejects a revision race after prepare and never saves the prepared transition over newer owner state', () =>
  Effect.gen(function* revisionRace() {
    const ref = {
      moduleId: 'legal.agreements',
      resourceId: '50000000-0000-4000-8000-000000000001',
      resourceType: 'legal.agreements.document',
      tenantId: scope.tenantId,
    };
    const encoded = { contracts: [], documents: [], signatureObservations: [] };
    const snapshot = yield* Schema.decodeUnknownEffect(AgreementsStateSchema)(encoded);
    let shortReads = 0;
    // oxlint-disable sonarjs/no-nested-functions -- This narrow fixture mirrors the owner SQL fluent API.
    // SAFETY: This executor only implements prepare's state read; the typed write services below simulate the competing revision.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- This test uses the narrow owner-query surface, not a real database connection.
    const transaction = {
      scope,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Effect.sync(() => {
                shortReads += 1;
                return [{ revision: 0, snapshot: encoded }];
              }),
          }),
        }),
      }),
    } as unknown as ScopedTransactionExecutor;
    // oxlint-enable sonarjs/no-nested-functions
    const payload = yield* Schema.decodeUnknownEffect(ApplyCommandPayloadSchema)({
      command: {
        _tag: 'CreateDocument',
        record: {
          contractRef: null,
          createdAt: '2026-10-05T09:00:00Z',
          documentRef: ref,
          fileName: null,
          kind: 'note',
          lifecycleState: 'DRAFT',
          signedDocumentReference: null,
          title: 'Prepared document',
          updatedAt: '2026-10-05T09:00:00Z',
        },
      },
      expectedRevision: 0,
    });
    const failure = yield* runActionOwnerSteps(applyCommandAction, payload, {
      actionInvocationId: '80000000-0000-4000-8000-000000000001',
      addDomainEvent: () => Effect.die('No Domain Events'),
      addOutboxMessage: () => Effect.void,
      compositionRevision: 'test-composition',
      recordAuditEvidence: () => Effect.void,
      recordDataAccess: () => Effect.void,
      scope,
      services: {
        load: () => Effect.succeed({ revision: 1, snapshot }),
        save: () => Effect.die('Must never overwrite newer state'),
      },
      transaction: (step) => step(transaction).pipe(insideDatabaseTransaction('short-owner-read')),
    }).pipe(Effect.flip);
    expect(Schema.is(AgreementsConflict)(failure)).toBe(true);
    expect(shortReads).toBe(1);
  }).pipe(Effect.provide(dependencies)),
);
