import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withoutUndefined } from '../ontos-client.ts';
import { applyCommand, defineTool, readRecordsOf, readRevision, VERTICAL } from './shared.ts';
import { RevisionWire, TaggingCommandResultWire, TaggingRecordsWire } from './wire.ts';
import type { TagWire } from './wire.ts';

type Tag = typeof TagWire.Type;

export const SUBJECT_KINDS = ['customer', 'order', 'product', 'employee', 'opportunity'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
/** The apply-command limit: one assign or unassign carries at most 500 subjects. */
export const MAX_SUBJECTS = 500;

const subjectIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^,]+$/u, 'Id subjektu nesmí obsahovat čárku.');

export const listTagsInput = {
  kind: z.enum(SUBJECT_KINDS).optional().describe('Only tags that can be assigned to this subject kind.'),
};

const assignFields = {
  kind: z.enum(SUBJECT_KINDS).describe('Subject kind: customer, order, product, employee or opportunity.'),
  subjectIds: z
    .array(subjectIdSchema)
    .min(1)
    .max(MAX_SUBJECTS)
    .describe('Ids of the subjects (customer partyId, order id, ...).'),
  tagId: z.string().min(1).max(128).optional().describe('Tag id. Give either tagId or tagName.'),
  tagName: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe('Tag name, matched case-insensitively. Give either tagId or tagName.'),
};

export const TAG_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'] as const;

export const createTagInput = {
  color: z.enum(TAG_COLORS).optional().describe('Badge colour (default gray).'),
  description: z.string().max(2000).optional().describe('What the tag means, e.g. the rule that assigns it.'),
  name: z.string().trim().min(1).max(60).describe('Tag name. Must not repeat an existing tag name.'),
  subjectKinds: z
    .array(z.enum(SUBJECT_KINDS))
    .min(1)
    .max(SUBJECT_KINDS.length)
    .describe('Subject kinds the tag may be assigned to.'),
};

export const assignTagsInput = assignFields;
export const unassignTagsInput = assignFields;

export interface TagSelection {
  readonly tagId?: string | undefined;
  readonly tagName?: string | undefined;
}

/** Resolves exactly one tag from an id or a name, and checks the tag accepts the subject kind. */
export const resolveTag = (tags: readonly Tag[], selection: TagSelection, kind: SubjectKind): Tag => {
  if ((selection.tagId === undefined) === (selection.tagName === undefined)) {
    throw new Error('Zadejte právě jedno z tagId nebo tagName.');
  }
  const tag =
    selection.tagId === undefined
      ? tags.find(
          (candidate) =>
            candidate.name.toLocaleLowerCase('cs-CZ') === selection.tagName?.trim().toLocaleLowerCase('cs-CZ'),
        )
      : tags.find((candidate) => candidate.id === selection.tagId);
  if (tag === undefined) {
    throw new Error(`Štítek ${selection.tagId ?? selection.tagName} neexistuje.`);
  }
  if (!tag.subjectKinds.includes(kind)) {
    throw new Error(`Štítek "${tag.name}" nelze přiřadit typu ${kind}.`);
  }
  return tag;
};

export const listTags = async (input: { readonly kind?: SubjectKind | undefined }) => {
  const response = await readRecordsOf(VERTICAL.tagging, TaggingRecordsWire, {});
  const items = response.tags
    .filter((tag) => input.kind === undefined || tag.subjectKinds.includes(input.kind))
    .map((tag) => ({
      color: tag.color,
      counts: tag.counts,
      description: tag.description ?? null,
      id: tag.id,
      name: tag.name,
      subjectKinds: tag.subjectKinds,
    }));
  return { count: items.length, items, revision: response.revision };
};

/** Creates a tag. The bot may create tags; renaming and deleting them stays human-only (tagging command guard). */
export const createTag = async (input: {
  readonly color?: (typeof TAG_COLORS)[number] | undefined;
  readonly description?: string | undefined;
  readonly name: string;
  readonly subjectKinds: readonly SubjectKind[];
}) => {
  const current = await readRecordsOf(VERTICAL.tagging, TaggingRecordsWire, {});
  const wanted = input.name.trim().toLocaleLowerCase('cs-CZ');
  const clash = current.tags.find((tag) => tag.name.toLocaleLowerCase('cs-CZ') === wanted);
  if (clash !== undefined) {
    throw new Error(`Štítek "${clash.name}" už existuje (pro ${clash.subjectKinds.join(', ')}). Zvolte jiný název.`);
  }
  const result = await applyCommand(
    VERTICAL.tagging,
    RevisionWire,
    withoutUndefined({
      _tag: 'CreateTag',
      color: input.color ?? 'gray',
      description: input.description,
      name: input.name.trim(),
      subjectKinds: [...new Set(input.subjectKinds)],
    }),
    async () => await readRevision(VERTICAL.tagging),
    current.revision,
  );
  const refreshed = await readRecordsOf(VERTICAL.tagging, TaggingRecordsWire, {});
  const created = refreshed.tags.find((tag) => tag.name.toLocaleLowerCase('cs-CZ') === wanted);
  return {
    revision: result.revision,
    tag: created === undefined ? null : { id: created.id, name: created.name, subjectKinds: created.subjectKinds },
  };
};

const changeTagging = async (
  commandTag: 'AssignTag' | 'UnassignTag',
  input: SubjectSelection,
): Promise<{
  readonly affectedAssignments: number;
  readonly revision: number;
  readonly tag: string;
  readonly tagId: string;
}> => {
  const current = await readRecordsOf(VERTICAL.tagging, TaggingRecordsWire, {});
  const tag = resolveTag(current.tags, input, input.kind);
  const result = await applyCommand(
    VERTICAL.tagging,
    TaggingCommandResultWire,
    {
      _tag: commandTag,
      subjects: input.subjectIds.map((id) => ({ id, kind: input.kind })),
      tagId: tag.id,
    },
    async () => await readRevision(VERTICAL.tagging),
    current.revision,
  );
  return { affectedAssignments: result.affectedAssignments, revision: result.revision, tag: tag.name, tagId: tag.id };
};

export interface SubjectSelection extends TagSelection {
  readonly kind: SubjectKind;
  readonly subjectIds: readonly string[];
}

export const assignTags = async (input: SubjectSelection) => {
  const result = await changeTagging('AssignTag', input);
  return { ...result, kind: input.kind, requested: input.subjectIds.length };
};

export const unassignTags = async (input: SubjectSelection) => {
  const result = await changeTagging('UnassignTag', input);
  return { ...result, kind: input.kind, requested: input.subjectIds.length };
};

export const registerTaggingTools = (server: McpServer): void => {
  defineTool(
    server,
    'list_tags',
    'List tags (štítky) with colour, the subject kinds they apply to and assignment counts. Optional kind filter.',
    listTagsInput,
    listTags,
  );
  defineTool(
    server,
    'create_tag',
    'Create a new tag (štítek) for the given subject kinds. Use it only when no existing tag fits; the agent cannot rename or delete tags.',
    createTagInput,
    createTag,
  );
  defineTool(
    server,
    'assign_tags',
    'Assign one tag to many subjects of one kind (customers, orders, products, employees, opportunities). Pass tagName or tagId. Use list_tags first to find the tag.',
    assignTagsInput,
    assignTags,
  );
  defineTool(
    server,
    'unassign_tags',
    'Remove one tag from many subjects of one kind. Pass tagName or tagId.',
    unassignTagsInput,
    unassignTags,
  );
};
