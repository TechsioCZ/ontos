import { decodeAccessDeclarationOrThrow } from '@app/core-runtime';
import type { AccessDeclarationOwner } from '@app/core-runtime';
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
import { AccessAdminSession, accessAdminUnavailableProblem } from './session.ts';

/*
 * Which access administration pages the navigation offers a person (O88). Each page carries its own admin
 * declaration with the surface marker (`admitsAdminSurface`); the gate decides it in the tenant context, exactly
 * as it admits the page: an owner, a live company access administrator, a delegation or a role cell. A page the
 * gate refuses is not offered, so a person never sees a link to a page that only says "no access".
 */

const page = (
  key: AccessAdministrationPage,
  meta: { readonly accessDeclaration: unknown; readonly entrypoint: AccessDeclarationOwner },
) => ({
  declaration: decodeAccessDeclarationOrThrow(meta.accessDeclaration, meta.entrypoint),
  page: key,
});

/** The pages in navigation order, each with its own route declaration. */
const accessPages = [
  page('roles', rolesRouteMeta),
  page('people', peopleRouteMeta),
  page('changes', changesRouteMeta),
  page('approvals', approvalsRouteMeta),
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
          const answers = yield* gate.decideMany(
            accessPages.map(({ declaration }) => ({
              carrier: { accessDeclaration: declaration },
              legalEntityScope: 'optional' as const,
              now,
              scope,
            })),
          );
          // An unreadable answer is a retry, never a smaller navigation.
          if (answers.length !== accessPages.length || answers.some(({ outcome }) => outcome === 'UNAVAILABLE')) {
            return yield* Effect.fail(accessAdminUnavailableProblem());
          }
          return {
            pages: accessPages.flatMap(({ page: key }, index) => (answers[index]?.outcome === 'ALLOWED' ? [key] : [])),
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
