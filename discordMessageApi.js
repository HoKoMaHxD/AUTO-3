import { AppError } from './errors.js';
import { isDiscordId } from './accountRecordCipher.js';

// Guild voice channels use the same message endpoint as text channels.
const messageChannelTypes = new Set([0, 2, 5, 10, 11, 12]);

// Account credentials only go to fixed Discord API routes. This connection does not join voice.
export class DiscordMessageApi {
    #token;
    #fetch;
    #now;
    #retryUntil = 0;
    constructor({ token, fetchImpl = fetch, now = Date.now }) { this.#token = token; this.#fetch = fetchImpl; this.#now = now; }

    async #request(method, channelId, body, signal) {
        if (!isDiscordId(channelId)) throw new AppError('أيدي الشات غير صحيح.', 400, 'MESSAGE_CHANNEL_INVALID');
        signal?.throwIfAborted();
        if (this.#retryUntil > this.#now()) {
            const error = new AppError('Discord طلب الانتظار قبل أي طلب آخر.', 429, 'MESSAGE_RATE_LIMIT');
            error.retryAfterMs = this.#retryUntil - this.#now();
            throw error;
        }
        const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
        let response, data;
        try {
            response = await this.#fetch(`https://discord.com/api/v10/channels/${channelId}${method === 'POST' ? '/messages' : ''}`, {
                method, redirect: 'error', signal: requestSignal,
                headers: { Authorization: this.#token, 'Content-Type': 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            data = await response.json();
        }
        catch {
            signal?.throwIfAborted();
            throw new AppError('تعذر الاتصال بـDiscord. ستُعاد المحاولة بعد انتظار.', 502, 'MESSAGE_NETWORK');
        }
        finally { await response?.body?.cancel().catch(() => {}); }
        signal?.throwIfAborted();
        if (response.status === 429) {
            const seconds = Number(data?.retry_after ?? response.headers?.get('retry-after'));
            const error = new AppError('Discord طلب الانتظار قبل الإرسال التالي.', 429, 'MESSAGE_RATE_LIMIT');
            error.retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? Math.max(1000, Math.ceil(seconds * 1000)) : 60_000;
            this.#retryUntil = this.#now() + error.retryAfterMs;
            throw error;
        }
        if (response.status === 401) throw new AppError('توقف الإرسال: توكن الحساب انتهى أو غير صحيح. حدّثه من لوحتك.', 401, 'MESSAGE_TOKEN_INVALID');
        if (data?.captcha_key || data?.code === 40002) throw new AppError('توقف الإرسال: Discord طلب تحققًا للحساب. أكمله من تطبيق Discord.', 403, 'MESSAGE_VERIFICATION');
        if (response.status === 403) throw new AppError('توقف الإرسال: الحساب لا يملك صلاحية مشاهدة الشات أو إرسال الرسائل فيه.', 403, 'MESSAGE_FORBIDDEN');
        if (response.status === 404) throw new AppError('توقف الإرسال: الشات غير موجود أو غير متاح للحساب.', 404, 'MESSAGE_CHANNEL_MISSING');
        if (!response.ok) {
            if (response.status >= 500) throw new AppError('تعذر الإرسال لدى Discord مؤقتًا. ستُعاد المحاولة بعد انتظار.', 502, 'MESSAGE_SERVER_ERROR');
            throw new AppError('توقف الإرسال: رفض Discord الرسالة. راجع النص وإعدادات الشات.', 400, 'MESSAGE_REJECTED');
        }
        return data;
    }

    async validateTargets(guildId, channelIds, { signal } = {}) {
        if (!isDiscordId(guildId)) throw new AppError('أيدي السيرفر غير صحيح.', 400, 'MESSAGE_GUILD_INVALID');
        const channels = [];
        for (const channelId of channelIds) {
            const channel = await this.#request('GET', channelId, undefined, signal);
            if (String(channel?.id) !== channelId || String(channel?.guild_id) !== guildId) {
                throw new AppError('كل الشاتات يجب أن تكون داخل السيرفر المحدد.', 400, 'MESSAGE_GUILD_MISMATCH');
            }
            if (!messageChannelTypes.has(channel.type) || channel.thread_metadata?.archived || channel.thread_metadata?.locked) {
                throw new AppError('اختر شاتًا نصيًا أو شات روم صوتي متاحًا أو ثريدًا مفتوحًا، وليس منتدى.', 400, 'MESSAGE_CHANNEL_TYPE');
            }
            channels.push({ id: channelId, slowmodeSeconds: Math.max(0, Number(channel.rate_limit_per_user) || 0) });
        }
        return channels;
    }

    async validateConfiguration({ guildId, categoryId, channelId }, { signal } = {}) {
        if (!isDiscordId(guildId) || !isDiscordId(categoryId) || !isDiscordId(channelId)) {
            throw new AppError('أدخل أيديات السيرفر والكاتقوري وروم الإرسال.', 400, 'MESSAGE_TARGET_INVALID');
        }
        const category = await this.#request('GET', categoryId, undefined, signal);
        if (String(category?.id) !== categoryId || category.type !== 4 || String(category.guild_id) !== guildId) {
            throw new AppError('أيدي الكاتقوري يجب أن يكون تصنيفًا داخل السيرفر المحدد.', 400, 'MESSAGE_CATEGORY_INVALID');
        }
        const [channel] = await this.validateTargets(guildId, [channelId], { signal });
        return channel;
    }

    async send(channelId, content, { nonce, signal } = {}) {
        if (typeof content !== 'string' || !content.trim() || content.length > 2000) {
            throw new AppError('كل رسالة يجب أن تكون من 1 إلى 2000 حرف.', 400, 'MESSAGE_TEXT_INVALID');
        }
        if (typeof nonce !== 'string' || !/^[a-f\d]{24}$/.test(nonce)) throw new Error('Invalid message nonce');
        const message = await this.#request('POST', channelId, {
            content, nonce, enforce_nonce: true, allowed_mentions: { parse: [] }, tts: false,
        }, signal);
        if (!isDiscordId(String(message?.id)) || String(message?.channel_id) !== channelId) {
            throw new AppError('تعذر تأكيد إرسال الرسالة. سيُنتظر الفاصل قبل المحاولة التالية.', 502, 'MESSAGE_UNCONFIRMED');
        }
        return { id: message.id };
    }
}
