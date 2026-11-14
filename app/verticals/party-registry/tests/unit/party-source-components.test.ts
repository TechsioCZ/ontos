import { OntosComponentContractSchema } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { partySourceComponentContracts } from '../fixtures/party-source-components.ts';

it.layer(NodeServices.layer)('Party source component contracts', (suite) => {
  for (const [fileName, before, after] of [
    ['module-federation.config.ts', "'./PageContacts':", "'./UndeclaredPage':"],
    ['reference-topology.json', '"id": "party-registry"', '"id": "unplaced-party"'],
  ] as const) {
    suite.effect(`refuses source component metadata when ${fileName} does not bind the owner`, () =>
      Effect.gen(function* refuseUnboundPartyComponent() {
        const fs = yield* FileSystem.FileSystem;
        const failure = yield* Effect.flip(
          partySourceComponentContracts().pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file, encoding) =>
                fs.readFileString(file, encoding).pipe(
                  Effect.map((source) => {
                    if (!file.endsWith(fileName)) {
                      return source;
                    }
                    expect(source).toContain(before);
                    return source.replaceAll(before, after);
                  }),
                ),
            }),
          ),
        );
        expect(Predicate.isTagged(failure, 'PartySourceComponentUnavailable')).toBe(true);
      }),
    );
  }
  suite.effect('projects actual registered pages as deployment metadata rather than React components', () =>
    Effect.gen(function* actualPartyComponents() {
      const components = yield* partySourceComponentContracts();
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(OntosComponentContractSchema))(components);
      expect(decoded).toEqual([
        {
          expose: './PageContacts',
          key: 'party.registry.page-contacts',
          mfBoundaryId: 'verticalPartyRegistry',
        },
        {
          expose: './PageCustomerDetail',
          key: 'party.registry.page-customer-detail',
          mfBoundaryId: 'verticalPartyRegistry',
        },
        {
          expose: './PageCustomers',
          key: 'party.registry.page-customers',
          mfBoundaryId: 'verticalPartyRegistry',
        },
        {
          expose: './PagePartyIdentity',
          key: 'party.registry.page-party-identity',
          mfBoundaryId: 'verticalPartyRegistry',
        },
      ]);
    }),
  );
});
