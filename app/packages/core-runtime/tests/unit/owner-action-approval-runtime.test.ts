import { NodeServices } from '@effect/platform-node';
import { Context, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ActionMandateDispatcher,
  makeOwnerActionApprovalsLive,
  OwnerActionApprovals,
} from '@app/core-runtime/access/approvals/owner-runtime';
import { OwnerActionApprovalRequestSchema } from '@app/core-runtime/access/approvals/owner-api';
import { AccessIntent } from '../../src/access/decision/authority.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { AccessPrincipalKindSource } from '../../src/access/enforcement/actor.ts';
import { AccessDecisionLog } from '../../src/access/enforcement/decision-log.ts';
import { LegalEntityCandidates } from '../../src/access/enforcement/legal-entities.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { AccessScopeIdSchema, CommandDigestSchema, ModuleKeySchema, ProposalIdSchema } from '../../src/access/ids.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { ActiveApplicationCompositionService } from '../../src/modules/active-application-composition.ts';
import { OperationalScopeResolver } from '../../src/operations/context.ts';
import { inertAccessEnforcementPorts } from '../../src/testing/access-gate.ts';
import { actionFor, ownerKey, principal, readFor } from '../support/action-command-v2.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const build = Effect.gen(function* publicNativeComposition() {
  let statements = 0;
  let scopeResolutions = 0;
  const executor = yield* makeTestDatabase(() => {
    statements += 1;
    return Effect.die('These pre-admission refusals must not acquire a SQL lease');
  });
  const read = readFor();
  const action = actionFor(read);
  const owner = makeTestOperationOwner({ actions: [action], moduleId: ownerKey, reads: [read] });
  const ports = inertAccessEnforcementPorts();
  const gate = AccessDecisionLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AccessIntent, ports.intent),
        Layer.succeed(DecisionCheck, ports.check),
        Layer.succeed(AccessPrincipalKindSource, ports.principalKinds),
        Layer.succeed(AccessDecisionLog, ports.decisionLog),
        Layer.succeed(LegalEntityCandidates, ports.candidates),
      ),
    ),
  );
  const provider = makeOwnerActionApprovalsLive(owner.expectedDeployment, owner.ownerRegistration).pipe(
    Layer.provide(gate),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(CoreDatabase, { executor }),
        Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
        Layer.succeed(ActiveApplicationCompositionService, owner.applicationComposition),
        Layer.succeed(OperationalScopeResolver, {
          resolve: () => {
            scopeResolutions += 1;
            return Effect.die('An unsealed or foreign-owner request must stop before scope resolution');
          },
        }),
      ),
    ),
  );
  const context = yield* Layer.build(provider);
  const request = yield* Schema.decodeUnknownEffect(OwnerActionApprovalRequestSchema)({
    compositionRevision: 'a'.repeat(64),
    expectedCommandDigest: CommandDigestSchema.make('b'.repeat(64)),
    expectedOwner: { deployment: owner.expectedDeployment, moduleKey: ModuleKeySchema.make(ownerKey) },
    expectedStatus: 'pending',
    proposalId: ProposalIdSchema.make('00000000-0000-4000-8000-000000000010'),
    scopeId: AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000011'),
  });
  return {
    approvals: Context.get(context, OwnerActionApprovals),
    dispatcher: Context.get(context, ActionMandateDispatcher),
    request,
    scopeResolutions: () => scopeResolutions,
    statements: () => statements,
  };
});

it.effect(
  'the public owner provider builds both real native services without resolving an executable or acquiring SQL',
  () =>
    Effect.gen(function* actualComposition() {
      const fixture = yield* build;
      expect(fixture.dispatcher.prepare).toBeTypeOf('function');
      expect(fixture.dispatcher.authorizeExecution).toBeTypeOf('function');
      expect(fixture.dispatcher.prepareProposal).toBeTypeOf('function');
      expect(fixture.dispatcher.claim).toBeTypeOf('function');
      expect(fixture.approvals.approve).toBeTypeOf('function');
      expect(fixture.approvals.inspect).toBeTypeOf('function');
      expect(fixture.statements()).toBe(0);
      expect(fixture.scopeResolutions()).toBe(0);
    }),
);

it.effect('the public inspection service keeps the original gateway and receiving-owner checks before SQL', () =>
  Effect.gen(function* noInspectionBypass() {
    const fixture = yield* build;
    const sealed = trustVerifiedGatewayPrincipalContext(principal, fixture.request.compositionRevision);
    for (const candidate of [principal, { ...sealed }]) {
      expect(
        yield* fixture.approvals
          .inspect({
            principal: candidate,
            request: fixture.request,
            requestHeaders: { 'x-correlation-id': 'public-owner-inspection' },
          })
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: 'OwnerActionApprovalError', code: 'authentication_required' } });
    }
    expect(
      yield* fixture.approvals
        .inspect({
          principal: sealed,
          request: {
            ...fixture.request,
            expectedOwner: { ...fixture.request.expectedOwner, moduleKey: ModuleKeySchema.make('demo.other') },
          },
          requestHeaders: { 'x-correlation-id': 'public-owner-inspection' },
        })
        .pipe(Effect.result),
    ).toMatchObject({ failure: { _tag: 'OwnerActionApprovalError', code: 'approval_refused' } });
    expect(fixture.statements()).toBe(0);
    expect(fixture.scopeResolutions()).toBe(0);
  }),
);

it.effect(
  'a decoded or copied principal cannot call the public native approval service without gateway redemption provenance',
  () =>
    Effect.gen(function* noSyntheticPrincipal() {
      const fixture = yield* build;
      const sealed = trustVerifiedGatewayPrincipalContext(principal, fixture.request.compositionRevision);
      for (const candidate of [principal, { ...sealed }]) {
        expect(
          yield* fixture.approvals
            .approve({
              principal: candidate,
              request: fixture.request,
              requestHeaders: { 'x-correlation-id': 'public-owner-runtime' },
            })
            .pipe(Effect.result),
        ).toMatchObject({
          failure: { _tag: 'OwnerActionApprovalError', code: 'authentication_required' },
        });
      }
      expect(fixture.statements()).toBe(0);
      expect(fixture.scopeResolutions()).toBe(0);
    }),
);

it.effect(
  'the real provider refuses a changed expected owner or composition before its scope/authority/SQL ports',
  () =>
    Effect.gen(function* exactReceivingOwner() {
      const fixture = yield* build;
      const sealed = trustVerifiedGatewayPrincipalContext(principal, fixture.request.compositionRevision);
      for (const changed of [
        {
          ...fixture.request,
          expectedOwner: { ...fixture.request.expectedOwner, moduleKey: ModuleKeySchema.make('demo.other') },
        },
        {
          ...fixture.request,
          expectedOwner: {
            ...fixture.request.expectedOwner,
            deployment: { ...fixture.request.expectedOwner.deployment, buildMarker: 'other-release' },
          },
        },
        { ...fixture.request, compositionRevision: 'c'.repeat(64) },
      ]) {
        expect(
          yield* fixture.approvals
            .approve({
              principal: sealed,
              request: changed,
              requestHeaders: { 'x-correlation-id': 'public-owner-runtime' },
            })
            .pipe(Effect.result),
        ).toHaveProperty('failure');
      }
      expect(fixture.statements()).toBe(0);
      expect(fixture.scopeResolutions()).toBe(0);
    }),
);
