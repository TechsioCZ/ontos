/** Match technical identities, not business numbers, IČO, SKU or property unit codes. */
const technicalIdentifierPattern =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?:sr_|ak_)[a-z0-9_-]+\b|\b(?:siampark|najempark)-(?:asset|meter|task|document|event|incident|supplier|warehouse|item)-[a-z0-9_-]+\b|\b(?:sha256:)?[0-9a-f]{64}\b/giu;

/** Every UUID, internal key or digest in the text, once each. */
export const technicalIdentifiersInText = (text: string): readonly string[] => [
  ...new Set(text.match(technicalIdentifierPattern)),
];

const textIsVisible = (element: Element, root: Element): boolean => {
  let current: Element | null = element;
  while (current !== null) {
    if (current.matches('script, style, template, [hidden], input[type="hidden"]')) {
      return false;
    }
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') {
      return false;
    }
    if (current.matches('details:not([open])') && element.closest('summary')?.parentElement !== current) {
      return false;
    }
    if (current === root) {
      break;
    }
    current = current.parentElement;
  }
  return true;
};

const editableText = 'input:not([type="hidden"], [type="checkbox"], [type="radio"], [type="password"]), textarea';

/** Component-test projection. Hidden keys, link targets and closed disclosure contents are deliberately excluded. */
export const visibleComponentText = (root: HTMLElement): string => {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const parts: string[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    const parent = node.parentElement;
    if (parent !== null && textIsVisible(parent, root)) {
      parts.push(node.textContent ?? '');
    }
    node = walker.nextNode();
  }
  for (const element of [root, ...root.querySelectorAll('[title], [aria-label]')]) {
    if (textIsVisible(element, root)) {
      parts.push(element.getAttribute('title') ?? '', element.getAttribute('aria-label') ?? '');
    }
  }
  for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(editableText)) {
    if (textIsVisible(field, root)) {
      parts.push(field.value);
    }
  }
  return parts.join('\n');
};
