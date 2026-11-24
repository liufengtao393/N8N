import { describe, expect, it, vi } from 'vitest';

import {
	noopLifecycleEventPublisher,
	type LifecycleEventPublisher,
} from '../lifecycle-event-publisher';
import { LifecycleEventPublisherFactory } from '../lifecycle-event-publisher-factory';

describe('LifecycleEventPublisherFactory', () => {
	const publisher: LifecycleEventPublisher = { publish: vi.fn(), stop: vi.fn() };
	const factory = new LifecycleEventPublisherFactory(publisher);

	it('returns the host publisher for an execution that subscribes to all events', () => {
		expect(factory.create({ lifecycleEventSubscription: { kind: 'all' } })).toBe(publisher);
	});

	it('passes only the execution events of an execution that subscribes to them', () => {
		const executionOnly = factory.create({ lifecycleEventSubscription: { kind: 'execution' } });
		const at = '2026-10-29T10:00:00.000Z';
		const completed = {
			type: 'execution:completed',
			executionId: 'e-1',
			workflowId: 'w-1',
			at,
		} as const;

		executionOnly.publish(completed);
		executionOnly.publish({
			...completed,
			type: 'step:started',
			stepId: 's-1',
			nodeId: 'n-1',
			nodeName: 'Set',
			iteration: 0,
		});

		expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(completed);
	});

	it.each([
		['is missing', {}],
		['is null', { lifecycleEventSubscription: null }],
		['is none', { lifecycleEventSubscription: { kind: 'none' as const } }],
	])('returns the no-op publisher when the subscription %s', (_name, execution) => {
		expect(factory.create(execution)).toBe(noopLifecycleEventPublisher);
	});
});
