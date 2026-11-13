/**
 * The carry-over of Core's own Outbox work across a release boundary proves that the retiring authority's
 * subscription descriptor is identical to this release's. A descriptor pins the topic and the entrypoint — not the
 * payload schema and not the handler body — so the rest of the safety rests on the rule pinned here: a core-system
 * payload schema change requires a new topic version.
 *
 * This snapshot makes reusing a topic for a changed shape an explicit, reviewed edit instead of a silent one.
 */
import { describe, expect, it } from 'effect-rstest';

import { CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS } from '../../packages/core-runtime/src/outbox/core-system-subscriptions.ts';

/** Every core-system worker key with the exact versioned topic it consumes. */
const PINNED_TOPICS = {
  'core.authorization.reconcile-module-installation': 'core.modules.tenant-module-state-changed.v1',
  'core.authorization.reconcile-principal-binding': 'core.identity.principal-binding-activated.v1',
  'core.authorization.reconcile-principal-lifecycle': 'core.identity.principal-lifecycle-changed.v1',
  'core.identity.project-people-lifecycle-search': 'core.identity.principal-lifecycle-changed.v1',
  'core.identity.rebuild-people-search': 'core.identity.people-search-rebuild-requested.v1',
} satisfies Readonly<Record<string, string>>;

describe('core-system carry-over rule', () => {
  it('pins every core-system worker key to its versioned topic', () => {
    const actual = Object.fromEntries(
      CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS.map(({ topic, workerKey }) => [workerKey, topic]),
    );
    // A new topic version, a new worker key or a retired one must be a reviewed edit of this snapshot, because a
    // reused topic with a changed payload shape would hand the next release a message it decodes differently.
    expect(actual).toEqual(PINNED_TOPICS);
  });

  it('gives every core-system topic an explicit version suffix', () => {
    for (const { topic } of CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS) {
      expect(topic).toMatch(/\.v\d+$/u);
    }
  });
});
