import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './errors.js';

export class DiscordControlApi {
    #token;
    #fetch;
    #nextRequest = 0;
    #globalUntil = 0;
    constructor({ botToken, fetchImpl = fetch }) { this.#token = botToken; this.#fetch = fetchImpl; }

    async request(method, route, body, { webhook = false } = {}) {
        if (!route.startsWith('/') || route.includes('://') || route.includes('..')) throw new Error('Invalid Discord route');
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const scheduled = Math.max(Date.now(), this.#nextRequest, this.#globalUntil);
            this.#nextRequest = scheduled + 55;
            if (scheduled > Date.now()) await delay(scheduled - Date.now());
            let response;
            let data;
            try {
                response = await this.#fetch(`https://discord.com/api/v10${route}`, {
                    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
                    headers: { 'Content-Type': 'application/json', ...(webhook ? {} : { Authorization: `Bot ${this.#token}` }) },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
                data = response.status === 204 ? null : await response.json();
            }
            catch { throw new AppError('تعذر الاتصال ببوت التحكم. حاول مجددًا.', 502, 'CONTROL_BOT_NETWORK'); }
            if (response.status === 429) {
                const retry = Number(data?.retry_after);
                if (!Number.isFinite(retry) || retry < 0 || retry > 60) break;
                if (data.global) this.#globalUntil = Date.now() + retry * 1000;
                await delay(Math.max(100, retry * 1000));
                continue;
            }
            if (response.ok) return data;
            const discordCode = data?.code ?? 'unknown';
            // Webhook routes contain interaction credentials; never log routes or arbitrary API text.
            console.error(`Discord control request failed: HTTP ${response.status}, code ${discordCode}`);
            if (data?.code === 50007) throw new AppError('تعذر إرسال الخاص. فعّل الرسائل الخاصة من أعضاء السيرفر ثم اضغط «لوحتي».', 403, 'DIRECT_MESSAGES_CLOSED');
            if (response.status === 404) {
                if (String(route).startsWith('/users/@me/channels')) throw new AppError('تعذر فتح الخاص معك. تأكد أن بوت التحكم والعضو في نفس السيرفر وأن الرسائل الخاصة مفعّلة.', 403, 'DIRECT_MESSAGES_CLOSED');
                throw new AppError('رسالة التحكم غير موجودة. افتح /لوحتي مجددًا.', 404, 'CONTROL_MESSAGE_MISSING');
            }
            if (response.status === 401) throw new AppError('تحقق من DISCORD_BOT_TOKEN الخاص ببوت التحكم.', 503, 'CONTROL_BOT_TOKEN_INVALID');
            if (response.status === 403) throw new AppError(`رفض Discord الطلب (403 / ${discordCode}). راجع صلاحيات البوت ورسائل الخاص.`, 403, 'CONTROL_BOT_FORBIDDEN');
            throw new AppError(`رفض Discord الطلب (HTTP ${response.status} / ${discordCode}).`, 502, 'CONTROL_BOT_REQUEST_FAILED');
        }
        throw new AppError('Discord طلب الانتظار. أعد المحاولة بعد قليل.', 429, 'CONTROL_BOT_RATE_LIMIT');
    }
}
