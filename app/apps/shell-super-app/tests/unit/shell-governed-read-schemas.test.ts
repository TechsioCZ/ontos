import { describe, expect, test } from '@rstest/core';
import { Schema } from 'effect';
import {
  GovernedResolvedModuleTargetSchema,
  GovernedResolveModuleTargetPayloadSchema,
} from '../../api/modules/shell-governed-read-schemas.ts';

describe('Shell governed module-target schemas', () => {
  test('decode the production CRM target entirely with the server Effect runtime', () => {
    const input = {
      entrypointKey: 'crm.core.page.crm',
      moduleId: 'crm.core',
    };
    const result = {
      appId: 'crm',
      componentKey: 'crm.core.page-crm',
      entrypointKey: 'crm.core.page.crm',
      moduleId: 'crm.core',
      writable: true,
    };

    expect(Schema.decodeUnknownSync(GovernedResolveModuleTargetPayloadSchema)(input)).toEqual(
      input,
    );
    expect(Schema.decodeUnknownSync(GovernedResolvedModuleTargetSchema)(result)).toEqual(result);
  });
});
