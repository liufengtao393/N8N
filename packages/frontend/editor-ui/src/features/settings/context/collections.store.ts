import type {
	CreateKnowledgeCollectionDto,
	KnowledgeCollectionAgentDto,
	KnowledgeCollectionDto,
	KnowledgeCollectionFileDto,
	KnowledgeCollectionFileListResponse,
} from '@n8n/api-types';
import { defineStore } from 'pinia';
import { useRootStore } from '@n8n/stores/useRootStore';

import * as api from './collections.api';

/** The knowledge collections in Settings > Context > Collections. */
export const useCollectionsStore = defineStore('contextCollections', () => {
	const rootStore = useRootStore();

	async function createCollection(
		projectId: string,
		payload: CreateKnowledgeCollectionDto,
	): Promise<KnowledgeCollectionDto> {
		return await api.createCollection(rootStore.restApiContext, projectId, payload);
	}

	async function getCollection(
		projectId: string,
		collectionId: string,
	): Promise<KnowledgeCollectionDto> {
		return await api.getCollection(rootStore.restApiContext, projectId, collectionId);
	}

	async function listCollectionFiles(
		projectId: string,
		collectionId: string,
	): Promise<KnowledgeCollectionFileListResponse> {
		return await api.listCollectionFiles(rootStore.restApiContext, projectId, collectionId);
	}

	async function uploadCollectionFiles(
		projectId: string,
		collectionId: string,
		files: File[],
	): Promise<KnowledgeCollectionFileDto[]> {
		return await api.uploadCollectionFiles(
			rootStore.restApiContext,
			projectId,
			collectionId,
			files,
		);
	}

	async function deleteCollectionFile(
		projectId: string,
		collectionId: string,
		fileId: string,
	): Promise<void> {
		await api.deleteCollectionFile(rootStore.restApiContext, projectId, collectionId, fileId);
	}

	async function listCollectionAgents(
		projectId: string,
		collectionId: string,
	): Promise<KnowledgeCollectionAgentDto[]> {
		return await api.listCollectionAgents(rootStore.restApiContext, projectId, collectionId);
	}

	return {
		createCollection,
		getCollection,
		listCollectionFiles,
		uploadCollectionFiles,
		deleteCollectionFile,
		listCollectionAgents,
	};
});
