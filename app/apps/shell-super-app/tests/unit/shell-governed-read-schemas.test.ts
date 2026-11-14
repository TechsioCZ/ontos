import { Schema } from 'effect';
import { describe, expect, test } from 'effect-rstest';

import {
  GovernedResolvedModuleTargetSchema,
  GovernedResolveModuleTargetPayloadSchema,
} from '../../api/modules/shell-governed-read-schemas.ts';
import { ShellTenantModuleTargetSchema } from '../../api/modules/shell-governed-reads.ts';

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

  test('decodes both tenant module-target outcomes and preserves the wire format', () => {
    const compositionRevision = 'c'.repeat(64);
    const target = {
      appId: 'projects',
      componentKey: 'projects.core.page-create-project',
      compositionRevision,
      entrypointKey: 'projects.core.page.create-project',
      federation: {
        expose: './PageCreateProject',
        manifest: {
          sha256: 'd'.repeat(64),
          url: 'https://projects.example.test/releases/projects-v1/mf-manifest.json',
        },
        remoteName: 'verticalProjects',
      },
      moduleId: 'projects.core',
      routeParameters: {},
      writable: true,
    };
    const rawResolved = { state: 'resolved' as const, target };
    const rawSelectionRequired = { state: 'selection_required' as const };
    const resolved = Schema.decodeUnknownSync(ShellTenantModuleTargetSchema)(rawResolved);
    const selectionRequired = Schema.decodeUnknownSync(ShellTenantModuleTargetSchema)(rawSelectionRequired);

    expect(resolved).toEqual(rawResolved);
    expect(selectionRequired).toEqual(rawSelectionRequired);
    expect(Schema.encodeSync(ShellTenantModuleTargetSchema)(resolved)).toEqual(rawResolved);
  });
});
