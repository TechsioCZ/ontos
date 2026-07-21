// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
// oxlint-disable jsx-a11y/prefer-tag-over-role -- multiline rich text requires a contentEditable surface
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Label } from '@techsio/ui-kit/atoms/label';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, ReactNode } from 'react';
import type {
  CoreReference,
  CoreReferenceOpenResult,
  CoreReferenceResolutionResult,
} from '@app/core-runtime/core-reference';
import type { TextDocument, TextInlineNode, TextMark } from '../../shared/text-property.ts';
import { flattenTextPaste } from '../text-property-paste.ts';

export interface TextPropertyDraft {
  readonly collectionId: string;
  readonly document: TextDocument | null;
  readonly expectedRevision: number;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
}

export interface SavedTextPropertyValue {
  readonly taskRevision: number;
  readonly value: {
    readonly document: TextDocument | null;
    readonly propertyDefinitionId: string;
    readonly readableText: string | null;
    readonly revision: number;
  };
}

export interface TextPropertyEditorProps {
  readonly collectionId: string;
  readonly document: TextDocument | null;
  readonly label: string;
  readonly onSave: (
    draft: TextPropertyDraft,
    idempotencyKey: string,
  ) => Promise<SavedTextPropertyValue>;
  readonly onOpenReference?: (reference: CoreReference) => Promise<CoreReferenceOpenResult>;
  readonly onResolveReference?: (
    reference: CoreReference,
  ) => Promise<CoreReferenceResolutionResult>;
  readonly propertyDefinitionId: string;
  readonly readOnly?: boolean;
  readonly revision: number;
  readonly taskId: string;
}

const isStaleTextFailure = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ticketing.updateTextPropertyValue.stale_or_missing';

const markStyle = (marks: readonly TextMark[]) => {
  const foreground = marks.find(({ type }) => type === 'foregroundColor');
  const background = marks.find(({ type }) => type === 'backgroundColor');
  return {
    ...(background?.type === 'backgroundColor' ? { backgroundColor: background.color } : {}),
    ...(foreground?.type === 'foregroundColor' ? { color: foreground.color } : {}),
  };
};

const renderTextNode = (node: Extract<TextInlineNode, { readonly type: 'text' }>): ReactNode => {
  let rendered: ReactNode = node.text;
  if (node.marks.some(({ type }) => type === 'code')) {
    rendered = <code>{rendered}</code>;
  }
  if (node.marks.some(({ type }) => type === 'strikethrough')) {
    rendered = <s>{rendered}</s>;
  }
  if (node.marks.some(({ type }) => type === 'underline')) {
    rendered = <u>{rendered}</u>;
  }
  if (node.marks.some(({ type }) => type === 'italic')) {
    rendered = <em>{rendered}</em>;
  }
  if (node.marks.some(({ type }) => type === 'bold')) {
    rendered = <strong>{rendered}</strong>;
  }
  const link = node.marks.find(({ type }) => type === 'link');
  if (link?.type === 'link') {
    rendered = <a href={link.href}>{rendered}</a>;
  }
  return <span style={markStyle(node.marks)}>{rendered}</span>;
};

const TextCoreReference = ({
  onOpen,
  onResolve,
  reference,
}: {
  readonly onOpen: (reference: CoreReference) => Promise<CoreReferenceOpenResult>;
  readonly onResolve: (reference: CoreReference) => Promise<CoreReferenceResolutionResult>;
  readonly reference: CoreReference;
}) => {
  const { t } = useModernI18n();
  const [resolution, setResolution] = useState<CoreReferenceResolutionResult>({
    _tag: 'CoreReferenceFallback',
    reference,
  });

  useEffect(() => {
    let mounted = true;
    const resolve = async () => {
      try {
        const nextResolution = await onResolve(reference);
        if (mounted) {
          setResolution(nextResolution);
        }
      } catch {
        if (mounted) {
          setResolution({ _tag: 'CoreReferenceFallback', reference });
        }
      }
    };
    void resolve();
    return () => {
      mounted = false;
    };
  }, [onResolve, reference]);

  if (resolution._tag === 'CoreReferenceFallback') {
    return (
      <span data-core-reference-fallback={reference.token}>
        {resolution.reference.lastResolvedLabel}
      </span>
    );
  }

  const open = async () => {
    const result = await onOpen(reference).catch(
      (): CoreReferenceOpenResult => ({ _tag: 'CoreReferenceOpenUnavailable' }),
    );
    if (result._tag === 'CoreReferenceOpenDenied') {
      toaster.create({
        description: t('ticketing.text.referenceDeniedDescription'),
        title: t('ticketing.text.referenceDeniedTitle'),
        type: 'warning',
      });
    } else if (result._tag === 'CoreReferenceOpenUnavailable') {
      setResolution({ _tag: 'CoreReferenceFallback', reference });
    }
  };

  return (
    <Button
      data-core-reference={reference.token}
      onClick={() => void open()}
      size="current"
      theme="unstyled"
      type="button"
      variant="secondary"
    >
      {resolution.reference.lastResolvedLabel}
    </Button>
  );
};

const renderNode = (
  node: TextInlineNode,
  index: number,
  referenceHandlers?: {
    readonly onOpen: (reference: CoreReference) => Promise<CoreReferenceOpenResult>;
    readonly onResolve: (reference: CoreReference) => Promise<CoreReferenceResolutionResult>;
  },
): ReactNode => {
  switch (node.type) {
    case 'text': {
      return <span key={index}>{renderTextNode(node)}</span>;
    }
    case 'lineBreak': {
      return <br key={index} />;
    }
    case 'equation': {
      return (
        <span data-text-equation={node.expression} key={index}>
          {node.expression}
        </span>
      );
    }
    case 'reference': {
      if (referenceHandlers !== undefined) {
        return (
          <TextCoreReference
            key={node.reference.token}
            onOpen={referenceHandlers.onOpen}
            onResolve={referenceHandlers.onResolve}
            reference={node.reference}
          />
        );
      }
      return (
        <span data-core-reference={JSON.stringify(node.reference)} key={index}>
          {node.reference.lastResolvedLabel}
        </span>
      );
    }
    default: {
      return null;
    }
  }
};

export const TextPropertyEditor = ({
  collectionId,
  document,
  label,
  onOpenReference,
  onResolveReference,
  onSave,
  propertyDefinitionId,
  readOnly = false,
  revision,
  taskId,
}: TextPropertyEditorProps) => {
  const { t } = useModernI18n();
  const editorId = `text-property-${propertyDefinitionId}`;
  const editorLabelId = `${editorId}-label`;
  const editorRef = useRef<HTMLDivElement>(null);
  const [draftDocument, setDraftDocument] = useState<TextDocument | null>(document);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [isSaving, setIsSaving] = useState(false);
  const [linkHref, setLinkHref] = useState('');
  const [equationExpression, setEquationExpression] = useState('');

  const readEditorDocument = () => {
    const editor = editorRef.current;
    if (editor !== null) {
      setDraftDocument(
        flattenTextPaste({ html: editor.innerHTML, plainText: editor.textContent ?? '' }),
      );
    }
  };

  const applyFormat = (command: string, value?: string) => {
    editorRef.current?.focus();
    globalThis.document.execCommand(command, false, value);
    readEditorDocument();
  };

  const wrapSelection = (element: HTMLElement) => {
    const editor = editorRef.current;
    const selection = globalThis.getSelection();
    if (
      editor === null ||
      selection === null ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      return;
    }
    element.append(range.extractContents());
    range.insertNode(element);
    selection.removeAllRanges();
    selection.addRange(range);
    readEditorDocument();
  };

  const applyInlineCode = () => {
    wrapSelection(globalThis.document.createElement('code'));
  };

  const applyLink = () => {
    const href = linkHref.trim();
    if (href.length === 0) {
      return;
    }
    const link = globalThis.document.createElement('a');
    link.setAttribute('href', href);
    wrapSelection(link);
  };

  const insertEquation = () => {
    const expression = equationExpression.trim();
    const editor = editorRef.current;
    if (expression.length === 0 || editor === null) {
      return;
    }
    const equation = globalThis.document.createElement('span');
    equation.dataset['textEquation'] = expression;
    equation.textContent = expression;
    const selection = globalThis.getSelection();
    if (selection !== null && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (editor.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(equation);
      } else {
        editor.append(equation);
      }
    } else {
      editor.append(equation);
    }
    readEditorDocument();
    setEquationExpression('');
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraftDocument(
      flattenTextPaste({
        html: event.clipboardData.getData('text/html'),
        plainText: event.clipboardData.getData('text/plain'),
      }),
    );
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const saved = await onSave(
        {
          collectionId,
          document: draftDocument,
          expectedRevision: currentRevision,
          propertyDefinitionId,
          taskId,
        },
        idempotencyKey,
      );
      setCurrentRevision(saved.value.revision);
      setDraftDocument(saved.value.document);
      setIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create(
        isStaleTextFailure(error)
          ? {
              description: t('ticketing.text.staleDescription'),
              title: t('ticketing.text.staleTitle'),
              type: 'warning',
            }
          : {
              description:
                error instanceof Error ? error.message : t('ticketing.text.saveFailedDescription'),
              title: t('ticketing.text.saveFailedTitle'),
              type: 'error',
            },
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="ticketing:grid ticketing:gap-2">
      <Label id={editorLabelId}>{label}</Label>
      {readOnly ? null : (
        <div
          aria-label={`${label} formatting`}
          className="ticketing:flex ticketing:flex-wrap ticketing:gap-1"
        >
          {[
            ['bold', 'bold'],
            ['italic', 'italic'],
            ['underline', 'underline'],
            ['strikethrough', 'strikeThrough'],
          ].map(([translation, command]) => (
            <Button
              key={command}
              onClick={() => applyFormat(command)}
              onMouseDown={(event) => event.preventDefault()}
              size="sm"
              theme="borderless"
              type="button"
              variant="secondary"
            >
              {t(`ticketing.text.${translation}`)}
            </Button>
          ))}
          <Button
            onClick={applyInlineCode}
            onMouseDown={(event) => event.preventDefault()}
            size="sm"
            theme="borderless"
            type="button"
            variant="secondary"
          >
            {t('ticketing.text.code')}
          </Button>
          <Input
            aria-label={t('ticketing.text.foregroundColor')}
            onChange={(event) => applyFormat('foreColor', event.currentTarget.value)}
            size="sm"
            type="color"
          />
          <Label htmlFor={`${editorId}-link`}>{t('ticketing.text.link')}</Label>
          <Input
            id={`${editorId}-link`}
            onChange={(event) => setLinkHref(event.currentTarget.value)}
            size="sm"
            type="url"
            value={linkHref}
          />
          <Button
            disabled={linkHref.trim().length === 0}
            onClick={applyLink}
            onMouseDown={(event) => event.preventDefault()}
            size="sm"
            theme="borderless"
            type="button"
            variant="secondary"
          >
            {t('ticketing.text.linkApply')}
          </Button>
          <Label htmlFor={`${editorId}-equation`}>{t('ticketing.text.equation')}</Label>
          <Input
            id={`${editorId}-equation`}
            onChange={(event) => setEquationExpression(event.currentTarget.value)}
            size="sm"
            value={equationExpression}
          />
          <Button
            disabled={equationExpression.trim().length === 0}
            onClick={insertEquation}
            onMouseDown={(event) => event.preventDefault()}
            size="sm"
            theme="borderless"
            type="button"
            variant="secondary"
          >
            {t('ticketing.text.insertEquation')}
          </Button>
          <Input
            aria-label={t('ticketing.text.backgroundColor')}
            onChange={(event) => applyFormat('hiliteColor', event.currentTarget.value)}
            size="sm"
            type="color"
          />
        </div>
      )}
      <div
        aria-labelledby={editorLabelId}
        aria-multiline="true"
        className="ticketing:min-h-32 ticketing:rounded-lg ticketing:border ticketing:border-stone-300 ticketing:bg-white ticketing:p-3"
        contentEditable={!readOnly}
        id={editorId}
        onInput={readEditorDocument}
        onPaste={handlePaste}
        ref={editorRef}
        role="textbox"
        suppressContentEditableWarning
      >
        {draftDocument?.content.map((node, index) =>
          renderNode(
            node,
            index,
            onOpenReference === undefined || onResolveReference === undefined
              ? undefined
              : { onOpen: onOpenReference, onResolve: onResolveReference },
          ),
        )}
      </div>
      {readOnly ? null : (
        <Button
          isLoading={isSaving}
          loadingText={t('ticketing.text.saving')}
          onClick={() => void handleSave()}
          type="button"
          variant="secondary"
        >
          {t('ticketing.text.save')}
        </Button>
      )}
    </div>
  );
};
