import type { KnowledgeCollectionDto } from '@n8n/api-types';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';

import { useRootStore } from '@n8n/stores/useRootStore';

import { useCollectionsStore } from './collections.store';

const createCollection = vi.fn();
const getCollection = vi.fn();
const listCollectionFiles = vi.fn();
const uploadCollectionFiles = vi.fn();
const deleteCollectionFile = vi.fn();
const listCollectionAgents = vi.fn();

vi.mock('./collections.api', () => ({
	createCollection: async (...args: unknown[]) => await createCollection(...args),
	getCollection: async (...args: unknown[]) => await getCollection(...args),
	listCollectionFiles: async (...args: unknown[]) => await listCollectionFiles(...args),
	uploadCollectionFiles: async (...args: unknown[]) => await uploadCollectionFiles(...args),
	deleteCollectionFile: async (...args: unknown[]) => await deleteCollectionFile(...args),
	listCollectionAgents: async (...args: unknown[]) => await listCollectionAgents(...args),
}));

describe('useCollectionsStore', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ stubActions: false }));
		vi.clearAllMocks();
	});

	it('creates a collection with the REST context and returns it', async () => {
		const created = { id: 'c1', name: 'Support' } as KnowledgeCollectionDto;
		createCollection.mockResolvedValue(created);
		const store = useCollectionsStore();

		await expect(
			store.createCollection('proj-1', { name: 'Support', description: 'Refunds' }),
		).resolves.toBe(created);

		expect(createCollection).toHaveBeenCalledWith(useRootStore().restApiContext, 'proj-1', {
			name: 'Support',
			description: 'Refunds',
		});
	});

	it('passes a refused create on to the caller', async () => {
		const error = new Error('conflict');
		createCollection.mockRejectedValue(error);
		const store = useCollectionsStore();

		await expect(
			store.createCollection('proj-1', { name: 'Support', description: 'Refunds' }),
		).rejects.toBe(error);
	});

	it('calls the collection page endpoints with the REST context', async () => {
		const store = useCollectionsStore();
		const context = useRootStore().restApiContext;
		const files = [new File(['a'], 'a.txt')];

		await store.getCollection('proj-1', 'c1');
		await store.listCollectionFiles('proj-1', 'c1');
		await store.uploadCollectionFiles('proj-1', 'c1', files);
		await store.deleteCollectionFile('proj-1', 'c1', 'f1');
		await store.listCollectionAgents('proj-1', 'c1');

		expect(getCollection).toHaveBeenCalledWith(context, 'proj-1', 'c1');
		expect(listCollectionFiles).toHaveBeenCalledWith(context, 'proj-1', 'c1');
		expect(uploadCollectionFiles).toHaveBeenCalledWith(context, 'proj-1', 'c1', files);
		expect(deleteCollectionFile).toHaveBeenCalledWith(context, 'proj-1', 'c1', 'f1');
		expect(listCollectionAgents).toHaveBeenCalledWith(context, 'proj-1', 'c1');
	});
});
