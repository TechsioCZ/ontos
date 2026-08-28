import { describe, expect, test } from '@rstest/core';
import { Schema } from 'effect';
import {
  GovernedResolvedModuleTargetSchema,
  GovernedResolveModuleTargetPayloadSchema,
} from '../../api/modules/shell-governed-read-schemas.ts';

describe('Shell governed module-target schemas', () => {
  test('decode the production Projects target entirely with the server Effect runtime', () => {
    const input = {
      entrypointKey: 'projects.core.page.projects',
      moduleId: 'projects.core',
    };
    const result = {
      appId: 'projects',
      componentKey: 'projects.core.page-projects',
      entrypointKey: 'projects.core.page.projects',
      moduleId: 'projects.core',
      writable: true,
    };

    expect(Schema.decodeUnknownSync(GovernedResolveModuleTargetPayloadSchema)(input)).toEqual(
      input,
    );
    expect(Schema.decodeUnknownSync(GovernedResolvedModuleTargetSchema)(result)).toEqual(result);
  });
});
