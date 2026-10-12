import { expect, it } from 'effect-rstest';
import { tagResourceDescriptor } from '../../shared/resources/tag.ts';

it('owns its primary resource type', () => {
  expect(tagResourceDescriptor.owningModuleId).toBe('demo.tagging');
});
