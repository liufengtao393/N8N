import { Service } from '@n8n/di';
import type { LifecycleEvent } from '@n8n/engine';
import type { ExecutionStatus } from 'n8n-workflow';

import { EngineV2LifecycleSubscriptions } from './engine-lifecycle-event-subscriptions';

type FinishedStatus = Extract<ExecutionStatus, 'success' | 'error' | 'canceled'>;

export type EngineV2CompletionOutcome =
	| { kind: 'finished'; status: FinishedStatus }
	| { kind: 'timeout' }
	| { kind: 'aborted' };

export type EngineV2CompletionWaitOptions = { timeoutMs: number; abortSignal?: AbortSignal };

/** Node runs a longer `setTimeout` delay after 1 ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface EngineV2CompletionWatch {
	/**
	 * Resolves when the execution ends, the time runs out, the signal aborts, or
	 * the watch stops. Never rejects. Does not stop the watch or cancel the run.
	 * `timeoutMs` is required: delivery is at-most-once, so the end can be lost.
	 */
	wait(options: EngineV2CompletionWaitOptions): Promise<EngineV2CompletionOutcome>;
	/** Ends the watch and resolves each pending wait as `aborted`. */
	stop(): void;
}

const FINISHED_STATUS: Partial<Record<LifecycleEvent['type'], FinishedStatus>> = {
	'execution:completed': 'success',
	'execution:failed': 'error',
	'execution:cancelled': 'canceled',
};

class CompletionWatch implements EngineV2CompletionWatch {
	private outcome?: EngineV2CompletionOutcome;

	private removeListener?: () => void;

	private readonly waiters = new Set<(outcome: EngineV2CompletionOutcome) => void>();

	constructor(private readonly onEnd: () => void) {}

	/** The end can arrive before `listen` returns the remove function. */
	attach(removeListener: () => void): void {
		if (this.outcome) removeListener();
		else this.removeListener = removeListener;
	}

	receive(event: LifecycleEvent): void {
		const status = FINISHED_STATUS[event.type];
		if (status !== undefined) this.end({ kind: 'finished', status });
	}

	async wait({
		timeoutMs,
		abortSignal,
	}: EngineV2CompletionWaitOptions): Promise<EngineV2CompletionOutcome> {
		if (this.outcome) return this.outcome;
		if (abortSignal?.aborted) return { kind: 'aborted' };

		return await new Promise((resolve) => {
			const settle = (outcome: EngineV2CompletionOutcome) => {
				clearTimeout(timer);
				abortSignal?.removeEventListener('abort', onAbort);
				this.waiters.delete(settle);
				resolve(outcome);
			};
			const onAbort = () => settle({ kind: 'aborted' });
			const delay = Math.min(timeoutMs, MAX_TIMER_DELAY_MS);
			const timer = setTimeout(() => settle({ kind: 'timeout' }), delay).unref();
			abortSignal?.addEventListener('abort', onAbort, { once: true });
			this.waiters.add(settle);
		});
	}

	stop(): void {
		this.end({ kind: 'aborted' });
	}

	private end(outcome: EngineV2CompletionOutcome): void {
		if (this.outcome) return;

		this.outcome = outcome;
		this.removeListener?.();
		this.onEnd();
		for (const settle of [...this.waiters]) settle(outcome);
	}
}

/**
 * Lets control-plane code wait for the end of an engine v2 execution without
 * polling. Events are not replayed, so watch the execution before it starts.
 * Only an engine v2 run sends events: the workflow sets `engineType: 'v2'`, and
 * `EngineV2Dispatcher.routesToEngineV2` routes its mode. For any other run,
 * `run()` returns a different id, and `wait` ends with `timeout`.
 *
 * ```ts
 * const executionId = createExecutionIdV2();
 * const watch = await completions.watch(executionId);
 * try {
 * 	// For an engine v2 run, `run()` returns `executionId`.
 * 	await workflowRunner.run({ ...runData, engineV2ExecutionId: executionId });
 * 	const outcome = await watch.wait({ timeoutMs });
 * } finally {
 * 	watch.stop();
 * }
 * ```
 *
 * On `timeout` or `aborted`, the caller decides what to do with the run, and
 * reads the data plane for its status.
 */
@Service()
export class EngineV2ExecutionCompletions {
	/** The number of active watches of each execution. */
	private readonly watchCounts = new Map<string, number>();

	constructor(private readonly subscriptions: EngineV2LifecycleSubscriptions) {}

	/**
	 * Resolves once the subscription is active.
	 *
	 * @throws {UnexpectedError} If the lifecycle event receiver is not set.
	 * @throws {OperationalError} If the subscription fails or times out.
	 */
	async watch(executionId: string): Promise<EngineV2CompletionWatch> {
		this.watchCounts.set(executionId, (this.watchCounts.get(executionId) ?? 0) + 1);
		const watch = new CompletionWatch(() => this.release(executionId));
		try {
			watch.attach(await this.subscriptions.listen(executionId, (event) => watch.receive(event)));
		} catch (error) {
			watch.stop();
			throw error;
		}

		return watch;
	}

	/** True from the call to `watch` until every watch of the execution has ended. */
	isWatching(executionId: string): boolean {
		return this.watchCounts.has(executionId);
	}

	private release(executionId: string): void {
		const count = this.watchCounts.get(executionId) ?? 0;
		if (count > 1) this.watchCounts.set(executionId, count - 1);
		else this.watchCounts.delete(executionId);
	}
}
