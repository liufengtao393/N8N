import type { LifecycleEvent } from '@n8n/engine';
import { OperationalError } from '@n8n/errors';
import type { Mock } from 'vitest';
import { mock } from 'vitest-mock-extended';

import type {
	EngineV2LifecycleSubscriptions,
	LifecycleEventListener,
} from '../engine-lifecycle-event-subscriptions';
import {
	EngineV2ExecutionCompletions,
	type EngineV2CompletionOutcome,
} from '../engine-v2-execution-completions';

const executionId = 'exec-1';
const at = '2026-10-29T10:00:00.000Z';

const ended = (
	type: 'execution:completed' | 'execution:failed' | 'execution:cancelled',
): LifecycleEvent => ({ type, executionId, workflowId: 'wf-1', at });

describe('EngineV2ExecutionCompletions', () => {
	const subscriptions = mock<EngineV2LifecycleSubscriptions>();
	let listeners: LifecycleEventListener[];
	let remove: Mock<() => void>;
	let controller: AbortController;
	let completions: EngineV2ExecutionCompletions;

	const emit = (event: LifecycleEvent) => {
		for (const listener of listeners) listener(event);
	};

	beforeEach(() => {
		vi.useFakeTimers();
		listeners = [];
		controller = new AbortController();
		remove = vi.fn<() => void>();
		subscriptions.listen.mockReset();
		subscriptions.listen.mockImplementation(async (_executionId, listener) => {
			listeners.push(listener);
			return remove;
		});
		completions = new EngineV2ExecutionCompletions(subscriptions);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		['execution:completed', 'success'],
		['execution:failed', 'error'],
		['execution:cancelled', 'canceled'],
	] as const)(
		'reports %s as a finished run with status %s to every pending and later wait',
		async (type, status) => {
			const watch = await completions.watch(executionId);
			const pending = [watch.wait({ timeoutMs: 1_000 }), watch.wait({ timeoutMs: 1_000 })];

			emit(ended(type));

			const finished = { kind: 'finished', status };
			await expect(Promise.all(pending)).resolves.toEqual([finished, finished]);
			await expect(watch.wait({ timeoutMs: 1_000 })).resolves.toEqual(finished);
		},
	);

	it('ignores events that do not end the execution', async () => {
		const watch = await completions.watch(executionId);
		const outcome = watch.wait({ timeoutMs: 1_000 });

		emit({
			type: 'execution:started',
			executionId,
			workflowId: 'wf-1',
			at,
			mode: 'manual',
			hostMode: 'manual',
		});
		await vi.advanceTimersByTimeAsync(1_000);

		await expect(outcome).resolves.toEqual({ kind: 'timeout' });
	});

	it('keeps waiting when the timeout is above the largest delay of setTimeout', async () => {
		const watch = await completions.watch(executionId);
		const outcome = watch.wait({ timeoutMs: 2 ** 31 });

		await vi.advanceTimersByTimeAsync(1_000);
		emit(ended('execution:completed'));

		await expect(outcome).resolves.toEqual({ kind: 'finished', status: 'success' });
	});

	it('resolves as aborted at once when the signal is already aborted', async () => {
		const watch = await completions.watch(executionId);

		await expect(
			watch.wait({ timeoutMs: 1_000, abortSignal: AbortSignal.abort() }),
		).resolves.toEqual({ kind: 'aborted' });
	});

	it.each<[string, () => Promise<unknown>, EngineV2CompletionOutcome]>([
		[
			'the execution ends',
			async () => emit(ended('execution:failed')),
			{ kind: 'finished', status: 'error' },
		],
		[
			'the time runs out',
			async () => await vi.advanceTimersByTimeAsync(1_000),
			{ kind: 'timeout' },
		],
		['the signal aborts', async () => controller.abort(), { kind: 'aborted' }],
	])(
		'ends a pending wait, clears its timer and abort listener, and still records the end when %s',
		async (_name, settle, expected) => {
			const watch = await completions.watch(executionId);
			const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
			const outcome = watch.wait({ timeoutMs: 1_000, abortSignal: controller.signal });

			await settle();

			await expect(outcome).resolves.toEqual(expected);
			expect(vi.getTimerCount()).toBe(0);
			expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
			emit(ended('execution:failed'));
			await expect(watch.wait({ timeoutMs: 1_000 })).resolves.toEqual({
				kind: 'finished',
				status: 'error',
			});
		},
	);

	it.each<[string, () => void, EngineV2CompletionOutcome]>([
		[
			'the execution ends',
			() => emit(ended('execution:completed')),
			{ kind: 'finished', status: 'success' },
		],
		['the watch stops', () => {}, { kind: 'aborted' }],
	])(
		'removes its listener once, stops watching, and resolves a later wait at once when %s',
		async (_name, end, expected) => {
			const watch = await completions.watch(executionId);

			end();
			watch.stop();
			watch.stop();

			expect(remove).toHaveBeenCalledTimes(1);
			expect(completions.isWatching(executionId)).toBe(false);
			await expect(watch.wait({ timeoutMs: 1_000 })).resolves.toEqual(expected);
		},
	);

	it('removes its listener when the end arrives before the subscription is active', async () => {
		subscriptions.listen.mockImplementationOnce(async (_executionId, listener) => {
			listener(ended('execution:completed'));
			return remove;
		});

		const watch = await completions.watch(executionId);

		expect(remove).toHaveBeenCalledTimes(1);
		await expect(watch.wait({ timeoutMs: 1_000 })).resolves.toEqual({
			kind: 'finished',
			status: 'success',
		});
	});

	it('resolves a pending wait as aborted and clears its timer when the watch stops', async () => {
		const watch = await completions.watch(executionId);
		const outcome = watch.wait({ timeoutMs: 1_000 });

		watch.stop();

		await expect(outcome).resolves.toEqual({ kind: 'aborted' });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('watches an execution until every watch of it has stopped or seen the end', async () => {
		let activate = () => {};
		subscriptions.listen.mockImplementationOnce(async (_executionId, listener) => {
			listeners.push(listener);
			await new Promise<void>((resolve) => (activate = resolve));
			return remove;
		});

		expect(completions.isWatching(executionId)).toBe(false);
		const pending = completions.watch(executionId);
		expect(completions.isWatching(executionId)).toBe(true);
		activate();
		const first = await pending;
		await completions.watch(executionId);

		first.stop();
		expect(completions.isWatching(executionId)).toBe(true);
		emit(ended('execution:completed'));
		expect(completions.isWatching(executionId)).toBe(false);
	});

	it('rejects and stops watching when the subscription fails', async () => {
		const failure = new OperationalError('Engine v2 could not subscribe to the lifecycle events');
		subscriptions.listen.mockRejectedValueOnce(failure);

		await expect(completions.watch(executionId)).rejects.toBe(failure);

		expect(completions.isWatching(executionId)).toBe(false);
	});
});
