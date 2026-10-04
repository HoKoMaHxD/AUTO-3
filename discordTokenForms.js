import { randomBytes } from 'node:crypto';
import { AppError } from './errors.js';
import { isDiscordId } from './userAccountStore.js';

// Store only one-use form identifiers, never account tokens or submitted fields.
export class DiscordTokenForms {
    #forms = new Map();
    #attempts = new Map();
    #now;

    constructor({ now = Date.now } = {}) { this.#now = now; }

    #prune() {
        const current = this.#now();
        for (const [owner, form] of this.#forms) if (form.expiresAt <= current) this.#forms.delete(owner);
        for (const [owner, record] of this.#attempts) if (current - record.at >= 15 * 60_000) this.#attempts.delete(owner);
    }

    #checkLimit(ownerId) {
        if ((this.#attempts.get(ownerId)?.count || 0) >= 5) {
            throw new AppError('محاولات حفظ كثيرة. انتظر 15 دقيقة ثم اضغط دخول مجددًا.', 429, 'TOKEN_FORM_RATE_LIMIT');
        }
        if (this.#attempts.size >= 5000 && !this.#attempts.has(ownerId)) {
            throw new AppError('محاولات ربط كثيرة. حاول لاحقًا.', 429, 'TOKEN_FORM_CAPACITY');
        }
    }

    issue(ownerId, revision = null) {
        if (!isDiscordId(ownerId)) throw new AppError('هوية غير صحيحة.', 403, 'INVALID_OWNER');
        this.#prune();
        this.#checkLimit(ownerId);
        if (this.#forms.size >= 1000 && !this.#forms.has(ownerId)) {
            throw new AppError('نوافذ ربط كثيرة. حاول بعد قليل.', 429, 'TOKEN_FORM_CAPACITY');
        }
        const customId = `vc-token:${ownerId}:${randomBytes(24).toString('base64url')}`;
        this.#forms.set(ownerId, { customId, revision, expiresAt: this.#now() + 10 * 60_000 });
        return customId;
    }

    consume(ownerId, customId, revision = null) {
        this.#prune();
        const form = this.#forms.get(ownerId);
        if (!isDiscordId(ownerId) || typeof customId !== 'string' || !form || form.customId !== customId) {
            throw new AppError('نافذة التوكن غير صالحة أو انتهت. اضغط دخول لفتح نافذة جديدة.', 403, 'INVALID_TOKEN_FORM');
        }
        this.#forms.delete(ownerId); // Consume before starting any asynchronous verification.
        if (form.revision !== revision) {
            throw new AppError('تغير حسابك منذ فتح النافذة. اضغط دخول من جديد.', 409, 'STALE_TOKEN_FORM');
        }
        this.#checkLimit(ownerId);
        const record = this.#attempts.get(ownerId) || { at: this.#now(), count: 0 };
        record.count += 1;
        this.#attempts.set(ownerId, record);
    }

    revoke(ownerId) { this.#forms.delete(ownerId); }
    clear() { this.#forms.clear(); this.#attempts.clear(); }
}
