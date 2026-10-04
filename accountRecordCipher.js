import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from 'node:crypto';
import { AppError } from './errors.js';

export const isDiscordId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
export function assertOwner(ownerId) {
    if (!isDiscordId(ownerId)) throw new AppError('أيدي المستخدم غير صحيح.', 400, 'INVALID_OWNER');
}

// Keep the v1 envelope and AAD compatible with existing encrypted .enc files.
export class AccountRecordCipher {
    #key;
    constructor(encryptionKey = process.env.TOKEN_ENCRYPTION_KEY) {
        const value = String(encryptionKey || '').trim();
        const hex = /^[a-f\d]{64}$/i.test(value);
        const bytes = Buffer.from(value, hex ? 'hex' : 'base64');
        if (bytes.length !== 32 || (!hex && bytes.toString('base64') !== value)) {
            throw new AppError('TOKEN_ENCRYPTION_KEY يجب أن يكون 32 بايت بصيغة Base64 أو hex.', 503, 'TOKEN_ENCRYPTION_NOT_CONFIGURED');
        }
        this.#key = createSecretKey(bytes);
        bytes.fill(0);
    }
    #aad(ownerId) { return Buffer.from(`op-2/user-account/v1/${ownerId}`); }
    encrypt(ownerId, record) {
        assertOwner(ownerId);
        const plaintext = Buffer.from(JSON.stringify({ ...record, ownerId }), 'utf8');
        try {
            if (plaintext.length > 64_000) throw new AppError('بيانات الحساب أكبر من الحد المسموح.', 400, 'ACCOUNT_DATA_TOO_LARGE');
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: 16 });
            cipher.setAAD(this.#aad(ownerId));
            const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
            return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
        }
        finally { plaintext.fill(0); }
    }
    decrypt(ownerId, saved) {
        assertOwner(ownerId);
        let plaintext;
        try {
            if (saved?.version !== 1) throw new Error('Invalid version');
            const decode = (value) => {
                if (typeof value !== 'string' || !value || value.length > 85_336) throw new Error('Invalid field');
                const buffer = Buffer.from(value, 'base64');
                if (buffer.toString('base64') !== value) throw new Error('Invalid encoding');
                return buffer;
            };
            const iv = decode(saved.iv), tag = decode(saved.tag), ciphertext = decode(saved.ciphertext);
            if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 64_000) throw new Error('Invalid record');
            const decipher = createDecipheriv('aes-256-gcm', this.#key, iv, { authTagLength: 16 });
            decipher.setAAD(this.#aad(ownerId));
            decipher.setAuthTag(tag);
            plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            const record = JSON.parse(plaintext.toString('utf8'));
            if (record?.ownerId !== ownerId) throw new Error('Wrong owner');
            return record;
        }
        catch { throw new AppError('تعذر فك بيانات الحساب المحفوظة. تحقق من مفتاح التشفير الأصلي.', 503, 'USER_ACCOUNT_UNREADABLE'); }
        finally { plaintext?.fill(0); }
    }
}
