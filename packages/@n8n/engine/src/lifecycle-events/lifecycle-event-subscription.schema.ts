import { z } from 'zod';

/**
 * The lifecycle event subscriptions a caller can ask for. `execution` asks for
 * the `execution:*` events only, `all` adds the `step:*` events.
 */
export const LIFECYCLE_EVENT_SUBSCRIPTION_KINDS = ['none', 'execution', 'all'] as const;

/**
 * Which lifecycle events the caller wants for an execution. The caller sets it
 * at start, and the engine stores it with the execution. A missing value means
 * `none`. `strict`, so a misspelled key fails.
 */
export const lifecycleEventSubscriptionSchema = z
	.object({
		kind: z.enum(LIFECYCLE_EVENT_SUBSCRIPTION_KINDS),
	})
	.strict();

export type LifecycleEventSubscription = z.infer<typeof lifecycleEventSubscriptionSchema>;
