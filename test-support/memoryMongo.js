import { UserAccountStore } from '../userAccountStore.js';

// Offline test double at the driver boundary; production storage/encryption and
// service code still run unchanged. No real MongoDB or Discord credentials used.
const clone = (value) => value == null ? value : structuredClone(value);
export class MemoryMongoClient {
    databases = new Map();
    connectCalls = 0;
    closed = false;
    async connect() { this.connectCalls++; this.closed = false; return this; }
    async close() { this.closed = true; }
    db(name) {
        if (!this.databases.has(name)) {
            const collections = new Map();
            this.databases.set(name, {
                async command() { return { ok: 1 }; },
                collection(collectionName) {
                    if (!collections.has(collectionName)) collections.set(collectionName, new MemoryCollection());
                    return collections.get(collectionName);
                },
            });
        }
        return this.databases.get(name);
    }
}
class MemoryCollection {
    documents = new Map();
    find(filter = {}, options = {}) {
        return { toArray: async () => [...this.documents.values()].filter(document => {
            if (filter._id !== undefined && filter._id !== document._id) return false;
            if (filter.deleted?.$ne === true && document.deleted === true) return false;
            return true;
        }).map(document => options.projection?._id === 1 ? { _id: document._id } : clone(document)) };
    }
    async findOne(filter, options = {}) { return (await this.find(filter, options).toArray())[0] || null; }
    async replaceOne(filter, replacement, { upsert = false } = {}) {
        const exists = this.documents.has(filter._id);
        if (exists || upsert) this.documents.set(filter._id, clone({ ...replacement, _id: filter._id }));
        return { acknowledged: true, matchedCount: Number(exists), upsertedCount: Number(!exists && upsert) };
    }
    async updateOne(filter, update, { upsert = false } = {}) {
        const exists = this.documents.has(filter._id);
        if (!exists && upsert) this.documents.set(filter._id, clone({ _id: filter._id, ...update.$setOnInsert }));
        return { acknowledged: true, matchedCount: Number(exists), upsertedCount: Number(!exists && upsert) };
    }
}
export function createTestStore(options = {}) {
    const client = options.client || new MemoryMongoClient();
    const databaseName = options.databaseName || 'control_test';
    return Object.assign(new UserAccountStore({ ...options, client, databaseName }), {
        testClient: client, testCollection: client.db(databaseName).collection('user_accounts'),
    });
}
export async function rawRecord(store, ownerId) {
    return JSON.stringify(await store.testCollection.findOne({ _id: ownerId }));
}
