import { describe, expect, test } from '@rstest/core';
import { Schema } from 'effect';
import {
  GovernedResolvedModuleTargetSchema,
  GovernedResolveModuleTargetPayloadSchema,
} from '../../api/modules/shell-governed-read-schemas.ts';

describe('Shell governed module-target schemas', () => {
  test('decode the production Contacts target and preserve its wire format', () => {
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

    const decodedInput = Schema.decodeUnknownSync(GovernedResolveModuleTargetPayloadSchema)(input);
    const decodedResult = Schema.decodeUnknownSync(GovernedResolvedModuleTargetSchema)(result);

    expect(decodedInput).toEqual(input);
    expect(decodedResult).toEqual(result);
    expect(Schema.encodeSync(GovernedResolveModuleTargetPayloadSchema)(decodedInput)).toEqual(
      input,
    );
    expect(Schema.encodeSync(GovernedResolvedModuleTargetSchema)(decodedResult)).toEqual(result);
  });
});
