import { fileURLToPath } from 'node:url';

import type { TrustedPrincipalContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { stableUuid } from '@app/core-runtime/access/catalog';
import { NodeServices } from '@effect/platform-node';
import { createEffectBffTestHandler } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { readAccessCatalogArtifact } from '../../../../scripts/authorization-catalog-artifact.mts';
import { policyReleaseEntries } from '../../../../scripts/demo/access-policy.mts';
import { demoModuleIds } from '../../../../scripts/demo/permissions.mts';
import {
  desiredState,
  observedCellOf,
  previewBody,
  previewIssue,
  saveBody,
  SaveRoleStep,
} from '../../../../scripts/demo/reviewed-people-plan.mts';
import type { DesiredRole } from '../../../../scripts/demo/reviewed-people-plan.mts';
import { AuthenticationService } from '../../api/auth/service.ts';
import type { AuthenticationServiceContract } from '../../api/auth/service.ts';
import { makeShellAuthenticationApiRuntime, shellProductionRuntimeArguments } from '../../api/index.ts';
import {
  AccessCompanyIdSchema,
  AccessRoleSchema,
  ListAccessRoleTemplatesResponseSchema,
  PreviewAccessRoleEditResponseSchema,
  SaveAccessRoleEditResponseSchema,
} from '../../shared/access-admin-api.ts';
import { shellAuthenticationApiContract } from '../../shared/api.ts';
import { accessAdminTemplateLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';

/*
 * The stage apply script's role phase through the production Shell API runtime, against one real-gate
 * case database: a reviewed role is created empty, the server's preview names exactly the dangerous
 * effects the script computes itself, a save missing one confirmation is refused, and the full save lands.
 * The script never echoes the preview's confirmations, so this is the proof that its own computation and
 * Core's agree on a real release. Ordering, halts and the allow-list are pinned by the planner's unit test.
 */

class ReviewedApplyFailure extends Schema.TaggedError<ReviewedApplyFailure>()('ReviewedApplyFailure', {
  reason: Schema.String,
}) {}

const PERSONA_HEADER = 'x-p14-persona';
const OWNER = 'owner';
const { apiPrefix } = shellAuthenticationApiContract;
const ROLE_KEY = 'warehouse';

const unsupported = (operation: string) =>
  Effect.fail(new ReviewedApplyFailure({ reason: `${operation} is not part of this suite` })).pipe(Effect.orDie);

/** Signs in the case owner for every request carrying the persona header; nothing else is used. */
const ownerAuthentication = (owner: TrustedPrincipalContext) => {
  const service: AuthenticationServiceContract = {
    availableTenants: () => unsupported('availableTenants'),
    createFixtureUser: () => unsupported('createFixtureUser'),
    currentSession: () => unsupported('currentSession'),
    resolveDocumentContext: () => Effect.die('Unexpected document authentication'),
    resolveShellContext: () => unsupported('resolveShellContext'),
    resolveTenantContext: (headers) =>
      Effect.succeed(
        headers.get(PERSONA_HEADER) === OWNER
          ? {
              identity: {
                displayName: 'Reviewed apply owner',
                email: 'owner@example.test',
                principalId: owner.principalId,
                tenantId: owner.tenantId,
              },
              principal: owner,
              setCookieHeaders: [],
              state: 'authenticated' as const,
            }
          : { setCookieHeaders: [], state: 'anonymous' as const },
      ),
    signIn: () => unsupported('signIn'),
    signOut: () => unsupported('signOut'),
    switchLegalEntity: () => unsupported('switchLegalEntity'),
    switchTenant: () => unsupported('switchTenant'),
    switchToTenantContext: () => Effect.die('Unexpected tenant switch'),
  };
  return Layer.succeed(AuthenticationService, service);
};

const shellHandlerFor = Effect.fn('ReviewedApply.handler')(function* shellHandler(accessCase: AccessAdminCase) {
  const scope = yield* accessCase.scopeFor(OWNER);
  const owner = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(scope).pipe(Effect.orDie);
  const [, issuer, moduleStates] = shellProductionRuntimeArguments;
  const runtime = makeShellAuthenticationApiRuntime(
    ownerAuthentication(owner),
    issuer,
    moduleStates,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    accessCase.databases,
  );
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      catch: () => new ReviewedApplyFailure({ reason: 'The Shell API handler could not be created' }),
      try: async () => await createEffectBffTestHandler({ module: { default: runtime }, prefix: apiPrefix }),
    }),
    (handler) => Effect.promise(handler.dispose.bind(handler)),
  );
});
type ShellHandler = Effect.Success<ReturnType<typeof shellHandlerFor>>;

/** One JSON POST as the stage script sends it: the owner's session, and an idempotency key on writes. */
const post = Effect.fn('ReviewedApply.post')(function* postJson(
  handler: ShellHandler,
  input: { readonly idempotencyKey?: string; readonly path: string; readonly payload: object },
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input.payload).pipe(Effect.orDie);
  const headers = { 'content-type': 'application/json', [PERSONA_HEADER]: OWNER };
  const response = yield* Effect.tryPromise({
    catch: () => new ReviewedApplyFailure({ reason: `POST ${input.path} did not answer` }),
    try: async () =>
      await handler.handler(
        new Request(`http://shell.test${apiPrefix}${input.path}`, {
          body,
          headers:
            input.idempotencyKey === undefined ? headers : { ...headers, 'idempotency-key': input.idempotencyKey },
          method: 'POST',
        }),
      ),
  });
  const text = yield* Effect.promise(async () => await response.text());
  return { status: response.status, text };
});

const decodeOk = <Value, Encoded>(
  schema: Schema.Codec<Value, Encoded>,
  answer: { readonly status: number; readonly text: string },
) => {
  expect({ status: answer.status, text: answer.status === 200 ? '' : answer.text }).toEqual({ status: 200, text: '' });
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(answer.text).pipe(Effect.orDie);
};

/** The reviewed warehouse role exactly as the stage script compiles it from the checked-in release. */
const reviewedRole = Effect.gen(function* reviewedWarehouseRole() {
  const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../../../../', import.meta.url)));
  const entries = yield* Effect.fromResult(policyReleaseEntries(modules, demoModuleIds));
  const desired = yield* Effect.fromResult(desiredState(entries));
  return yield* Effect.fromOption(Option.fromUndefinedOr(desired.roles.find(({ key }) => key === ROLE_KEY)));
}).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

type WireCell = (typeof AccessRoleSchema.Type)['cells'][number];
/** Core's slot key of a cell as the Shell answers it. */
const wireSlot = (cell: WireCell): string => `${cell.capabilityKey} ${cell.mode} ${cell.selector._tag}`;
const toObserved = (cells: readonly WireCell[]) => cells.map((cell) => ({ plain: true, slot: wireSlot(cell) }));

const saveStepOf = (role: DesiredRole, roleId: (typeof AccessRoleSchema.Type)['id'], snapshot: string) =>
  SaveRoleStep.make({
    // A role saved for the first time adds every one of its cells.
    addedCells: role.cells,
    adminCells: role.adminCells,
    catalogSnapshotId: Schema.decodeUnknownSync(AccessRoleSchema.fields.catalogSnapshotId)(snapshot),
    cells: role.cells,
    confirmations: role.confirmations,
    expectedRoleRevisionId: Option.none(),
    idempotencyKey: role.saveKey,
    roleId,
    roleKey: role.key,
  });

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '300 seconds' })(
  'the reviewed people apply through the Shell API',
  (suite) => {
    suite.effect(
      'saves a reviewed role only with every confirmation the script computes, as the preview names them',
      () =>
        withAccessAdminCase((accessCase) =>
          Effect.scoped(
            Effect.gen(function* reviewedRoleSave() {
              const handler = yield* shellHandlerFor(accessCase);
              const role = yield* reviewedRole;
              expect([role.cells.length, role.confirmations.length]).toEqual([33, 23]);
              const [companyA] = accessCase.companies;
              const legalEntityId = AccessCompanyIdSchema.make(companyA ?? '');

              const release = yield* decodeOk(
                ListAccessRoleTemplatesResponseSchema,
                yield* post(handler, { path: '/shell/access/roles/templates', payload: { limit: 100 } }),
              );
              const created = yield* decodeOk(
                AccessRoleSchema,
                yield* post(handler, {
                  idempotencyKey: role.createKey,
                  path: '/shell/access/roles/create',
                  payload: {
                    catalogSnapshotId: release.catalogSnapshotId,
                    cells: [],
                    name: role.name,
                    scope: { kind: 'company', legalEntityId },
                    templateKey: 'blank',
                  },
                }),
              );
              // The script finds its roles again by this rule, so a different id would make it create twice.
              expect(created.id).toBe(
                stableUuid(['ontos.shell.access-roles.role', accessCase.tenantId, role.createKey].join(':')),
              );

              const step = saveStepOf(role, created.id, created.catalogSnapshotId);
              const preview = yield* decodeOk(
                PreviewAccessRoleEditResponseSchema,
                yield* post(handler, {
                  path: '/shell/access/roles/preview',
                  payload: previewBody(step, created.revisionId),
                }),
              );
              expect(
                previewIssue(step, {
                  added: toObserved(preview.added),
                  affectedHolders: [],
                  cells: toObserved(preview.cells),
                  dangerous: preview.dangerous.map(({ effect, slot }) => ({ effect, slot })),
                  removed: toObserved(preview.removed),
                }),
              ).toBeUndefined();

              const [, ...allButOne] = role.confirmations;
              const missing = yield* post(handler, {
                idempotencyKey: `${role.saveKey}:missing-one`,
                path: '/shell/access/roles/save',
                payload: { ...saveBody(step, created.revisionId, preview.previewToken), confirmedEffects: allButOne },
              });
              expect(missing.status).toBe(422);
              expect(missing.text).toContain('access_changes_sensitive_requires_individual_decision');

              const saved = yield* decodeOk(
                SaveAccessRoleEditResponseSchema,
                yield* post(handler, {
                  idempotencyKey: role.saveKey,
                  path: '/shell/access/roles/save',
                  payload: saveBody(step, created.revisionId, preview.previewToken),
                }),
              );
              expect(saved.role.cells.map(wireSlot).toSorted()).toEqual(
                role.cells.map((cell) => observedCellOf(cell).slot).toSorted(),
              );
            }),
          ),
        ),
    );
  },
);
