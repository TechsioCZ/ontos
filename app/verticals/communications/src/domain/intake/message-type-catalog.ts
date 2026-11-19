import { Context, Effect, Layer, Option } from 'effect';

import { approvedMessageTypes } from '../catalog/approved-registry.ts';
import { communicationDecisionLayer } from '../catalog/decision-service.ts';
import type { TransactionalMessageType } from '../catalog/message-type.ts';
import { buildMessageTypeRegistry, findMessageTypeByPurpose } from '../catalog/registry.ts';
import type { MessageTypeRegistry } from '../catalog/registry.ts';
import type { CommunicationPurposeKey, MessageTypeId } from '../catalog/vocabulary.ts';

/**
 * The approved Transactional Message Types as the intake and the handoff need them: by purpose to decide a request,
 * and by type id to re-check a stored intent. The same registry feeds `CommunicationDecisionService`, so the decision
 * and the recheck can never read two different catalogs.
 */
export interface MessageTypeCatalogService {
  readonly byPurpose: (purpose: CommunicationPurposeKey) => Option.Option<TransactionalMessageType>;
  readonly byTypeId: (typeId: MessageTypeId) => Option.Option<TransactionalMessageType>;
}

export class MessageTypeCatalog extends Context.Service<MessageTypeCatalog, MessageTypeCatalogService>()(
  '@app/communications/domain/intake/message-type-catalog/MessageTypeCatalog',
) {}

const serviceOver = (registry: MessageTypeRegistry): MessageTypeCatalogService => ({
  byPurpose: (purpose) => findMessageTypeByPurpose(registry, purpose),
  byTypeId: (typeId) => Option.fromNullishOr(registry.types.find((type) => type.typeId === typeId)),
});

const layerOver = (registry: MessageTypeRegistry) =>
  Layer.merge(Layer.succeed(MessageTypeCatalog, serviceOver(registry)), communicationDecisionLayer(registry));

/** Catalog and decision evaluator over one registry: an invalid approved list fails the layer, never an empty one. */
export const approvedCatalogLayer = (types: readonly TransactionalMessageType[]) =>
  Layer.unwrap(Effect.fromResult(buildMessageTypeRegistry(types)).pipe(Effect.map(layerOver)));

/**
 * The production composition: the explicit approved registry, which currently approves no type. An invalid approved
 * list is a defect of the build itself and never becomes an empty registry that silently drops approved types.
 */
export const productionCatalogLayer = Layer.unwrap(
  Effect.fromResult(buildMessageTypeRegistry(approvedMessageTypes)).pipe(Effect.orDie, Effect.map(layerOver)),
);
