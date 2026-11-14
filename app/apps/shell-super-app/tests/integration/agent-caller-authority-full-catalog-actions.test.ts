import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { accessAdminTemplateLayer } from '../support/access-admin-real-gate-fixture.ts';
import {
  firstActionsAsked,
  installedComposition,
  rowsOfEach,
  valuesOfEach,
  withAuthorityCase,
} from './agent-caller-authority-full-catalog.fixture.ts';

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '900 seconds' })(
  'agent platform caller authority over the installed release',
  (suite) => {
    suite.effect(
      'gives every Action the same allow/deny answer through the real gate batch as when asked alone, with the same rows',
      () =>
        withAuthorityCase('work.tasks', (authorityCase) =>
          Effect.gen(function* independentAnswers() {
            const snapshot = yield* installedComposition;
            const { companyId, otherCompanyId } = authorityCase;
            yield* authorityCase.reinstall([
              'commerce.customer-context',
              'commerce.market-catalog',
              'commerce.storefront-registry',
              'demo.merchandise',
              'party.registry',
              'work.tasks',
            ]);
            // Granted in this company but its module is not installed (never projected), and granted only in the other.
            yield* authorityCase.grant('facility.operations', companyId);
            yield* authorityCase.grant('party.registry', otherCompanyId);
            const askIn = (legalEntityId: string, correlationId: string, modules: readonly string[]) =>
              firstActionsAsked({ authorityCase, correlationId, legalEntityId, modules, snapshot });
            const modules = ['work.tasks', 'facility.operations', 'party.registry'];
            const together = yield* askIn(companyId, 'independent-together', modules);
            const alone = yield* Effect.forEach(
              modules,
              (moduleKey) => askIn(companyId, `independent-${moduleKey}`, [moduleKey]),
              { concurrency: 1 },
            );
            expect(together.value).toEqual(valuesOfEach(alone));
            expect(together.value.map(({ execute }) => execute)).toEqual(['allowed', 'denied', 'denied']);
            // The same evidence rows, row for row: each denial is recorded whatever was asked beside it.
            expect(together.decisionRowContents).toEqual(rowsOfEach(alone));
            expect(together.decisionRowContents.filter((row) => row.includes('|DENIED|'))).toHaveLength(2);
            // The other company's grant is real: there the same Action runs.
            const elsewhere = yield* askIn(otherCompanyId, 'independent-elsewhere', ['party.registry']);
            expect(elsewhere.value.map(({ execute }) => execute)).toEqual(['allowed']);
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      300_000,
    );
  },
);
