import { technicalIdentifiersInText, visibleComponentText } from '@app/admin-ui/visible-text';
import { expect } from 'effect-rstest';

/** Assert on rendered text and accessible labels, never on href, React keys or data attributes. */
export const expectHumanReadable = (root: HTMLElement = document.body): void => {
  expect(technicalIdentifiersInText(visibleComponentText(root))).toEqual([]);
};
