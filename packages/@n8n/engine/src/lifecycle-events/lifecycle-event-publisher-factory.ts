import {
	noopLifecycleEventPublisher,
	type LifecycleEventPublisher,
} from './lifecycle-event-publisher';
import type { LifecycleEventSubscription } from './lifecycle-event-subscription.schema';

/**
 * Hands each execution the publisher its subscription calls for: the host's
 * publisher for `all`, a publisher that passes on only the `execution:*` events
 * for `execution`, and a no-op publisher otherwise. A missing or `null`
 * subscription means `none`.
 */
export class LifecycleEventPublisherFactory {
	private readonly executionEventPublisher: LifecycleEventPublisher;

	constructor(private readonly publisher: LifecycleEventPublisher) {
		this.executionEventPublisher = {
			publish: (event) => {
				if (event.type.startsWith('execution:')) publisher.publish(event);
			},
			stop: async () => await publisher.stop(),
		};
	}

	create(execution: {
		lifecycleEventSubscription?: LifecycleEventSubscription | null;
	}): LifecycleEventPublisher {
		const kind = execution.lifecycleEventSubscription?.kind ?? 'none';
		if (kind === 'all') return this.publisher;
		if (kind === 'execution') return this.executionEventPublisher;
		return noopLifecycleEventPublisher;
	}
}
