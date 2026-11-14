import { expect, it } from 'effect-rstest';
import cs from '../../locales/cs/legal-agreements.json';
import en from '../../locales/en/legal-agreements.json';
import { FeedbackSchema } from '../../shared/actions/apply-command.ts';

it('translates every contract feedback state, including the ready heading badge, in both locales', () => {
  for (const locale of [cs, en]) {
    const messages = locale['legal-agreements'].demo.feedback;
    for (const state of FeedbackSchema.literals) {
      expect(messages[state].trim().length).toBeGreaterThan(0);
      expect(messages[state]).not.toContain('legal-agreements.demo.feedback.');
    }
  }
  expect(cs['legal-agreements'].demo.feedback.ready).toBe('Připraveno');
  expect(en['legal-agreements'].demo.feedback.ready).toBe('Ready');
});
