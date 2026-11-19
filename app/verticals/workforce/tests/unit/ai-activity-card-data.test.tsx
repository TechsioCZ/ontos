// @rstest-environment happy-dom
import { acted, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { AiActivityCard } from '../../src/routes/[lang]/prodej/zamestnanci/ai-activity-card.tsx';
import { aiActivityData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';
import { mountInRoute } from '../support/module-ui.ts';

const company = '20000000-0000-4000-8000-000000000001';
const otherCompany = '20000000-0000-4000-8000-000000000002';
const records = (actorDisplayName: string, includeActivity: boolean) => {
  const response = {
    actorPrincipalRef: {
      principalId: '30000000-0000-4000-8000-000000000001',
      tenantId: '10000000-0000-4000-8000-000000000001',
    },
    availablePrincipals: [],
    canWrite: true,
    indicators: {
      active: 0,
      byDepartment: [],
      byRole: { ACCOUNTANT: 0, SALES_HEAD: 0, SALES_REP: 0, SUPPORT: 0, WAREHOUSE: 0 },
      total: 0,
    },
    items: [],
    revision: 1,
  };
  if (!includeActivity) {
    return Schema.decodeUnknownSync(RecordsResponseSchema)(response);
  }
  return Schema.decodeUnknownSync(RecordsResponseSchema)({
    ...response,
    aiActivity: [
      {
        actionKey: null,
        actorDisplayName,
        actorKind: 'agent',
        actorPrincipalId: 'activity-principal',
        auditEventId: actorDisplayName,
        occurredAt: '2026-11-19T09:00:00.000Z',
        outcome: 'succeeded',
        outcomeCode: 'ok',
        outcomeStage: 'completed',
        targetModuleKey: null,
      },
    ],
  });
};

const reads: RecordsRequest[] = [];
let actor = 'AI agent C – první';
const OwnerApi = RecordsApi.prefix('/workforce-api');
const network = browserNetwork(
  shellGatewayIssuer({ workforce: '/workforce-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return records(actor, payload.includeAiActivity === true);
        }),
      ),
    ),
  ),
);

afterEach(unmountAll);

it.live('mounting the activity card requests its feed and a live change reloads only the displayed company', () =>
  Effect.gen(function* displayedActivity() {
    yield* pinTestDocument;
    aiActivityData.invalidate();
    reads.length = 0;
    actor = 'AI agent C – první';
    yield* aiActivityData.preload(otherCompany);
    yield* mountInRoute(<AiActivityCard legalEntityId={company} />, { url: '/cs/prodej/zamestnanci' });
    yield* waitUntil(() => document.querySelector('tbody') !== null);
    yield* networkIdle;
    expect(document.querySelector('tbody')?.textContent).toContain('AI agent C – první');
    expect(reads).toEqual([{ includeAiActivity: true }, { includeAiActivity: true }]);
    const inactiveBeforeChange = aiActivityData.snapshot(otherCompany);

    actor = 'AI agent C – druhý';
    yield* acted(() => {
      window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['crm'] } }));
    });
    yield* waitUntil(() => document.querySelector('tbody')?.textContent?.includes('AI agent C – druhý') === true);
    yield* networkIdle;
    expect(reads).toEqual([{ includeAiActivity: true }, { includeAiActivity: true }, { includeAiActivity: true }]);
    expect(aiActivityData.snapshot(otherCompany)).toEqual(inactiveBeforeChange);
    expect(document.querySelector('tbody')?.textContent).not.toContain('AI agent C – první');
  }).pipe(Effect.provide(network)),
);
