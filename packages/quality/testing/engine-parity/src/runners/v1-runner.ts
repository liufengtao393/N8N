import { ExecutionLifecycleHooks, WorkflowExecute } from 'n8n-core';
import type {
	ExecuteWorkflowData,
	IDataObject,
	INodeExecutionData,
	IRun,
	IWorkflowBase,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import { createRunExecutionData, isTriggerNodeType, jsonParse, Workflow } from 'n8n-workflow';
import { v4 as uuid } from 'uuid';

import type { IrItem, ParityCase } from '../grammar/ir';
import { parityAdditionalData } from './additional-data';
import { parityNodeTypes } from './node-registry';
import type { EngineRunner, RawOutcome } from './runner';
import { CASE_TIMEOUT_MS, TimeoutError, withTimeout } from './runner';

export function toExecutionData(items: IrItem[]): INodeExecutionData[] {
	return items.map((item) => ({ json: jsonParse<IDataObject>(JSON.stringify(item.json)) }));
}

/**
 * Runs a case on engine v1 (`WorkflowExecute`) in this process.
 *
 * The fired trigger starts on the execution stack with the trigger items. The
 * mode is `trigger`, so the trigger passes the items through, as for a
 * production run. Engine v2 gets the same items as its trigger outputs.
 */
export class V1Runner implements EngineRunner {
	readonly name = 'v1';

	async start(): Promise<void> {}

	async stop(): Promise<void> {}

	async run(parityCase: ParityCase): Promise<RawOutcome> {
		const progress: string[] = [];
		try {
			const run = await withTimeout(
				this.execute(
					parityCase,
					parityCase.workflow,
					parityCase.ir.firedTrigger,
					// A node can change its input items in place. Each engine gets its own copy.
					toExecutionData(parityCase.ir.triggerItems),
					'trigger',
					progress,
				),
				CASE_TIMEOUT_MS,
			);
			const { runData, lastNodeExecuted, error } = run.data.resultData;
			return { kind: 'ran', status: run.status, runData, lastNodeExecuted, error };
		} catch (error) {
			if (error instanceof TimeoutError) return { kind: 'timeout', stalledAt: progress };
			throw error;
		}
	}

	private async execute(
		parityCase: ParityCase,
		workflowData: IWorkflowBase,
		startNodeName: string,
		items: INodeExecutionData[],
		mode: WorkflowExecuteMode,
		progress: string[],
	): Promise<IRun> {
		const workflow = new Workflow({
			id: workflowData.id,
			name: workflowData.name,
			nodes: workflowData.nodes,
			connections: workflowData.connections,
			active: false,
			nodeTypes: parityNodeTypes,
			staticData: {},
			settings: workflowData.settings,
		});
		const startNode = workflow.getNode(startNodeName);
		if (!startNode) throw new Error(`The workflow has no node "${startNodeName}"`);

		const executionId = uuid();
		const hooks = new ExecutionLifecycleHooks(mode, executionId, workflowData);
		hooks.addHandler('nodeExecuteAfter', (nodeName) => {
			progress.push(nodeName);
		});
		const additionalData = parityAdditionalData(executionId, {
			hooks,
			executeWorkflow: async (workflowInfo, _parentData, options) =>
				await this.executeSubWorkflow(
					parityCase,
					workflowInfo.id,
					options.inputData ?? [],
					progress,
				),
		});

		const runExecutionData = createRunExecutionData({
			executionData: {
				nodeExecutionStack: [{ node: startNode, data: { main: [items] }, source: null }],
			},
		});
		const workflowExecute = new WorkflowExecute(additionalData, mode, runExecutionData);
		return await workflowExecute.processRunExecutionData(workflow);
	}

	/**
	 * Runs the sub-workflow as the control plane does for a sub-workflow from the
	 * database: in `integrated` mode, and it returns the last run of the last node.
	 * The trigger of the generated sub-workflows is version 1, which returns the
	 * last run only.
	 */
	private async executeSubWorkflow(
		parityCase: ParityCase,
		workflowId: string | undefined,
		items: INodeExecutionData[],
		progress: string[],
	): Promise<ExecuteWorkflowData> {
		const subWorkflow = workflowId === undefined ? undefined : parityCase.subWorkflows[workflowId];
		if (!subWorkflow) throw new Error(`The case has no sub-workflow "${String(workflowId)}"`);
		const trigger = subWorkflow.nodes.find((node) => isTriggerNodeType(node.type));
		if (!trigger) throw new Error(`The sub-workflow "${String(workflowId)}" has no trigger`);

		const run = await this.execute(
			parityCase,
			subWorkflow,
			trigger.name,
			items,
			'integrated',
			progress,
		);
		const { error, lastNodeExecuted, runData } = run.data.resultData;
		if (error) throw error;
		const lastRun = lastNodeExecuted === undefined ? undefined : runData[lastNodeExecuted]?.at(-1);
		return { executionId: uuid(), data: lastRun?.data?.main ?? [null] };
	}
}
