import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyCommand, defineTool, readRecordsOf, readRevision, VERTICAL } from './shared.ts';
import type { TaggingRecordsWire, TagWire } from './wire.ts';

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

const assignShape = {
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

export const assignTagsInput = assignShape;
export const unassignTagsInput = assignShape;

export type TagSelection = { readonly tagId?: string | undefined; readonly tagName?: string | undefined };

/** Resolves exactly one tag from an id or a name, and checks the tag accepts the subject kind. */
export function resolveTag(tags: readonly TagWire[], selection: TagSelection, kind: SubjectKind): TagWire {
  if ((selection.tagId === undefined) === (selection.tagName === undefined)) {
    throw new Error('Zadejte právě jedno z tagId nebo tagName.');
  }
  const tag =
    selection.tagId === undefined
      ? tags.filter(
          (candidate) =>
            candidate.name.toLocaleLowerCase('cs-CZ') === selection.tagName?.trim().toLocaleLowerCase('cs-CZ'),
        )[0]
      : tags.find((candidate) => candidate.id === selection.tagId);
  if (tag === undefined) {
    throw new Error(`Štítek ${selection.tagId ?? selection.tagName} neexistuje.`);
  }
  if (!tag.subjectKinds.includes(kind)) {
    throw new Error(`Štítek "${tag.name}" nelze přiřadit typu ${kind}.`);
  }
  return tag;
}

export async function listTags(input: { readonly kind?: SubjectKind | undefined }) {
  const response = await readRecordsOf<TaggingRecordsWire>(VERTICAL.tagging, {});
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
}

async function changeTagging(
  commandTag: 'AssignTag' | 'UnassignTag',
  input: SubjectSelection,
): Promise<{
  readonly affectedAssignments: number;
  readonly revision: number;
  readonly tag: string;
  readonly tagId: string;
}> {
  const current = await readRecordsOf<TaggingRecordsWire>(VERTICAL.tagging, {});
  const tag = resolveTag(current.tags, input, input.kind);
  const result = await applyCommand<{ affectedAssignments: number; revision: number; tagId: string }>(
    VERTICAL.tagging,
    {
      _tag: commandTag,
      subjects: input.subjectIds.map((id) => ({ id, kind: input.kind })),
      tagId: tag.id,
    },
    () => readRevision(VERTICAL.tagging),
    current.revision,
  );
  return { affectedAssignments: result.affectedAssignments, revision: result.revision, tag: tag.name, tagId: tag.id };
}

interface SubjectSelection extends TagSelection {
  readonly kind: SubjectKind;
  readonly subjectIds: readonly string[];
}

export async function assignTags(input: SubjectSelection) {
  const result = await changeTagging('AssignTag', input);
  return { ...result, kind: input.kind, requested: input.subjectIds.length };
}

export async function unassignTags(input: SubjectSelection) {
  const result = await changeTagging('UnassignTag', input);
  return { ...result, kind: input.kind, requested: input.subjectIds.length };
}

export function registerTaggingTools(server: McpServer): void {
  defineTool(
    server,
    'list_tags',
    'List tags (štítky) with colour, the subject kinds they apply to and assignment counts. Optional kind filter.',
    listTagsInput,
    listTags,
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
}
