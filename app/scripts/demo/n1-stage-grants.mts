#!/usr/bin/env node
/**
 * N1 stage access: the reviewed access file stays the source of truth, and the retired legacy plan is refused.
 *
 * The retired command derived an N1 role/action policy from public contracts and wrote scoped-role, action-grant and
 * module-access relations, then revoked every relation its plan did not desire. Authorization v2 retired all of that
 * (`ADR-0030`): service, integration and system principals never appear in a v2 tuple, the engine schema is fixed, and
 * every role policy is intent in PostgreSQL that one Core writer projects. Deleting live relationships is not part of
 * a release, so the command refuses before it reads or writes the engine and names the canonical remediation.
 *
 * The reviewed identities and modules in `n1-stage-access.json` remain the input a canonical N1 rebuild consumes.
 */
import { createHash } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import { demoId } from './fixture-ids.mts';
import type { CommercePortalWorkload } from './permissions.mts';

export const N1_TENANT_ID = 'cfcd7ae8-90b9-4c49-927c-b5d66224a618';
export const N1_LEGAL_ENTITY_ID = 'd7ad363a-ddb0-46c6-bb11-8d9362281297';
export const N1_STAGE_ORIGIN = 'https://ontos-stage.web-revolution.cz';
const merchandise = 'demo.merchandise';
const markets = 'commerce.market-catalog';
const registry = 'commerce.storefront-registry';
const workTasks = 'work.tasks';
const commerce = 'commerce.customer-context';
const party = 'party.registry';
const commercePortalName = 'n1-commerce-portal';
/** Prospective native identity; only the reviewed installer creates/adopts it. Never a live-state assertion. */
export const n1CommercePortal: CommercePortalWorkload = {
  apiKeyName: commercePortalName,
  displayName: commercePortalName,
  legalEntityId: N1_LEGAL_ENTITY_ID,
  principalId: demoId('core.principal', commercePortalName),
  roleKey: commercePortalName,
  tenantId: N1_TENANT_ID,
};
export const n1ManifestSources = [
  { appId: 'merchandise', moduleId: merchandise },
  { appId: 'commerce-market-catalog', moduleId: markets },
  { appId: 'storefront-registry', moduleId: registry },
  { appId: 'work-tasks', moduleId: workTasks },
  { appId: 'commerce-customer-context', moduleId: commerce },
  { appId: 'party-registry', moduleId: party },
] as const;
const modes = ['plan', 'apply', 'verify'] as const;
type Mode = (typeof modes)[number];
const uuid = Schema.String.check(Schema.isUUID());
const PrincipalIdSchema = uuid.pipe(Schema.brand('PrincipalId'));

export class N1StageGrantError extends Schema.TaggedError<N1StageGrantError>()('N1StageGrantError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new N1StageGrantError({ reason });
export const n1PlanFingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

/** Deliberately projects away passwords and every unrelated access-file field. */
export const N1AccessSchema = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      displayName: Schema.Trim.check(Schema.isNonEmpty()),
      email: Schema.Literals(['admin@n1.ontos.demo', 'catalog@n1.ontos.demo']),
      principalId: Schema.toEncoded(PrincipalIdSchema),
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
  legalEntityId: Schema.Literal(N1_LEGAL_ENTITY_ID),
  modules: Schema.Struct({
    [markets]: uuid,
    [merchandise]: uuid,
    [registry]: uuid,
  }),
  schemaVersion: Schema.Literal(1),
  services: Schema.Struct({ 'market-authority': uuid, storefront: uuid }),
  shellUrl: Schema.Literal(N1_STAGE_ORIGIN),
  slug: Schema.Literal('n1-demo-20261103'),
  tenantId: Schema.Literal(N1_TENANT_ID),
});
export type N1Access = typeof N1AccessSchema.Type;

/**
 * The reviewed identities must be distinct, must contain both authorized accounts, and must never reuse the demo
 * principals or the N1 Tenant/company themselves.
 */
export const decodeN1Access = (source: string) =>
  Schema.decodeEffect(Schema.fromJsonString(N1AccessSchema))(source).pipe(
    Effect.mapError(() => fail('The N1 access file has an invalid target or identity shape; values withheld')),
    Effect.flatMap((access) => {
      const ids = [...access.accounts.map(({ principalId }) => principalId), ...Object.values(access.services)];
      const reserved = new Set([N1_TENANT_ID, N1_LEGAL_ENTITY_ID, n1CommercePortal.principalId]);
      return new Set(ids).size !== 4 ||
        new Set(access.accounts.map(({ email }) => email)).size !== 2 ||
        ids.some((id) => reserved.has(id)) ||
        new Set(Object.values(access.modules)).size !== 3
        ? Effect.fail(fail('N1 identities must be distinct, new, and contain both authorized accounts'))
        : Effect.succeed(access);
    }),
  );

/** The retired N1 plan has no v2 translation and no import step (`ADR-0030`). */
export const RETIRED_N1_GRANT_REMEDIATION =
  'The legacy N1 stage plan (scoped_role, action_grant, module_access role relations and its revocations) is retired by ADR-0030 and has no translation. Rebuild the reviewed N1 identities in `scripts/demo/n1-stage-access.json` as canonical Roles, Assignments and workload bindings through the canonical stage bootstrap, and grant nothing else.';

/** Fails closed before any engine read or write. */
export const refuseRetiredN1Grants = (mode: Mode) =>
  Effect.gen(function* refuseRetired() {
    yield* Console.error(`N1 stage grants ${mode}: the legacy N1 plan is retired; the engine was not read or written.`);
    return yield* fail(`The legacy N1 stage plan cannot be applied (mode=${mode}). ${RETIRED_N1_GRANT_REMEDIATION}`);
  });

const readPrivateFile = (path: string) =>
  Effect.gen(function* readPrivate() {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(path);
    if (stat.type !== 'File' || stat.mode % 0o100 !== 0 || stat.size > 4_000_000n) {
      return yield* fail('N1 input and plan must be bounded owner-only regular files, mode 600');
    }
    return yield* fs.readFileString(path);
  });

const run = (mode: Mode, _planPath: string) =>
  Effect.gen(function* provisionN1() {
    yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    // The reviewed access file is still validated, so an invalid review is refused before the retirement notice.
    const input = yield* readPrivateFile(yield* Config.String('N1_ACCESS_FILE')).pipe(
      Effect.flatMap(decodeN1Access),
      Effect.mapError(() => fail('N1_ACCESS_FILE could not be privately decoded; values withheld')),
    );
    yield* Console.log({ accounts: input.accounts.length, mode, tenantId: N1_TENANT_ID });
    return yield* refuseRetiredN1Grants(mode);
  }).pipe(Effect.scoped);

const command = Command.make(
  'n1-stage-grants',
  {
    mode: Flag.Literals('mode', modes),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, plan }) =>
    run(mode, plan).pipe(
      Effect.tapError(
        Effect.fnUntraced(function* reportN1Failure(failure) {
          return yield* Console.error(
            Schema.is(N1StageGrantError)(failure)
              ? failure.reason
              : `N1 grants stopped (${failure._tag}); credentials withheld`,
          );
        }),
      ),
    ),
);

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
