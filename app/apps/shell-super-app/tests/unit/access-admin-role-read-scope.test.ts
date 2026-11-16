import type { OperationalScope } from '@app/core-runtime';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/access/changes/role-revision';
import type { AccessDecision } from '@app/core-runtime/access/decision/contract';
import type { AccessDecisionService, GateInput } from '@app/core-runtime/access/enforcement';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { Match, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { accessPeopleDeclarations } from '../../api/access-admin/people.ts';
import { roleReadScope } from '../../api/access-admin/role-read-scope.ts';

/*
 * One People or Role read's own admission: the tenant context and every candidate company, each in its own scope,
 * asked in ONE gate batch. The questions and the answer are the ones the per-company loop asked and gave; one
 * unreadable answer anywhere refuses the read (503), never a smaller answer.
 */

const uuid = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const TENANT = uuid(1);
const COMPANIES = [uuid(13), uuid(11), uuid(12), uuid(11)] as const;
const NOW = new Date(Date.UTC(2026, 10, 13, 9));

const scope: OperationalScope = Object.freeze({
  authBindingId: 'binding-1',
  authContextRef: 'session-1',
  authMethod: 'session' as const,
  correlationId: 'people-read-admission',
  principalId: PrincipalIdSchema.make(uuid(7)),
  tenantId: TenantIdSchema.make(TENANT),
});

type Outcome = AccessDecision['outcome'];

const decision = (outcome: Outcome): AccessDecision => ({
  evidence: [],
  outcome,
  reasons: [{ code: outcome === 'ALLOWED' ? 'allow.granted' : 'deny.insufficient_grant' }],
  selectors: [],
});

/** A gate that answers each context as scripted and records every call it receives. */
const scriptedGate = (answers: Readonly<Record<string, Outcome>>) => {
  const singles: GateInput[] = [];
  const batches: (readonly GateInput[])[] = [];
  const answerOf = (input: GateInput) => decision(answers[input.scope.legalEntityId ?? 'tenant'] ?? 'DENIED');
  const service: AccessDecisionService = {
    ...makeTestAccessDecision(),
    decide: (input) =>
      Effect.sync(() => {
        singles.push(input);
        return answerOf(input);
      }),
    decideMany: (inputs) =>
      Effect.sync(() => {
        batches.push(inputs);
        return inputs.map(answerOf);
      }),
  };
  return { batches, service, singles };
};

const readScope = (gate: AccessDecisionService) =>
  roleReadScope({
    companies: COMPANIES,
    declaration: accessPeopleDeclarations.list,
    now: NOW,
    scope,
  }).pipe(Effect.provideService(AccessDecisionGate, gate));

it.effect('asks the tenant and every candidate company in one gate batch, each in its own scope', () =>
  Effect.gen(function* oneBatch() {
    const gate = scriptedGate({
      tenant: 'ALLOWED',
      [uuid(11)]: 'ALLOWED',
      [uuid(12)]: 'DENIED',
      [uuid(13)]: 'ALLOWED',
    });
    const readable = yield* readScope(gate.service);
    expect(readable).toEqual({ companies: new Set([uuid(11), uuid(13)]), tenant: true });
    expect(gate.singles).toHaveLength(0);
    expect(gate.batches).toHaveLength(1);
    const [batch = []] = gate.batches;
    // The same questions the loop asked: the tenant context, then each company once, sorted, in its required scope.
    expect(
      batch.map((input) => [
        input.scope.legalEntityId ?? null,
        input.legalEntityScope,
        input.carrier.accessDeclaration,
      ]),
    ).toEqual([
      [null, 'optional', accessPeopleDeclarations.list],
      [uuid(11), 'required', accessPeopleDeclarations.list],
      [uuid(12), 'required', accessPeopleDeclarations.list],
      [uuid(13), 'required', accessPeopleDeclarations.list],
    ]);
    expect(batch.every((input) => input.now === NOW && input.scope.tenantId === scope.tenantId)).toBe(true);
  }),
);

it.effect('a denied tenant context keeps only the companies that admitted the read', () =>
  Effect.gen(function* companiesOnly() {
    const gate = scriptedGate({ [uuid(12)]: 'ALLOWED' });
    expect(yield* readScope(gate.service)).toEqual({ companies: new Set([uuid(12)]), tenant: false });
  }),
);

for (const unreadable of ['tenant', uuid(11), uuid(13)] as const) {
  it.effect(`refuses the whole read as unavailable when one context is unreadable: ${unreadable}`, () =>
    Effect.gen(function* failClosed() {
      const answers = Object.fromEntries(
        ['tenant', uuid(11), uuid(12), uuid(13)].map((context): readonly [string, Outcome] => [
          context,
          context === unreadable ? 'UNAVAILABLE' : 'ALLOWED',
        ]),
      );
      const gate = scriptedGate(answers);
      const failure = yield* Effect.flip(readScope(gate.service));
      expect(
        Match.value(failure).pipe(
          Match.tag('AccessAdminUnavailable', ({ status }) => status),
          Match.orElse(() => null),
        ),
      ).toBe(503);
    }),
  );
}

it.effect('refuses as unavailable when the gate answers fewer questions than it was asked', () =>
  Effect.gen(function* shortAnswer() {
    const gate = scriptedGate({ tenant: 'ALLOWED' });
    const short: AccessDecisionService = {
      ...gate.service,
      decideMany: (inputs) => Effect.succeed(inputs.slice(1).map(() => decision('ALLOWED'))),
    };
    const failure = yield* Effect.flip(readScope(short));
    expect(
      Match.value(failure).pipe(
        Match.tag('AccessAdminUnavailable', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
  }),
);
