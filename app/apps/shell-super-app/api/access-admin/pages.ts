import { decodeAccessDeclarationOrThrow } from '@app/core-runtime';
import type { AccessDeclaration, AccessDeclarationOwner } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Context, DateTime, Effect, Layer } from 'effect';
import type { Headers as EffectHeaders } from 'effect/http/Headers';

import type {
  AccessAdministrationPage,
  AccessAdminProblem,
  ListAccessPagesResponse,
} from '../../shared/access-admin-api.ts';
import { ShellAuthenticationApi } from '../../shared/api.ts';
import { routeMeta as approvalsRouteMeta } from '../../src/routes/[lang]/access/approvals/route.meta.ts';
import { routeMeta as changesRouteMeta } from '../../src/routes/[lang]/access/changes/route.meta.ts';
import { routeMeta as peopleRouteMeta } from '../../src/routes/[lang]/access/people/route.meta.ts';
import { routeMeta as rolesRouteMeta } from '../../src/routes/[lang]/access/roles/route.meta.ts';
import { routeMeta as whyRouteMeta } from '../../src/routes/[lang]/access/why/route.meta.ts';
import { accessApprovalsDeclarations } from './approvals.ts';
import { accessChangesDeclarations } from './changes.ts';
import { accessPeopleDeclarations } from './people.ts';
import { accessRolesDeclarations } from './roles.ts';
import { AccessAdminSession, accessAdminUnavailableProblem } from './session.ts';

/*
 * Which access administration pages the navigation offers a person (O88). Each page carries its own admin
 * declaration with the surface marker (`admitsAdminSurface`); the gate decides it in the tenant context, exactly
 * as it admits the page: an owner, a live company access administrator, a delegation or a role cell. A page the
 * gate refuses is not offered, so a person never sees a link to a page that only says "no access". The page alone is
 * not enough: a page whose first read the gate refuses still only says "no access" (a company access administrator
 * opens Novinky and Ke schválení, yet their tenant lists are refused), so that read is asked beside it.
 */

const page = (
  key: AccessAdministrationPage,
  meta: { readonly accessDeclaration: unknown; readonly entrypoint: AccessDeclarationOwner },
  ...reads: readonly (AccessDeclaration | undefined)[]
) => ({
  declarations: [
    decodeAccessDeclarationOrThrow(meta.accessDeclaration, meta.entrypoint),
    ...reads.flatMap((read) => (read === undefined ? [] : [read])),
  ],
  // A read without a declaration is refused by its own BFF, so such a page is never offered.
  offerable: reads.every((read) => read !== undefined),
  page: key,
});

/** The pages in navigation order, each with its own route declaration and the read the page opens with. */
const accessPages = [
  page('roles', rolesRouteMeta, accessRolesDeclarations.list),
  page('people', peopleRouteMeta, accessPeopleDeclarations.list),
  page('changes', changesRouteMeta, accessChangesDeclarations.list),
  page('approvals', approvalsRouteMeta, accessApprovalsDeclarations.list),
  page('why', whyRouteMeta),
] as const;

export interface AccessPagesBffService {
  readonly list: (headers: Headers) => Effect.Effect<ListAccessPagesResponse, AccessAdminProblem>;
}

export class AccessPagesBff extends Context.Service<AccessPagesBff, AccessPagesBffService>()(
  '@app/shell-super-app/api/access-admin/pages/AccessPagesBff',
) {}

export const AccessPagesBffLive: Layer.Layer<AccessPagesBff, never, AccessAdminSession | AccessDecisionGate> =
  Layer.effect(
    AccessPagesBff,
    Effect.gen(function* accessPagesBff() {
      const gate = yield* AccessDecisionGate;
      const session = yield* AccessAdminSession;
      return {
        list: Effect.fn('AccessPagesBff.list')(function* listAccessPages(headers: Headers) {
          const scope = yield* session.requireTenantContext(headers);
          const now = yield* DateTime.nowAsDate;
          // Administration is tenant work (O28): every page is asked in the tenant context, in one gate batch.
          const questions = accessPages.flatMap(({ declarations }) => declarations);
          const answers = yield* gate.decideMany(
            questions.map((declaration) => ({
              carrier: { accessDeclaration: declaration },
              legalEntityScope: 'optional' as const,
              now,
              scope,
            })),
          );
          // An unreadable answer is a retry, never a smaller navigation.
          if (answers.length !== questions.length || answers.some(({ outcome }) => outcome === 'UNAVAILABLE')) {
            return yield* Effect.fail(accessAdminUnavailableProblem());
          }
          const allowed = new Set(questions.filter((_, index) => answers[index]?.outcome === 'ALLOWED'));
          return {
            pages: accessPages.flatMap(({ declarations, offerable, page: key }) =>
              offerable && declarations.every((declaration) => allowed.has(declaration)) ? [key] : [],
            ),
          };
        }),
      };
    }),
  );

const asHeaders = (input: EffectHeaders): Headers => new Headers(Object.entries(input));

export const accessAdminNavigationGroupLive = HttpApiBuilder.group(
  ShellAuthenticationApi,
  'accessAdminNavigation',
  (handlers) =>
    handlers.handle('listAccessPages', ({ request }) =>
      AccessPagesBff.pipe(Effect.flatMap((bff) => bff.list(asHeaders(request.headers)))),
    ),
);
