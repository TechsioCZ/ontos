// The CRM reach over canonical Authorization v2 answers (ADR-0030). The old model granted five
// `demo.crm.*` context-permission keys; this suite pins what replaced them: one record-scoped read
// whose granted selector is the reach, one scope-wide write Action whose record scope follows that
// read, and a separate reassignment authority.
import { expect, it } from 'effect-rstest';

import {
  canReadClient,
  canWriteAnything,
  canWriteClient,
  crmRecordSelectorOf,
  viewerFor,
} from '../../shared/domain/access.ts';
import {
  crmApplyCommandDeclaration,
  crmClientOwnerAssignGroup,
  crmRecordsReadDeclaration,
} from '../../shared/domain/access-declarations.ts';
import { EntityIdSchema, PrincipalIdSchema } from '../../shared/domain/common.ts';
import { PrincipalIdSchema as AccessPrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { Effect, Option, Schema } from 'effect';
import { crmRecordsGrants, finishCrmRecords } from '../../src/services/persistence.service.ts';
import { CrmStateSchema } from '../../shared/domain/state.ts';
import { scope, state } from './search-fixtures.ts';

const principal = (id: string) => PrincipalIdSchema.make(id);
const salesperson = (id: string) => EntityIdSchema.make(id);
const client = (ownerSalespersonId?: string) => ({ ownerSalespersonId });

it('declares one record-scoped read whose selectors are the reviewed CRM reaches', () => {
  expect(crmRecordsReadDeclaration).toMatchObject({
    key: 'demo.crm.api-records.read',
    kind: 'read',
    selectors: ['all', 'assigned', 'entrusted'],
  });
  // A scope-wide write Action, because a holder-relative Action selector is unsupported (R5a-7).
  expect(crmApplyCommandDeclaration).toMatchObject({ key: 'demo.crm.apply-command.write', selectors: [] });
  // Reassignment stays its own authority: the write Action's field group names the new owner.
  expect(crmClientOwnerAssignGroup).toMatchObject({
    fields: ['command.toSalespersonId'],
    key: 'demo.crm.client-owner.assign',
    kind: 'field_write',
  });
});

for (const tag of ['AssignedTo', 'EntrustedTo'] as const) {
  it.effect(`the ${tag} gate bounds records, direct lookup and contact search evidence to the caller`, () =>
    Effect.gen(function* ownerReach() {
      const gate = makeTestAccessDecision({
        answers: {
          'demo.crm.api-records.read': {
            outcome: 'ALLOWED',
            predicate: {
              groups: [
                {
                  clauses: [
                    {
                      conditions: [
                        {
                          _tag: tag,
                          holder: { _tag: 'Principal', principalId: AccessPrincipalIdSchema.make(scope.principalId) },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      });
      const grants = yield* crmRecordsGrants(scope).pipe(Effect.provideService(AccessDecisionGate, gate));
      const [original] = state.clients.items;
      if (original === undefined) {
        yield* Effect.die('Missing CRM fixture client');
        return;
      }
      const current = Schema.decodeUnknownSync(Schema.toType(CrmStateSchema))({
        ...state,
        clients: {
          ...state.clients,
          contacts: [
            ...state.clients.contacts,
            {
              ...state.clients.contacts[0],
              clientId: 'foreign-client',
              id: 'foreign-contact',
              name: 'Foreign contact',
            },
          ],
          items: [
            { ...original, ownerSalespersonId: 'own-rep' },
            { ...original, id: 'foreign-client', name: 'Foreign client', ownerSalespersonId: 'other-rep' },
          ],
        },
        salespeople: [
          { active: true, id: 'own-rep', name: 'Own rep', principalId: scope.principalId },
          {
            active: true,
            email: 'private@example.test',
            id: 'other-rep',
            name: 'Other rep',
            principalId: 'other-person',
          },
        ],
      });
      const loaded = Option.some({ revision: 1, state: yield* Schema.encodeEffect(CrmStateSchema)(current) });
      const records = yield* finishCrmRecords({}, loaded, grants, scope);
      expect(records.state.clients.items.map((item) => item.id)).toEqual([original.id]);
      expect(records.state.clients.contacts.map((item) => item.id)).toEqual(['contact-1']);
      expect(records.state.salespeople.map((person) => person.id)).toEqual(['own-rep']);
      const detail = yield* finishCrmRecords(
        { clientId: EntityIdSchema.make('foreign-client') },
        loaded,
        grants,
        scope,
      );
      expect(detail.state.clients.items).toEqual([]);
      expect(detail.state.clients.contacts).toEqual([]);
      expect(gate.askedLists[0]?.scope).toEqual(scope);
      expect(gate.askedLists[0]?.carrier.accessDeclaration?.key).toBe('demo.crm.api-records.read');
      expect(
        gate.askedDecisions.some((question) => question.carrier.accessDeclaration?.key === 'demo.crm.api-records.read'),
      ).toBe(false);
    }),
  );
}

it('a manager who reads every client changes every client and may reassign one', () => {
  const viewer = viewerFor(
    { assign: true, readSelector: 'all', write: true },
    principal('p-manager'),
    salesperson('sp-m'),
  );
  expect(viewer).toMatchObject({
    assign: true,
    readAll: true,
    readAssigned: false,
    writeAll: true,
    writeAssigned: false,
  });
  expect(canWriteAnything(viewer)).toBe(true);
  expect(canReadClient(viewer, client('sp-other'))).toBe(true);
  expect(canWriteClient(viewer, client('sp-other'))).toBe(true);
});

it('a salesperson reads and changes only the clients their own salesperson record owns', () => {
  const viewer = viewerFor(
    { assign: false, readSelector: 'assigned', write: true },
    principal('p-rep'),
    salesperson('sp-r'),
  );
  expect(viewer).toMatchObject({
    assign: false,
    readAll: false,
    readAssigned: true,
    writeAll: false,
    writeAssigned: true,
  });
  expect(canReadClient(viewer, client('sp-r'))).toBe(true);
  expect(canWriteClient(viewer, client('sp-r'))).toBe(true);
  expect(canReadClient(viewer, client('sp-other'))).toBe(false);
  expect(canWriteClient(viewer, client('sp-other'))).toBe(false);
  expect(canReadClient(viewer, client())).toBe(false);
});

it('an external partner reads only the clients entrusted to them and writes none', () => {
  const viewer = viewerFor(
    { assign: false, readSelector: 'entrusted', write: false },
    principal('p-ext'),
    salesperson('sp-e'),
  );
  expect(viewer).toMatchObject({ readAll: false, readAssigned: true, writeAll: false, writeAssigned: false });
  expect(canReadClient(viewer, client('sp-e'))).toBe(true);
  expect(canReadClient(viewer, client('sp-r'))).toBe(false);
  expect(canWriteAnything(viewer)).toBe(false);
  expect(canWriteClient(viewer, client('sp-e'))).toBe(false);
});

it('never turns a write answer into a write without a read reach', () => {
  const viewer = viewerFor({ assign: false, write: true }, principal('p-x'), salesperson('sp-x'));
  expect(viewer).toMatchObject({ readAll: false, readAssigned: false, writeAll: false, writeAssigned: false });
  expect(canWriteAnything(viewer)).toBe(false);
  expect(canReadClient(viewer, client('sp-x'))).toBe(false);
});

it('a salesperson with no salesperson record owns no client', () => {
  const viewer = viewerFor({ assign: false, readSelector: 'assigned', write: true }, principal('p-rep'));
  expect(viewer.salespersonId).toBeUndefined();
  expect(canReadClient(viewer, client('sp-r'))).toBe(false);
  expect(canWriteClient(viewer, client('sp-r'))).toBe(false);
});

it('reads the reach from the gate predicate, and an undescribable predicate reaches nothing', () => {
  const holder = {
    _tag: 'Principal',
    principalId: AccessPrincipalIdSchema.make('10000000-0000-4000-8000-000000000001'),
  } as const;
  expect(crmRecordSelectorOf({ groups: [] }, holder.principalId)).toBe('all');
  for (const tag of ['AssignedTo', 'EntrustedTo'] as const) {
    const condition = { _tag: tag, holder };
    expect(crmRecordSelectorOf({ groups: [{ clauses: [{ conditions: [condition] }] }] }, holder.principalId)).toBe(
      tag === 'AssignedTo' ? 'assigned' : 'entrusted',
    );
    expect(crmRecordSelectorOf({ groups: [{ clauses: [{ conditions: [condition] }] }] }, 'other')).toBeUndefined();
    expect(
      crmRecordSelectorOf(
        {
          groups: [
            {
              clauses: [
                { conditions: [condition, { _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make('client-one')] }] },
              ],
            },
          ],
        },
        holder.principalId,
      ),
    ).toBeUndefined();
  }
});

it.effect('never treats an allowed list without its predicate as whole-company CRM access', () =>
  Effect.gen(function* missingPredicate() {
    const gate = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } });
    const brokenListGate = {
      ...gate,
      list: (question: Parameters<typeof gate.list>[0]) =>
        gate.list(question).pipe(Effect.map(({ decision }) => ({ decision }))),
    };
    const grants = yield* crmRecordsGrants(scope).pipe(Effect.provideService(AccessDecisionGate, brokenListGate));
    expect(grants.readSelector).toBeUndefined();
    const records = yield* finishCrmRecords(
      {},
      Option.some({ revision: 1, state: yield* Schema.encodeEffect(CrmStateSchema)(state) }),
      grants,
      scope,
    );
    expect(records.state.clients.items).toEqual([]);
    expect(records.state.clients.contacts).toEqual([]);
    expect(records.viewer.readAll).toBe(false);
    expect(records.viewer.writeAll).toBe(false);
  }),
);
