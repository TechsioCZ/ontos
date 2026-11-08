import type { ApplicationCompositionModule } from '@app/core-runtime';
import {
  OWNER_ACTION_APPROVAL_PATH,
  OWNER_ACTION_APPROVAL_INSPECTION_PATH,
  OwnerActionApprovalRequestSchema,
} from '@app/core-runtime/access/approvals/owner-api';
import { CommandDigestSchema } from '@app/core-runtime/access/ids';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApprovalOwnerIdentity, requireApprovalOwnerIdentity } from '../../api/access-admin/approval-owner-identity.ts';
import { ApprovalOwnerModuleTransport } from '../../api/access-admin/approval-owner-module-transport.ts';
import { makeApprovalOwnerTransport } from '../../api/access-admin/approval-owner-transport.ts';
import type { ApprovalCommandFailure } from '../../api/access-admin/approvals-contract.ts';
import type { IssueGatewayAssertionInput } from '../../api/auth/gateway-issuer.ts';
import { GatewayIssuer } from '../../api/auth/gateway-issuer.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import {
  approvalOwnerCompanyId,
  approvalOwnerFrozen,
  approvalOwnerModuleId,
  approvalOwnerPrincipal,
  approvalOwnerProposal,
  approvalOwnerTenantScope,
} from '../fixtures/approval-owner.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const deployment = { appId: 'approval-owner-fixture', buildMarker: 'approved-owner.1' };
const request = {
  frozen: approvalOwnerFrozen,
  headers: new Headers({ authorization: 'untrusted-browser-credential', cookie: 'staff-cookie=private' }),
  proposal: approvalOwnerProposal,
};
const successBody = { proposalId: approvalOwnerProposal.id, status: 'approved' };
const fixture = Effect.fn('OwnerApprovalTransportTest.fixture')(function* ownerApprovalTransportFixture(
  options: {
    readonly body?: string;
    readonly inspectionPublished?: boolean;
    readonly published?: boolean;
    readonly selectedCompany?: string;
    readonly status?: number;
  } = {},
) {
  const base = makeModuleContractFixture({
    ...deployment,
    moduleId: approvalOwnerModuleId,
  });
  const snapshot = yield* makeCompositionSnapshot([
    {
      ...base,
      manifest: {
        ...base.manifest,
        publicSurface: {
          ...base.manifest.publicSurface,
          api:
            options.published === false
              ? []
              : [
                  {
                    key: `${approvalOwnerModuleId}.owner-action-approvals`,
                    operationKeys:
                      options.inspectionPublished === false
                        ? ['ownerActionApprovals.approve']
                        : ['ownerActionApprovals.approve', 'ownerActionApprovals.inspect'],
                  },
                ],
        },
      },
    },
  ]);
  const issued: IssueGatewayAssertionInput<unknown>[] = [];
  const sent: { readonly module: ApplicationCompositionModule; readonly request: Request }[] = [];
  const observations = { identities: 0 };
  const transport = yield* makeApprovalOwnerTransport.pipe(
    Effect.provideService(ApprovalOwnerIdentity, {
      resolve: (_headers, admitted, company) => {
        observations.identities += 1;
        return requireApprovalOwnerIdentity(
          admitted,
          { ...approvalOwnerPrincipal, legalEntityId: options.selectedCompany ?? approvalOwnerCompanyId },
          company,
        ).pipe(
          Effect.mapError((): ApprovalCommandFailure => ({
            _tag: 'ApprovalCommandRefused',
            code: 'approval_authority_missing',
            reason: 'The current real selected company differs',
            retryable: false,
          })),
        );
      },
    }),
    Effect.provideService(GatewayIssuer, {
      issue: (input) => {
        issued.push(input);
        return Effect.succeed({
          apiBaseUrl: '/module-api/approval-owner-fixture/approved-owner.1/approval-owner-fixture-api',
          compositionRevision: snapshot.composition.revision,
          expiresAt: 2_000_000_000,
          token: 'fresh-owner-audience-assertion',
        });
      },
      issueDocument: () => Effect.die('Approval issues one assertion, not document assertions'),
    }),
    Effect.provideService(ShellInstalledModuleCatalog, {
      load: makeInstalledModuleCatalogLoader(Effect.succeed(snapshot)),
    }),
    Effect.provideService(ApprovalOwnerModuleTransport, {
      send: (outbound, module) => {
        sent.push({ module, request: outbound });
        const responseBody = new URL(outbound.url).pathname.endsWith(OWNER_ACTION_APPROVAL_INSPECTION_PATH)
          ? { canApprove: true, proposalId: approvalOwnerProposal.id }
          : successBody;
        return Effect.succeed(
          new Response(options.body ?? JSON.stringify(responseBody), {
            headers: { 'content-type': 'application/json' },
            status: options.status ?? 200,
          }),
        );
      },
    }),
  );
  return { issued, observations, sent, snapshot, transport };
});

it.effect('uses the published nonmutating owner inspection with the same frozen digest and fresh identity', () =>
  Effect.gen(function* inspectsOriginalOwner() {
    const test = yield* fixture();
    expect(yield* test.transport.inspect(approvalOwnerTenantScope, request)).toBe(true);
    expect(test.observations.identities).toBe(1);
    expect(test.issued).toHaveLength(1);
    expect(test.sent).toHaveLength(1);
    const [sent] = test.sent;
    if (sent === undefined) {
      return yield* Effect.die('The inspection must send exactly one owner request');
    }
    expect(sent.request.url).toBe(
      `https://module.invalid/${deployment.appId}-api${OWNER_ACTION_APPROVAL_INSPECTION_PATH}`,
    );
    const body = yield* Effect.promise(() => sent.request.text());
    const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OwnerActionApprovalRequestSchema))(body);
    expect(payload).toEqual({
      compositionRevision: test.snapshot.composition.revision,
      expectedCommandDigest: approvalOwnerFrozen.commandDigest,
      expectedOwner: { deployment, moduleKey: approvalOwnerModuleId },
      expectedStatus: 'pending',
      proposalId: approvalOwnerProposal.id,
      scopeId: approvalOwnerProposal.scopeId,
    });
    expect(body).not.toContain('salary');
    expect(body).not.toContain('actionAuthority');
    return yield* Effect.void;
  }),
);

it.effect('never substitutes an approval route when inspection is not published', () =>
  Effect.gen(function* noInspectionFallback() {
    const test = yield* fixture({ inspectionPublished: false });
    expect(Result.isFailure(yield* Effect.result(test.transport.inspect(approvalOwnerTenantScope, request)))).toBe(
      true,
    );
    expect(test.observations.identities).toBe(0);
    expect(test.issued).toHaveLength(0);
    expect(test.sent).toHaveLength(0);
  }),
);

it.effect('retains a negative owner inspection without claiming authority or approval', () =>
  Effect.gen(function* deniedInspection() {
    const test = yield* fixture({ body: JSON.stringify({ canApprove: false, proposalId: approvalOwnerProposal.id }) });
    expect(yield* test.transport.inspect(approvalOwnerTenantScope, request)).toBe(false);
  }),
);

for (const body of [
  'malformed',
  JSON.stringify({ canApprove: true, proposalId: '00000000-0000-4000-8000-000000000099' }),
  JSON.stringify({ actionAuthority: { private: true }, canApprove: true, proposalId: approvalOwnerProposal.id }),
  JSON.stringify(successBody),
]) {
  it.effect('refuses malformed or over-disclosing owner inspection without treating it as approval', () =>
    Effect.gen(function* invalidInspection() {
      const test = yield* fixture({ body });
      const result = yield* Effect.result(test.transport.inspect(approvalOwnerTenantScope, request));
      expect(Result.isFailure(result) && result.failure._tag).toBe('ApprovalPortUnavailable');
    }),
  );
}

it.effect('routes only to the published owner release and transports no browser credentials, payload or proof', () =>
  Effect.gen(function* routesOriginalOwner() {
    const test = yield* fixture();
    yield* test.transport.approve(approvalOwnerTenantScope, request);
    expect(test.sent).toHaveLength(1);
    expect(test.issued).toHaveLength(1);
    const [sent] = test.sent;
    const [issued] = test.issued;
    if (sent === undefined || issued === undefined) {
      expect.unreachable('The owner received exactly one approval request');
    }
    expect(sent.module.moduleId).toBe(approvalOwnerModuleId);
    expect(sent.module.deployment).toEqual(deployment);
    expect(new URL(sent.request.url).pathname).toBe(`/${deployment.appId}-api${OWNER_ACTION_APPROVAL_PATH}`);
    expect(sent.request.headers.get('authorization')).toBe('Bearer fresh-owner-audience-assertion');
    expect(sent.request.headers.get('cookie')).toBeNull();
    expect(issued.principal).toEqual(approvalOwnerPrincipal);
    expect(issued.audience).toBe(deployment.appId);
    expect(issued.compositionRevision).toBe(test.snapshot.composition.revision);
    const encoded = yield* Effect.promise(() => sent.request.text());
    const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OwnerActionApprovalRequestSchema))(encoded);
    expect(payload).toEqual({
      compositionRevision: test.snapshot.composition.revision,
      expectedCommandDigest: approvalOwnerFrozen.commandDigest,
      expectedOwner: { deployment, moduleKey: approvalOwnerModuleId },
      expectedStatus: 'pending',
      proposalId: approvalOwnerFrozen.proposalId,
      scopeId: approvalOwnerFrozen.scopeId,
    });
    expect(encoded).not.toContain('salary');
    expect(encoded).not.toContain('record-1');
    expect(encoded).not.toContain('actionAuthority');
  }),
);

it.effect('refuses an unpublished owner API before identity, assertion issuance or transport', () =>
  Effect.gen(function* refusesUnpublishedTransport() {
    const test = yield* fixture({ published: false });
    const result = yield* Effect.result(test.transport.approve(approvalOwnerTenantScope, request));
    expect(Result.isFailure(result) && result.failure._tag).toBe('ApprovalPortUnavailable');
    expect(test.observations.identities).toBe(0);
    expect(test.issued).toHaveLength(0);
    expect(test.sent).toHaveLength(0);
  }),
);

it.effect('refuses a different actual selected company without issuing or sending an owner assertion', () =>
  Effect.gen(function* refusesCompanySubstitution() {
    const test = yield* fixture({ selectedCompany: '00000000-0000-4000-8000-000000000099' });
    const result = yield* Effect.result(test.transport.approve(approvalOwnerTenantScope, request));
    expect(Result.isFailure(result) && result.failure._tag).toBe('ApprovalCommandRefused');
    expect(test.issued).toHaveLength(0);
    expect(test.sent).toHaveLength(0);
  }),
);

it.effect('refuses corrupted frozen data and mismatched proposal digests before identity or network work', () =>
  Effect.gen(function* refusesFrozenIntegrityLoss() {
    const test = yield* fixture();
    const invalid = {
      ...approvalOwnerFrozen,
      commandDigest: CommandDigestSchema.make('0'.repeat(64)),
    };
    for (const input of [
      { ...request, frozen: invalid },
      { ...request, frozen: invalid, proposal: { ...approvalOwnerProposal, commandDigest: invalid.commandDigest } },
      { ...request, proposal: { ...approvalOwnerProposal, tenantId: '00000000-0000-4000-8000-000000000099' } },
    ]) {
      expect(Result.isFailure(yield* Effect.result(test.transport.approve(approvalOwnerTenantScope, input)))).toBe(
        true,
      );
    }
    expect(test.observations.identities).toBe(0);
    expect(test.issued).toHaveLength(0);
    expect(test.sent).toHaveLength(0);
  }),
);

for (const [status, tag] of [
  [401, 'ApprovalCommandRefused'],
  [403, 'ApprovalCommandRefused'],
  [409, 'ApprovalCommandRefused'],
  [503, 'ApprovalPortUnavailable'],
  [500, 'ApprovalPortUnavailable'],
] as const) {
  it.effect(`preserves owner ${status} as ${tag} without returning its private problem body`, () =>
    Effect.gen(function* preservesOwnerFailureKind() {
      const test = yield* fixture({ body: 'private owner detail', status });
      const result = yield* Effect.result(test.transport.approve(approvalOwnerTenantScope, request));
      expect(Result.isFailure(result) && result.failure._tag).toBe(tag);
      expect(JSON.stringify(result)).not.toContain('private owner detail');
      if (status === 409 && Result.isFailure(result) && result.failure._tag === 'ApprovalCommandRefused') {
        expect(result.failure.code).toBe('revision_stale');
      }
    }),
  );
}

for (const body of [
  'malformed',
  JSON.stringify({ ...successBody, proposalId: '00000000-0000-4000-8000-000000000099' }),
  JSON.stringify({ ...successBody, status: 'executed' }),
  JSON.stringify({ ...successBody, actionAuthority: { private: true } }),
]) {
  it.effect('refuses malformed, mismatched or over-disclosing success instead of claiming approval', () =>
    Effect.gen(function* refusesUnverifiedAcknowledgement() {
      const test = yield* fixture({ body });
      const result = yield* Effect.result(test.transport.approve(approvalOwnerTenantScope, request));
      expect(Result.isFailure(result) && result.failure._tag).toBe('ApprovalPortUnavailable');
    }),
  );
}
