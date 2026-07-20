import type {
  CoreReference,
  TextDocument,
  TextInlineNode,
  TextMark,
} from '../shared/text-property.ts';

const blockElements = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'P',
  'PRE',
  'SECTION',
]);

const appendMark = (marks: readonly TextMark[], mark: TextMark): TextMark[] =>
  marks.some((candidate) => JSON.stringify(candidate) === JSON.stringify(mark))
    ? [...marks]
    : [...marks, mark];

const marksForElement = (element: HTMLElement, inherited: readonly TextMark[]): TextMark[] => {
  let marks = [...inherited];
  switch (element.tagName) {
    case 'B':
    case 'STRONG': {
      marks = appendMark(marks, { type: 'bold' });
      break;
    }
    case 'I':
    case 'EM': {
      marks = appendMark(marks, { type: 'italic' });
      break;
    }
    case 'U': {
      marks = appendMark(marks, { type: 'underline' });
      break;
    }
    case 'S':
    case 'STRIKE':
    case 'DEL': {
      marks = appendMark(marks, { type: 'strikethrough' });
      break;
    }
    case 'CODE': {
      marks = appendMark(marks, { type: 'code' });
      break;
    }
    case 'A': {
      const href = element.getAttribute('href');
      if (href !== null) {
        marks = appendMark(marks, { href, type: 'link' });
      }
      break;
    }
    default: {
      break;
    }
  }
  if (element.style.color.length > 0) {
    marks = appendMark(marks, { color: element.style.color, type: 'foregroundColor' });
  }
  if (element.style.backgroundColor.length > 0) {
    marks = appendMark(marks, {
      color: element.style.backgroundColor,
      type: 'backgroundColor',
    });
  }
  return marks;
};

const pushLineBreak = (content: TextInlineNode[]) => {
  if (content.length > 0 && content.at(-1)?.type !== 'lineBreak') {
    content.push({ type: 'lineBreak' });
  }
};

const parseCoreReference = (serialized: string | undefined): CoreReference | undefined => {
  if (serialized === undefined) {
    return undefined;
  }
  try {
    const candidate = JSON.parse(serialized) as Partial<CoreReference>;
    const requiredStrings = [
      candidate.entityId,
      candidate.entityType,
      candidate.lastResolvedLabel,
      candidate.ownerModuleKey,
      candidate.targetTenantId,
      candidate.token,
    ];
    if (
      !requiredStrings.every((value) => typeof value === 'string' && value.trim().length > 0) ||
      (candidate.kind !== 'mention' && candidate.kind !== 'relation')
    ) {
      return undefined;
    }
    return candidate as CoreReference;
  } catch {
    return undefined;
  }
};

const flattenNode = (node: Node, marks: readonly TextMark[], content: TextInlineNode[]): void => {
  if (node.nodeType === Node.TEXT_NODE) {
    if ((node.textContent ?? '').length > 0) {
      content.push({ marks: [...marks], text: node.textContent ?? '', type: 'text' });
    }
    return;
  }
  if (!(node instanceof HTMLElement)) {
    return;
  }
  if (node.tagName === 'BR') {
    content.push({ type: 'lineBreak' });
    return;
  }
  const equation = node.dataset['textEquation'];
  if (equation !== undefined) {
    content.push({ expression: equation, type: 'equation' });
    return;
  }
  const reference = parseCoreReference(node.dataset['coreReference']);
  if (reference !== undefined) {
    content.push({ reference, type: 'reference' });
    return;
  }
  if (node.tagName === 'IMG') {
    const alt = node.getAttribute('alt');
    if (alt !== null && alt.length > 0) {
      content.push({ marks: [...marks], text: alt, type: 'text' });
    }
    return;
  }

  const childMarks = marksForElement(node, marks);
  for (const child of node.childNodes) {
    flattenNode(child, childMarks, content);
  }
  if (blockElements.has(node.tagName)) {
    pushLineBreak(content);
  }
};

const documentFromPlainText = (plainText: string): TextDocument => ({
  content: plainText
    .split('\n')
    .flatMap((text, index, lines) => [
      ...(text.length === 0 ? [] : [{ marks: [], text, type: 'text' as const }]),
      ...(index === lines.length - 1 ? [] : [{ type: 'lineBreak' as const }]),
    ]),
  type: 'textDocument',
});

export const flattenTextPaste = ({
  html,
  plainText,
}: {
  readonly html: string;
  readonly plainText: string;
}): TextDocument => {
  if (html.trim().length === 0) {
    return documentFromPlainText(plainText);
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const content: TextInlineNode[] = [];
  for (const child of parsed.body.childNodes) {
    flattenNode(child, [], content);
  }
  while (content.at(-1)?.type === 'lineBreak') {
    content.pop();
  }
  return { content, type: 'textDocument' };
};
