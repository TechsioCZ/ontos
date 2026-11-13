import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  DECISION_AT,
  accessAdminTemplateLayer,
  shellHttpFor,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, Persona } from '../support/access-admin-real-gate-fixture.ts';
import { installedReleaseComposition } from '../support/installed-release-composition.ts';

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
// The Shell's own home page (any signed-in person); a module's page also needs that module's release composed.
const HOME_PAGE = { entrypointKey: 'shell-super-app.page.home', moduleId: 'shell-super-app' } as const;
const FRAME_KEYS = ['core.shell.composition.read', 'core.shell.module-target.resolve'] as const;
const CASE_TIMEOUT = 300_000;

type ShellHttp = Effect.Success<ReturnType<typeof shellHttpFor>>;

/** What loading the Shell in one company answers this person, endpoint by endpoint. */
const frameOf = (shell: ShellHttp, legalEntityId: string, persona: Persona) =>
  Effect.all(
    {
      // The document context and the tenant list are not served by this fixture's session stub; the document context
      // reads the same composition, so its answer follows `composition`.
      composition: shell.get({ legalEntityId, path: '/shell/composition', persona }),
      legalEntities: shell.get({ legalEntityId, path: '/auth/legal-entities', persona }),
      moduleTarget: shell.post({ legalEntityId, path: '/shell/module-target', payload: HOME_PAGE, persona }),
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
) {
  const [ours = ''] = accessCase.companies;
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
              const shell = yield* shellHttpFor(accessCase, yield* installedReleaseComposition);

              // The Role grants neither frame capability: the gate refuses the cell and admits the member structurally.
              const frameDecisions = yield* Effect.all(
                FRAME_KEYS.map((key) => frameDecision(accessCase, MEMBER, key)),
                { concurrency: 1 },
              );
              expect(frameDecisions).toEqual(
                FRAME_KEYS.map((key) => ({ codes: ['structural.member_baseline'], key, outcome: 'ALLOWED' })),
              );
              // End to end the member's frame answers exactly as the owner's (this fixture composes no Shell release,
              // so the frame's own reads answer 503 for both after the gate); never a refusal.
              const frame = yield* frameOf(shell, ours, MEMBER);
              expect(frame).toEqual(yield* frameOf(shell, ours, 'owner'));
              expect(Object.values(frame).some((status) => status === 401 || status === 403)).toBe(false);
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
