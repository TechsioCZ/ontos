#!/usr/bin/env node
/** Stage-only, reviewed archival of one exact QA visit through the CRM Action. No SQL or fixture reset. */
import { createHash } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { CrmCommandSchema } from '../../verticals/crm/shared/actions/apply-command.ts';
import { VisitSchema } from '../../verticals/crm/shared/domain/visits.ts';
import type { Visit } from '../../verticals/crm/shared/domain/visits.ts';
import { demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import { connectSeedClient, DemoSeedError } from './seed-client.mts';

const origin = 'https://ontos-stage.web-revolution.cz';
const target = { legalEntityId: rentalDemoLegalEntityId, shellUrl: origin, tenantId: demoTenantId };
export const rehearsalQaVisitTitle = 'QA ověření předání 6e67196c – oprava ověřena';
const reason = 'Archivace testovacího záznamu po ověření ukázky; původní obsah i historie oprav zůstávají zachovány.';
const RecordsSchema = Schema.Struct({
  revision: Schema.Int,
  state: Schema.Struct({ visits: Schema.Struct({ items: Schema.Array(VisitSchema) }) }),
});
const PlanSchema = Schema.Struct({
  company: Schema.Literal(rentalDemoLegalEntityId),
  reason: Schema.Literal(reason),
  revision: Schema.Int,
  tenant: Schema.Literal(demoTenantId),
  visit: VisitSchema,
});
export type VisitStagePlan = typeof PlanSchema.Type;
export const visitStageFingerprint = (plan: VisitStagePlan) =>
  Schema.encodeEffect(Schema.fromJsonString(PlanSchema))(plan).pipe(
    Effect.map((encoded) => createHash('sha256').update(encoded).digest('hex')),
  );
export const selectRehearsalQaVisit = (visits: readonly Visit[]) =>
  Effect.gen(function* exactQaVisit() {
    const found = visits.filter((visit) => visit.archive === undefined && visit.result === rehearsalQaVisitTitle);
    if (found.length > 1) {
      return yield* new DemoSeedError({ reason: 'Ambiguous QA visit; nothing archived' });
    }
    return found[0];
  });
const run = (mode: 'plan' | 'apply' | 'verify', planPath: string, reviewed: Option.Option<string>) =>
  Effect.gen(function* archiveStageVisit() {
    yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    yield* Config.schema(Schema.Literal(origin), 'ONTOS_PUBLIC_ORIGIN');
    const password = yield* Config.Redacted('ONTOS_AGENT_SETUP_PASSWORD');
    const fs = yield* FileSystem.FileSystem;
    const client = yield* connectSeedClient(target, 'management@najempark.demo', password);
    const snapshot = yield* client.read('crm', RecordsSchema);
    if (mode === 'plan') {
      const visit = yield* selectRehearsalQaVisit(snapshot.state.visits.items);
      if (visit === undefined) {
        return yield* Console.log({ message: 'No active QA visit; no write needed', missing: true, mode });
      }
      const plan: VisitStagePlan = {
        company: rentalDemoLegalEntityId,
        reason,
        revision: snapshot.revision,
        tenant: demoTenantId,
        visit,
      };
      yield* fs.writeFileString(planPath, yield* Schema.encodeEffect(Schema.fromJsonString(PlanSchema))(plan), {
        flag: 'wx',
        mode: 0o600,
      });
      return yield* Console.log({
        fingerprint: yield* visitStageFingerprint(plan),
        mode,
        reason,
        result: visit.result,
        visitId: visit.id,
      });
    }
    const plan = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PlanSchema))(
      yield* fs.readFileString(planPath),
    );
    const fingerprint = yield* visitStageFingerprint(plan);
    if (Option.isNone(reviewed) || reviewed.value !== fingerprint) {
      return yield* new DemoSeedError({ reason: 'Exact reviewed QA-visit fingerprint required' });
    }
    const active = snapshot.state.visits.items.find((visit) => visit.id === plan.visit.id);
    if (mode === 'apply' && active !== undefined) {
      const current: VisitStagePlan = { ...plan, revision: snapshot.revision, visit: active };
      if ((yield* visitStageFingerprint(current)) !== fingerprint) {
        return yield* new DemoSeedError({ reason: 'QA visit changed after review; no write performed' });
      }
      yield* client.apply(
        'crm',
        Schema.toEncoded(CrmCommandSchema),
        { _tag: 'ArchiveVisit', reason, visitId: plan.visit.id },
        plan.revision,
      );
    }
    const after = yield* client.read('crm', RecordsSchema);
    if (
      after.state.visits.items.some((visit) => visit.id === plan.visit.id || visit.result === rehearsalQaVisitTitle)
    ) {
      return yield* new DemoSeedError({ reason: 'QA visit remains in the active timeline' });
    }
    return yield* Console.log({
      activeQaVisits: 0,
      archivedVisitId: plan.visit.id,
      mode,
      retainedAuditEvidence: true,
      revision: after.revision,
    });
  }).pipe(Effect.scoped);
const command = Command.make(
  'siampark-visit-stage',
  {
    mode: Flag.Literals('mode', ['plan', 'apply', 'verify']),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, plan, reviewed }) =>
    run(mode, plan, reviewed).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoSeedError)(failure) ? failure.reason : 'QA visit archival stopped; credentials withheld',
        ),
      ),
    ),
);
if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
