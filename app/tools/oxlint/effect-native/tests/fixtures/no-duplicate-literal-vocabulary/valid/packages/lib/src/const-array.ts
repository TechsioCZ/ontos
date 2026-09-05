// A shared `as const` array is already one authority; the call argument is not an inline list.
import { Schema } from 'effect';

export const ACTION_PROVISIONING_INTENTS = ['grant', 'revoke', 'inspect'] as const;

export const ActionProvisioningIntentSchema = Schema.Literals(ACTION_PROVISIONING_INTENTS);
export const MirroredIntentSchema = Schema.Literals(ACTION_PROVISIONING_INTENTS);
export const SpreadIntentSchema = Schema.Literals([...ACTION_PROVISIONING_INTENTS]);
export const ComputedIntentSchema = Schema.Literals(ACTION_PROVISIONING_INTENTS.slice());
