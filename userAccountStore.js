import { MongoClient } from 'mongodb';
import { AccountRecordCipher, assertOwner, isDiscordId } from './accountRecordCipher.js';
import { AppError } from './errors.js';

export { isDiscordId } from './accountRecordCipher.js';

// MongoDB is the only writable account store. A supplied client is a test seam;
// production always requires MONGODB_URI and never falls back to local files.
export class UserAccountStore {
    #cipher;
    #client;
    #db;
    #accounts;
    #ready;
    #closed = false;

    constructor({ encryptionKey = process.env.TOKEN_ENCRYPTION_KEY,
        mongoUri = process.env.MONGODB_URI, databaseName = process.env.MONGODB_DB_NAME || 'control', client } = {}) {
        this.#cipher = new AccountRecordCipher(encryptionKey);
        const name = String(databaseName || '').trim();
        if (!name || Buffer.byteLength(name) > 63 || /[\s/\\."$\0]/.test(name)) {
            throw new AppError('MONGODB_DB_NAME غير صحيح.', 503, 'INVALID_MONGODB_DATABASE');
        }
        if (!client && !String(mongoUri || '').trim()) {
            throw new AppError('أضف رابط MongoDB في متغير البيئة MONGODB_URI.', 503, 'MONGODB_NOT_CONFIGURED');
        }
        try {
            this.#client = client || new MongoClient(String(mongoUri).trim(), {
                appName: 'discord-control', maxPoolSize: 10, minPoolSize: 0,
                serverSelectionTimeoutMS: 8_000, connectTimeoutMS: 8_000,
                socketTimeoutMS: 10_000, waitQueueTimeoutMS: 8_000,
                timeoutMS: 10_000, retryWrites: true,
            });
            this.#db = this.#client.db(name);
            this.#accounts = this.#db.collection('user_accounts', {
                readPreference: 'primary', writeConcern: { w: 'majority', wtimeoutMS: 8_000 },
            });
        }
        catch { throw new AppError('إعداد اتصال MongoDB غير صحيح. تحقق من MONGODB_URI.', 503, 'INVALID_MONGODB_URI'); }
    }

    async initialize() {
        if (this.#closed) throw new AppError('اتصال قاعدة البيانات مغلق.', 503, 'ACCOUNT_STORE_CLOSED');
        if (!this.#ready) {
            this.#ready = (async () => {
                try { await this.#client.connect(); await this.#db.command({ ping: 1 }); }
                catch {
                    throw new AppError('تعذر الاتصال بـ MongoDB. تحقق من MONGODB_URI والسماح باتصال الاستضافة.', 503, 'MONGODB_CONNECTION_FAILED');
                }
            })();
        }
        try { await this.#ready; }
        catch (error) { this.#ready = null; throw error; }
    }

    async listOwners() {
        await this.initialize();
        try {
            const rows = await this.#accounts.find({ deleted: { $ne: true } }, { projection: { _id: 1 } }).toArray();
            return rows.map((row) => row._id).filter(isDiscordId).sort();
        }
        catch { throw new AppError('تعذر قراءة الحسابات من MongoDB.', 503, 'ACCOUNT_STORE_READ_FAILED'); }
    }

    async load(ownerId) {
        assertOwner(ownerId);
        await this.initialize();
        let saved;
        try { saved = await this.#accounts.findOne({ _id: ownerId }); }
        catch { throw new AppError('تعذر قراءة الحساب من MongoDB.', 503, 'ACCOUNT_STORE_READ_FAILED'); }
        if (!saved || saved.deleted === true) return null;
        return this.#cipher.decrypt(ownerId, saved);
    }

    async save(ownerId, record) {
        const payload = this.#cipher.encrypt(ownerId, record);
        await this.initialize();
        try {
            const result = await this.#accounts.replaceOne({ _id: ownerId },
                { _id: ownerId, ...payload, updatedAt: new Date(), deleted: false }, { upsert: true });
            if (!result.acknowledged) throw new Error('Unacknowledged write');
        }
        catch { throw new AppError('تعذر حفظ الحساب في MongoDB. حاول مجددًا بعد عودة الاتصال.', 503, 'ACCOUNT_STORE_WRITE_FAILED'); }
    }

    async remove(ownerId) {
        assertOwner(ownerId);
        await this.initialize();
        try {
            // Remove all encrypted data. Keep only a marker so old .enc backups
            // cannot resurrect a logged-out account on the next deploy.
            const result = await this.#accounts.replaceOne({ _id: ownerId },
                { _id: ownerId, deleted: true, deletedAt: new Date() }, { upsert: true });
            if (!result.acknowledged) throw new Error('Unacknowledged delete');
        }
        catch { throw new AppError('تعذر حذف الحساب المحفوظ من MongoDB.', 503, 'ACCOUNT_STORE_WRITE_FAILED'); }
    }

    async hasRecord(ownerId) {
        assertOwner(ownerId);
        await this.initialize();
        try { return Boolean(await this.#accounts.findOne({ _id: ownerId }, { projection: { _id: 1 } })); }
        catch { throw new AppError('تعذر فحص الحساب في MongoDB.', 503, 'ACCOUNT_STORE_READ_FAILED'); }
    }

    async importLegacy(ownerId, record) {
        const payload = this.#cipher.encrypt(ownerId, record);
        await this.initialize();
        try {
            // Insert only: a newer record (including a deletion marker) wins.
            const result = await this.#accounts.updateOne({ _id: ownerId }, {
                $setOnInsert: { ...payload, updatedAt: new Date(), deleted: false },
            }, { upsert: true });
            if (!result.acknowledged) throw new Error('Unacknowledged import');
            return result.upsertedCount === 1;
        }
        catch { throw new AppError('تعذر ترحيل الحساب إلى MongoDB. أعد المحاولة بعد عودة الاتصال.', 503, 'ACCOUNT_MIGRATION_WRITE_FAILED'); }
    }

    async close() {
        if (this.#closed) return;
        this.#closed = true;
        await this.#ready?.catch(() => {});
        try { await this.#client.close(); }
        catch { throw new AppError('تعذر إغلاق اتصال MongoDB.', 503, 'MONGODB_CLOSE_FAILED'); }
    }
}
