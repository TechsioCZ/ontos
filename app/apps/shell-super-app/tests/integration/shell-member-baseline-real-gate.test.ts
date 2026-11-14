import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  DECISION_AT,
  accessAdminTemplateLayer,
  shellHttpFor,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, Persona } from '../support/access-admin-real-gate-fixture.ts';
import { installedReleaseComposition } from '../support/installed-release-composition.ts';
import { EntrypointKeySchema, ModuleIdSchema } from '../../shared/browser-api.ts';

/*
 * Loading the product, end to end on a tenant shaped like stage: the shipped schema, no legacy relationship, and a
 * person whose only Role is an ordinary one (company A's tasks role, as Obchodník, Účetní and Skladník hold their
 * presets). The frame asks `core.shell.composition.read` and `core.shell.module-target.resolve`, which no Role but
 * "Plný přístup" holds, so on trunk every role-based person got 403 on the frame itself (`deny.insufficient_grant`).
 *
 * Those capabilities are declared baseline (`AccessDeclaration.baseline`): a person refused them for want of a grant
 * is still admitted as a member of the company they ask in, which the graph proves (`structural.member_baseline`). No
 * Role changes. Each page and contribution is still decided by its own right: an admin page stays refused, a person
 * with no access in the company and another tenant's person get nothing, and an agent holds no administration.
 */

const MEMBER: Persona = 'manager';
const FRAME_KEYS = ['core.shell.composition.read', 'core.shell.module-target.resolve'] as const;
const CASE_TIMEOUT = 300_000;

type ShellHttp = Effect.Success<ReturnType<typeof shellHttpFor>>;

const NavigationItemSchema = Schema.Struct({ entrypointKey: EntrypointKeySchema, moduleId: ModuleIdSchema });
type PageTarget = typeof NavigationItemSchema.Type;
const CompositionAnswerSchema = Schema.fromJsonString(
  Schema.Struct({ navigation: Schema.Array(NavigationItemSchema), state: Schema.String }),
);

/** The composition one person gets in one company: its state and its navigation, sorted by entrypoint key. */
const compositionOf = Effect.fn('ShellBaseline.compositionOf')(function* compositionOf(
  shell: ShellHttp,
  legalEntityId: string,
  persona: Persona,
) {
  const answer = yield* shell.get({ legalEntityId, path: '/shell/composition', persona });
  if (answer.status !== 200) {
    return { navigation: [], state: `HTTP ${answer.status}` };
  }
  const { navigation, state } = yield* Schema.decodeUnknownEffect(CompositionAnswerSchema)(answer.text).pipe(
    Effect.orDie,
  );
  return {
    navigation: navigation
      .map(({ entrypointKey, moduleId }) => ({ entrypointKey, moduleId }))
      .toSorted((left, right) => left.entrypointKey.localeCompare(right.entrypointKey)),
    state,
  };
});

/** The entrypoint keys of one composition's navigation, in order. */
const keysOf = ({ navigation }: { readonly navigation: readonly PageTarget[] }) =>
  navigation.map(({ entrypointKey }) => entrypointKey);

/** What loading the Shell in one company answers this person, endpoint by endpoint. */
const frameOf = (shell: ShellHttp, legalEntityId: string, persona: Persona, page: PageTarget) =>
  Effect.all(
    {
      // The document context and the tenant list are not served by this fixture's session stub; the document context
      // reads the same composition, so its answer follows `composition`.
      composition: shell.get({ legalEntityId, path: '/shell/composition', persona }),
      legalEntities: shell.get({ legalEntityId, path: '/auth/legal-entities', persona }),
      moduleTarget: shell.post({ legalEntityId, path: '/shell/module-target', payload: page, persona }),
      session: shell.get({ legalEntityId, path: '/auth/session', persona }),
    },
    { concurrency: 1 },
  ).pipe(
    Effect.map((answers) =>
      Object.fromEntries(Object.entries(answers).map(([endpoint, { status }]) => [endpoint, status] as const)),
    ),
  );

/** The gate's answer and reason codes for one frame capability, asked for this person in company A. */
const frameDecision = Effect.fn('ShellBaseline.frameDecision')(function* frameDecision(
  accessCase: AccessAdminCase,
  persona: Persona,
  key: string,
  company?: string,
) {
  const [first = ''] = accessCase.companies;
  const ours = company ?? first;
  const declaration = accessCase.declarations.get(key);
  if (declaration === undefined) {
    return yield* Effect.die(new Error(`${key} is not published`));
  }
  const decision = yield* accessCase.gate.decide({
    carrier: { accessDeclaration: declaration },
    legalEntityScope: 'required',
    now: DECISION_AT,
    scope: yield* accessCase.scopeFor(persona, ours),
  });
  return { codes: decision.reasons.map(({ code }) => code), key, outcome: decision.outcome };
});

/** The frame's answer for the people whose membership, not their Roles, decides it. */
const membershipCasesOf = Effect.fn('ShellBaseline.membershipCases')(function* membershipCasesOf(
  accessCase: AccessAdminCase,
) {
  const [ours = '', other = ''] = accessCase.companies;
  const cases: readonly (readonly [Persona, string])[] = [
    ['suspended', ours],
    ['lapsed', other],
    ['directoryMember', ours],
    ['departed', ours],
    ['companyAdmin', other],
    ['expiredAssignment', ours],
  ];
  return yield* Effect.forEach(
    cases,
    ([persona, company]) =>
      Effect.forEach(FRAME_KEYS, (key) => frameDecision(accessCase, persona, key, company), { concurrency: 1 }).pipe(
        Effect.map((decisions) => ({ allowed: decisions.map(({ outcome }) => outcome === 'ALLOWED'), persona })),
      ),
    { concurrency: 1 },
  );
});

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'loading the Shell as a member with an ordinary Role',
  (suite) => {
    suite.effect(
      'a member loads the frame without a Role granting it; pages, admin and other people stay decided by their own rights',
      () =>
        withAccessAdminCase((accessCase) =>
          Effect.scoped(
            Effect.gen(function* memberLoadsShell() {
              const [ours = ''] = accessCase.companies;
              const installed = yield* installedReleaseComposition;
              // The release publisher's active authority row for the installed composition, so the frame's own
              // reads are admitted end to end and answer 200.
              yield* accessCase.admin
                .unsafe(
                  `insert into core.application_composition_authority
                     (authority_key, revision, phase, valid_until, subscriptions_json)
                   values ('active', $1, 'active', now() + interval '1 day', '[]'::jsonb)
                   on conflict (authority_key) do update set revision = excluded.revision, phase = 'active',
                     valid_until = excluded.valid_until`,
                  [installed.composition.revision],
                )
                .pipe(Effect.orDie);
              const shell = yield* shellHttpFor(accessCase, installed, 'frame');

              // The Role grants neither frame capability: the gate refuses the cell and admits the member structurally.
              const frameDecisions = yield* Effect.all(
                FRAME_KEYS.map((key) => frameDecision(accessCase, MEMBER, key)),
                { concurrency: 1 },
              );
              expect(frameDecisions).toEqual(
                FRAME_KEYS.map((key) => ({ codes: ['structural.member_baseline'], key, outcome: 'ALLOWED' })),
              );
              // End to end the member gets a 200 composition filtered by each contribution's own right: of the
              // owner's 30-odd module pages only the one any signed-in person may open (the tasks Role's key names
              // the tasks home, which is no navigation item). The Shell's administration is no composition item.
              const memberComposition = yield* compositionOf(shell, ours, MEMBER);
              const ownerComposition = yield* compositionOf(shell, ours, 'owner');
              expect({ member: memberComposition.state, owner: ownerComposition.state }).toEqual({
                member: 'available',
                owner: 'available',
              });
              expect(keysOf(memberComposition)).toEqual(['projects.core.page.create-project']);
              expect(keysOf(ownerComposition)).toContain('projects.core.page.create-project');
              expect(keysOf(ownerComposition).length).toBeGreaterThan(20);
              // The rest of the frame, opening that page: the member's answers are the owner's, never a refusal.
              const page =
                memberComposition.navigation[0] ??
                (yield* Effect.die(new Error('the member composition names no page')));
              const frame = yield* frameOf(shell, ours, MEMBER, page);
              expect(frame).toEqual({ composition: 200, legalEntities: 200, moduleTarget: 200, session: 200 });
              expect(yield* frameOf(shell, ours, 'owner', page)).toEqual(frame);
              // Evidence: every fallback admission leaves its decision row, routine read or not.
              const evidence = yield* accessCase.admin
                .unsafe<{ readonly rows: number }>(
                  `select count(*)::int as rows from core.access_decision_logs
                    where tenant_id = $1 and actor_principal_id = $2
                      and reasons_json @> '[{"code":"structural.member_baseline"}]'::jsonb`,
                  [accessCase.tenantId, accessCase.ids.get(MEMBER)?.principalId ?? ''],
                )
                .pipe(Effect.orDie);
              expect(evidence[0]?.rows ?? 0).toBeGreaterThan(0);

              // Who is a member decides it, as the graph holds memberships: a suspended or lapsed holder, a person
              // in the directory only, a departed one and a member of the other company only get no frame; a member
              // whose Role assignment ended is still a member.
              const membershipCases = yield* membershipCasesOf(accessCase);
              yield* Effect.log(`membership cases: ${JSON.stringify(membershipCases)}`);
              expect(membershipCases).toEqual([
                { allowed: [false, false], persona: 'suspended' },
                { allowed: [false, false], persona: 'lapsed' },
                { allowed: [false, false], persona: 'directoryMember' },
                { allowed: [false, false], persona: 'departed' },
                { allowed: [false, false], persona: 'companyAdmin' },
                { allowed: [true, true], persona: 'expiredAssignment' },
              ]);

              // The baseline admits the frame and nothing else: an administration page and a Shell read that is not
              // baseline stay decided by the member's Roles, which grant neither.
              const beyond = yield* Effect.all(
                ['shell-super-app.access-admin.people', 'core.shell.resources.search'].map((key) =>
                  frameDecision(accessCase, MEMBER, key),
                ),
                { concurrency: 1 },
              );
              expect(beyond.map(({ key, outcome }) => ({ allowed: outcome === 'ALLOWED', key }))).toEqual([
                { allowed: false, key: 'shell-super-app.access-admin.people' },
                { allowed: false, key: 'core.shell.resources.search' },
              ]);
              // A person with no access in the company and another tenant's owner get no frame.
              for (const persona of ['directoryMember', 'foreignOwner'] as const) {
                const composition = yield* shell.get({ legalEntityId: ours, path: '/shell/composition', persona });
                expect({ persona, refused: composition.status !== 200 }).toEqual({ persona, refused: true });
              }
              // An agent never borrows its operator's membership: the frame keys themselves are refused it.
              const agentFrame = yield* Effect.all(
                FRAME_KEYS.map((key) => frameDecision(accessCase, 'agent', key)),
                { concurrency: 1 },
              );
              expect(agentFrame.map(({ key, outcome }) => ({ allowed: outcome === 'ALLOWED', key }))).toEqual(
                FRAME_KEYS.map((key) => ({ allowed: false, key })),
              );
              // An agent holds no administration through the baseline.
              const [admin] = accessCase.shellAdminDeclarations;
              if (admin !== undefined) {
                const agentAdmin = yield* accessCase.gate.decide({
                  carrier: { accessDeclaration: admin },
                  legalEntityScope: 'optional',
                  now: DECISION_AT,
                  scope: yield* accessCase.scopeFor('agent', ours),
                });
                expect(agentAdmin.outcome).not.toBe('ALLOWED');
              }
            }),
          ),
        ),
      CASE_TIMEOUT,
    );
  },
);
