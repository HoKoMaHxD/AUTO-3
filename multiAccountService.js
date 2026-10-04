import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { AppError } from './errors.js';
import { isDiscordId } from './accountRecordCipher.js';
import { normalizeAccountToken, verifyDiscordToken } from './discordAccount.js';
import { AutoMessageSession } from './autoMessageSession.js';
import { OwnerVoicePresence } from './ownerVoicePresence.js';

export class MultiAccountService extends EventEmitter {
    #store; #verify; #messageFactory; #presenceFactory; #maxAccounts;
    #entries = new Map(); #claims = new Map(); #changes = new Map(); #actions = new Map(); #writes = new Map();
    #closed = false; #retryTimer;
    constructor({ store, verifyToken = verifyDiscordToken, createAutoMessages = options => new AutoMessageSession(options),
        createPresenceObserver = options => new OwnerVoicePresence(options), maxAccounts = 0 }) {
        super(); this.#store = store; this.#verify = verifyToken; this.#messageFactory = createAutoMessages;
        this.#presenceFactory = createPresenceObserver; this.#maxAccounts = maxAccounts;
        this.#retryTimer = setInterval(() => {
            if (!this.#closed) for (const entry of this.#entries.values()) {
                if (entry.persistenceError && !this.#changes.has(entry.ownerId)) void this.persist(entry).catch(() => {});
            }
        }, 30_000);
        this.#retryTimer.unref?.();
    }
    #makeEntry(ownerId, token, accountId, saved = {}) {
        const entry = { ownerId, token, accountId, revision: saved.revision || randomBytes(10).toString('hex'),
            dmChannelId: isDiscordId(saved.dmChannelId) ? saved.dmChannelId : null,
            dmMessageId: isDiscordId(saved.dmMessageId) ? saved.dmMessageId : null, deleted: false };
        entry.presence = this.#presenceFactory({ token, accountId });
        entry.autoMessages = this.#messageFactory({ token, saved: saved.autoMessages,
            persist: () => this.persist(entry),
            isCurrent: () => !this.#closed && !entry.deleted && this.#entries.get(ownerId) === entry && !this.#changes.has(ownerId),
            getPresence: (guildId, categoryId) => entry.presence.getPresence(guildId, categoryId) });
        entry.presence.on('change', () => {
            if (this.#entries.get(ownerId) === entry && !this.#changes.has(ownerId)) entry.autoMessages.refreshPresence();
        });
        entry.autoMessages.on('state', () => {
            if (!this.#closed && this.#entries.get(ownerId) === entry && !this.#changes.has(ownerId)) this.emit('state', ownerId);
        });
        return entry;
    }
    #record(entry) {
        return { ownerId: entry.ownerId, token: entry.token, accountId: entry.accountId, revision: entry.revision,
            dmChannelId: entry.dmChannelId, dmMessageId: entry.dmMessageId, autoMessages: entry.autoMessages.getSettings() };
    }
    #write(ownerId, operation) {
        const next = (this.#writes.get(ownerId) || Promise.resolve()).catch(() => {}).then(operation);
        this.#writes.set(ownerId, next);
        return next.finally(() => { if (this.#writes.get(ownerId) === next) this.#writes.delete(ownerId); });
    }
    #beginChange(ownerId) {
        let finish;
        this.#changes.set(ownerId, new Promise(resolve => { finish = resolve; }));
        this.#entries.get(ownerId)?.autoMessages.suspend();
        return () => {
            this.#changes.delete(ownerId); finish();
            if (!this.#closed) this.#activate(this.#entries.get(ownerId));
        };
    }
    #activate(entry) {
        if (!entry || entry.deleted || this.#closed) return;
        entry.autoMessages.activate();
        void Promise.resolve(entry.presence.start()).catch(() => entry.autoMessages.refreshPresence());
    }
    async initialize() {
        const loaded = [], claims = new Set();
        // Validate every encrypted record before starting any observer.
        for (const ownerId of await this.#store.listOwners()) {
            const saved = await this.#store.load(ownerId);
            if (!saved) continue;
            if (!isDiscordId(saved.accountId) || !/^[a-f\d]{20}$/.test(saved.revision || '') || claims.has(saved.accountId)) {
                throw new AppError('بيانات حساب محفوظ غير صحيحة. لم يبدأ الإرسال.', 503, 'ACCOUNT_RECORD_INVALID');
            }
            const token = normalizeAccountToken(saved.token);
            claims.add(saved.accountId); loaded.push({ ownerId, token, saved });
        }
        for (const { ownerId, token, saved } of loaded) {
            const entry = this.#makeEntry(ownerId, token, saved.accountId, saved);
            this.#entries.set(ownerId, entry); this.#claims.set(saved.accountId, ownerId);
        }
        // Keep tokens and DM identity; strip retired voice/media settings in the saved record.
        for (const entry of this.#entries.values()) await this.persist(entry);
        for (const entry of this.#entries.values()) this.#activate(entry);
    }
    get size() { return this.#entries.size; }
    get(ownerId, revision) {
        if (!isDiscordId(ownerId)) throw new AppError('هوية المستخدم غير صحيحة.', 403, 'INVALID_OWNER');
        if (this.#closed || this.#changes.has(ownerId)) throw new AppError('حسابك قيد التحديث. حاول بعد قليل.', 409, 'ACCOUNT_BUSY');
        const entry = this.#entries.get(ownerId);
        if (!entry) throw new AppError('اضغط دخول لربط حسابك أولًا.', 404, 'ACCOUNT_NOT_REGISTERED');
        if (revision && revision !== entry.revision) throw new AppError('هذه لوحة قديمة. افتح /لوحتي من جديد.', 409, 'STALE_PANEL');
        return entry;
    }
    publicState(ownerId) {
        const entry = this.get(ownerId);
        return { ownerId, accountId: entry.accountId, revision: entry.revision, autoMessages: entry.autoMessages.getState() };
    }
    async register(ownerId, rawToken) {
        if (!isDiscordId(ownerId)) throw new AppError('هوية غير صحيحة.', 403, 'INVALID_OWNER');
        if (this.#closed || this.#changes.has(ownerId) || this.#actions.has(ownerId)) throw new AppError('حسابك قيد التحديث.', 409, 'ACCOUNT_BUSY');
        const token = normalizeAccountToken(rawToken);
        if (!this.#entries.has(ownerId) && this.#maxAccounts > 0 && this.size + this.#changes.size >= this.#maxAccounts) {
            throw new AppError('وصلت الخدمة إلى الحد المسموح للحسابات.', 503, 'ACCOUNT_CAPACITY');
        }
        const finish = this.#beginChange(ownerId), old = this.#entries.get(ownerId);
        let accountId, entry, committed = false;
        try {
            accountId = (await this.#verify(token))?.id;
            if (!isDiscordId(accountId)) throw new AppError('تعذر التحقق من هوية الحساب.', 502, 'DISCORD_TOKEN_CHECK_FAILED');
            if (this.#closed) throw new AppError('الخدمة قيد الإغلاق.', 503, 'SERVICE_CLOSING');
            const claimed = this.#claims.get(accountId);
            if (claimed && claimed !== ownerId) throw new AppError('هذا الحساب مربوط بمستخدم آخر. افصله أولًا.', 409, 'ACCOUNT_ALREADY_LINKED');
            this.#claims.set(accountId, ownerId);
            const previous = old ? this.#record(old) : {};
            // Changing identities must never silently start the new account's schedule.
            if (old && old.accountId !== accountId) previous.autoMessages = undefined;
            entry = this.#makeEntry(ownerId, token, accountId, { ...previous, revision: randomBytes(10).toString('hex') });
            await this.#write(ownerId, () => this.#store.save(ownerId, this.#record(entry)));
            if (old) {
                old.deleted = true;
                await Promise.allSettled([old.presence.shutdown(), old.autoMessages.shutdown()]);
                if (old.accountId !== accountId) this.#claims.delete(old.accountId);
            }
            this.#entries.set(ownerId, entry); committed = true;
        } catch (error) {
            if (!committed && entry) await Promise.allSettled([entry.presence.shutdown(), entry.autoMessages.shutdown()]);
            if (!committed && accountId !== old?.accountId && this.#claims.get(accountId) === ownerId) this.#claims.delete(accountId);
            if (error instanceof AppError) throw error;
            throw new AppError('تعذر ربط الحساب. حاول مجددًا.', 502, 'ACCOUNT_LINK_FAILED');
        } finally { finish(); }
        this.emit('state', ownerId);
        return this.#closed ? null : this.publicState(ownerId);
    }
    async persist(entry) {
        return this.#write(entry.ownerId, async () => {
            if (this.#closed || entry.deleted || this.#entries.get(entry.ownerId) !== entry || this.#changes.has(entry.ownerId)) return;
            try {
                await this.#store.save(entry.ownerId, this.#record(entry));
                if (entry.persistenceError) { entry.persistenceError = null; this.emit('state', entry.ownerId); }
            } catch (error) {
                entry.persistenceError = 'تعذر حفظ الإعدادات في MongoDB. ستُعاد محاولة الحفظ تلقائيًا.';
                this.emit('state', entry.ownerId); throw error;
            }
        });
    }
    async action(ownerId, revision, action, values = {}) {
        const entry = this.get(ownerId, revision);
        if (this.#actions.has(ownerId)) throw new AppError('يوجد طلب قيد التنفيذ. حاول بعد قليل.', 409, 'ACCOUNT_BUSY');
        let finish;
        this.#actions.set(ownerId, new Promise(resolve => { finish = resolve; }));
        try {
            if (action === 'configure') await entry.autoMessages.configure(values);
            else if (action === 'enable') await entry.autoMessages.setEnabled(true);
            else if (action === 'disable') await entry.autoMessages.setEnabled(false);
            else if (action === 'refresh') entry.autoMessages.refreshPresence();
            else throw new AppError('العملية غير معروفة.', 400, 'INVALID_ACTION');
        } finally {
            this.#actions.delete(ownerId); finish(); this.emit('state', ownerId);
        }
        return this.publicState(ownerId);
    }
    async logout(ownerId, revision) {
        const entry = this.get(ownerId, revision);
        if (this.#actions.has(ownerId)) throw new AppError('يوجد طلب قيد التنفيذ.', 409, 'ACCOUNT_BUSY');
        const finish = this.#beginChange(ownerId);
        try {
            await this.#write(ownerId, () => this.#store.remove(ownerId));
            entry.deleted = true;
            await Promise.allSettled([entry.presence.shutdown(), entry.autoMessages.shutdown()]);
            this.#entries.delete(ownerId); this.#claims.delete(entry.accountId);
        } finally { finish(); }
        this.emit('removed', ownerId);
    }
    async shutdown() {
        this.#closed = true; clearInterval(this.#retryTimer);
        for (const entry of this.#entries.values()) entry.autoMessages.suspend();
        await Promise.allSettled([...this.#changes.values(), ...this.#actions.values()]);
        await Promise.allSettled([...this.#entries.values()].map(async entry => {
            await Promise.allSettled([entry.presence.shutdown(), entry.autoMessages.shutdown()]);
            if (!entry.deleted) await this.#write(entry.ownerId, () => this.#store.save(entry.ownerId, this.#record(entry)));
        }));
        await Promise.allSettled([...this.#writes.values()]);
    }
}
