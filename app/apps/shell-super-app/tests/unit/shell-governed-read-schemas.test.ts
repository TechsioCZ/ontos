import { Schema } from 'effect';
import { describe, expect, test } from 'effect-rstest';

import {
  GovernedResolvedModuleTargetSchema,
  GovernedResolveModuleTargetPayloadSchema,
} from '../../api/modules/shell-governed-read-schemas.ts';

describe('Shell governed module-target schemas', () => {
  test('decode the production Contacts target and preserve its wire format', () => {
    const compositionRevision = 'a'.repeat(64);
    const input = {
      compositionRevision,
      entrypointKey: 'contacts.core.page.contacts',
      moduleId: 'contacts.core',
    };
    const result = {
      appId: 'contacts',
      componentKey: 'contacts.core.page-contacts',
      compositionRevision,
      entrypointKey: 'contacts.core.page.contacts',
      federation: {
        expose: './PageContacts',
        manifest: {
          sha256: 'b'.repeat(64),
          url: 'https://contacts.example.test/releases/contacts-v1/mf-manifest.json',
        },
        remoteName: 'verticalContacts',
      },
      moduleId: 'contacts.core',
      routeParameters: {},
      writable: true,
    };

    const decodedInput = Schema.decodeUnknownSync(GovernedResolveModuleTargetPayloadSchema)(input);
    const decodedResult = Schema.decodeUnknownSync(GovernedResolvedModuleTargetSchema)(result);

    expect(decodedInput).toEqual(input);
    expect(decodedResult).toEqual(result);
    expect(Schema.encodeSync(GovernedResolveModuleTargetPayloadSchema)(decodedInput)).toEqual(input);
    expect(Schema.encodeSync(GovernedResolvedModuleTargetSchema)(decodedResult)).toEqual(result);
  });
});
