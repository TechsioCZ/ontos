import { describe, expect, test } from '@rstest/core';
import { Schema } from 'effect';
import {
  GovernedResolvedModuleTargetSchema,
  GovernedResolveModuleTargetPayloadSchema,
} from '../../api/modules/shell-governed-read-schemas.ts';

describe('Shell governed module-target schemas', () => {
  test('decode the production Contacts target entirely with the server Effect runtime', () => {
    const input = {
      entrypointKey: 'contacts.core.page.contacts',
      moduleId: 'contacts.core',
    };
    const result = {
      appId: 'contacts',
      componentKey: 'contacts.core.page-contacts',
      entrypointKey: 'contacts.core.page.contacts',
      moduleId: 'contacts.core',
      writable: true,
    };

    expect(Schema.decodeUnknownSync(GovernedResolveModuleTargetPayloadSchema)(input)).toEqual(
      input,
    );
    expect(Schema.decodeUnknownSync(GovernedResolvedModuleTargetSchema)(result)).toEqual(result);
  });
});
