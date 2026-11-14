/**
 * Whether the signed-in person may read tags, kept apart from the React controls so it stays a pure, testable rule.
 * Tags are optional on every host page: a person who may not read them gets `forbidden`, which hosts render as no
 * tags section at all (no column, filter or bulk action), never as a load error.
 */
import { documentNavigationModules } from '@app/shared-contracts';
import { Predicate, Schema } from 'effect';

/** `forbidden`: this person may not read tags here, so a host shows no tags section at all (never an error). */
const tagsStatusValues = Schema.Literals(['loading', 'ready', 'error', 'forbidden']);
export type TagsStatus = typeof tagsStatusValues.Type;

/** The tagging module id the Shell lists in a person's navigation when they may open tags in this company. */
const taggingModuleId = 'demo.tagging';

/**
 * False when the Shell's per-document navigation hint leaves tagging out, so a page never sends a tag read the owner
 * would refuse. Without the hint (server, tests, other hosts) nothing is known and tags are read as before.
 */
export const tagsReadable = (): boolean => documentNavigationModules()?.has(taggingModuleId) ?? true;

/** A failure of a tagging client call; every one (owner problem, gateway problem, transport, schema) is tagged. */
export interface TagCallFailure {
  readonly _tag: string;
}

/** The owner's 403 on the records read, or the gateway's refusal to open the tagging module at all. */
export const isTagReadForbidden = (failure: TagCallFailure): boolean =>
  Predicate.isTagged(failure, 'RecordsForbiddenProblem') || Predicate.isTagged(failure, 'GatewayForbiddenProblem');

/** Status of a failed tag read: a refusal reads as `forbidden` (no tags section), anything else as a retryable error. */
export const tagsFailureStatus = (failure: TagCallFailure): TagsStatus =>
  isTagReadForbidden(failure) ? 'forbidden' : 'error';
