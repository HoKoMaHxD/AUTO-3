import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { AppError, SupersededError } from './errors.js';
import { isDiscordId } from './accountRecordCipher.js';
import { DiscordMessageApi } from './discordMessageApi.js';

export const DEFAULT_INTERVAL_MINUTES = 40;
export const MAX_INTERVAL_MINUTES = 1440;

const DAY_MS = 86_400_000;
const RIYADH_OFFSET = 3 * 60 * 60_000;
export const dailyKey = now => new Date(now + RIYADH_OFFSET).toISOString().slice(0, 10);
const nextMidnight = now => Math.floor((now + RIYADH_OFFSET) / DAY_MS) * DAY_MS + DAY_MS - RIYADH_OFFSET;

function digits(value) {
    return String(value ?? '').trim().replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632))
        .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776));
}

export function normalizeSettings(values) {
    const guildId = digits(values.guildId), categoryId = digits(values.categoryId), channelId = digits(values.channelId);
    if (![guildId, categoryId, channelId].every(isDiscordId)) {
        throw new AppError('أدخل أيديات صحيحة للسيرفر والكاتقوري وروم الإرسال.', 400, 'MESSAGE_TARGET_INVALID');
    }
    const minutes = digits(values.intervalMinutes);
    if (!/^\d+$/.test(minutes) || Number(minutes) < 1 || Number(minutes) > MAX_INTERVAL_MINUTES) {
        throw new AppError('المدة عدد صحيح من 1 إلى 1440 دقيقة، مثل 40.', 400, 'MESSAGE_INTERVAL_INVALID');
    }
    const content = String(values.content ?? '');
    if (!content.trim() || content.length > 2000) {
        throw new AppError('اكتب الرسالة المطلوبة من 1 إلى 2000 حرف.', 400, 'MESSAGE_TEXT_INVALID');
    }
    return { guildId, categoryId, channelId, intervalMinutes: Number(minutes), content };
}

function loadSettings(saved) {
    const defaults = { version: 2, enabled: false, guildId: '', categoryId: '', channelId: '',
        intervalMinutes: DEFAULT_INTERVAL_MINUTES, content: '', dailyDate: null, dailySent: 0, roomCounts: {}, lastSentAt: null, lastChannelId: null };
    if (saved?.version !== 2) return defaults; // Old unconditional schedules must never resume.
    try {
        return { ...defaults, ...normalizeSettings(saved), enabled: saved.enabled === true,
            dailyDate: /^\d{4}-\d{2}-\d{2}$/.test(saved.dailyDate) ? saved.dailyDate : null,
            roomCounts: Object.fromEntries(Object.entries(saved.roomCounts || {}).filter(([name, count]) => typeof name === 'string' && Number.isInteger(count) && count >= 0 && count <= 2)),
            dailySent: Number.isInteger(saved.dailySent) ? Math.max(0, Math.min(2, saved.dailySent)) : 0,
            lastSentAt: Number.isSafeInteger(saved.lastSentAt) && saved.lastSentAt > 0 ? saved.lastSentAt : null,
            lastChannelId: isDiscordId(saved.lastChannelId) ? saved.lastChannelId : null };
    } catch { return defaults; }
}

export class AutoMessageSession extends EventEmitter {
    #api; #persist; #isCurrent; #getPresence; #settings;
    #now; #setTimer; #clearTimer;
    #active = false; #closed = false; #editing = false;
    #timer = null; #generation = 0; #controller = null; #editController = null;
    #work = Promise.resolve(); #nextSendAt = null; #enteredAt = null;
    #presence = { known: false, present: false }; #eligible = false;
    #status = 'disabled'; #error = null; #failures = 0; #nonce = null; #retryUntil = 0;

    constructor({ token, saved, api = new DiscordMessageApi({ token }), persist = async () => {},
        isCurrent = () => true, getPresence = () => ({ known: false, present: false }),
        now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
        super();
        this.#api = api; this.#persist = persist; this.#isCurrent = isCurrent; this.#getPresence = getPresence;
        this.#settings = loadSettings(saved); this.#now = now; this.#setTimer = setTimer; this.#clearTimer = clearTimer;
    }

    getSettings() { return { ...this.#settings }; }
    getState() {
        return { ...this.getSettings(), sentToday: this.#dailyCount(), dailyResetAt: nextMidnight(this.#now()), status: this.#status, error: this.#error, nextSendAt: this.#nextSendAt,
            enteredAt: this.#enteredAt, presenceKnown: this.#presence.known === true,
            inCategory: this.#eligible, voiceChannelId: this.#presence.channelId || null,
            configured: Boolean(this.#settings.categoryId && this.#settings.content) };
    }
    #roomName() { return String(this.#presence.channelName || '').replace(/・/g, '').trim(); }
    #dailyCount() {
        const name = this.#roomName();
        return this.#settings.dailyDate === dailyKey(this.#now()) && Object.hasOwn(this.#settings.roomCounts, name)
            ? this.#settings.roomCounts[name] : 0;
    }
    #notify() { this.emit('state', this.getState()); }
    #available() { return this.#active && !this.#closed && this.#isCurrent(); }
    #invalidate() {
        this.#generation++;
        this.#clearTimer(this.#timer); this.#timer = null;
        this.#controller?.abort(new SupersededError()); this.#controller = null;
        this.#nextSendAt = null; this.#enteredAt = null; this.#nonce = null;
    }
    #assert(generation, signal) {
        if (!this.#available() || generation !== this.#generation || !this.#settings.enabled || !this.#eligible || this.#editing) {
            throw new SupersededError();
        }
        signal?.throwIfAborted();
    }
    #idleStatus() {
        if (!this.#settings.enabled || !this.#active) return 'disabled';
        return this.#presence.known ? 'waiting_voice' : 'checking_voice';
    }
    activate() {
        if (this.#closed || this.#active || !this.#isCurrent()) return;
        this.#active = true; this.refreshPresence();
    }
    suspend() {
        this.#active = false; this.#eligible = false; this.#invalidate();
        this.#editController?.abort(new SupersededError());
        this.#status = 'disabled'; this.#notify();
    }
    refreshPresence() {
        const previousChannel = this.#presence.channelId;
        const before = JSON.stringify(this.#presence);
        try { this.#presence = this.#getPresence(this.#settings.guildId, this.#settings.categoryId) || { known: false, present: false }; }
        catch { this.#presence = { known: false, present: false }; }
        if (this.#eligible && previousChannel !== this.#presence.channelId) this.#invalidate();
        const eligible = this.#presence.known === true && this.#presence.present === true;
        if (!eligible) {
            if (this.#eligible || this.#timer || this.#controller) this.#invalidate();
            this.#eligible = false;
            if (!this.#editing && this.#status !== 'error') this.#status = this.#idleStatus();
        } else {
            this.#eligible = true;
            if (this.#available() && this.#settings.enabled && !this.#editing && !this.#nextSendAt && this.#status !== 'sending') {
                this.#enteredAt = this.#now();
                this.#schedule(this.#now() + this.#settings.intervalMinutes * 60_000);
            }
        }
        if (before !== JSON.stringify(this.#presence)) this.#notify();
        else if (!eligible) this.#notify();
    }
    async #save() {
        try { await this.#persist(); }
        catch {
            this.#settings.enabled = false; this.#invalidate(); this.#status = 'error';
            this.#error = 'توقف الإرسال لتعذر الحفظ في MongoDB. بعد عودة الاتصال فعّل التلقائي مجددًا.';
            this.#notify();
            throw new AppError(this.#error, 503, 'MESSAGE_SAVE_FAILED');
        }
    }
    async configure(values) {
        const settings = normalizeSettings(values);
        if (this.#editing || !this.#available()) throw new AppError('الإعدادات قيد التحديث. حاول بعد قليل.', 409, 'MESSAGE_BUSY');
        this.#editing = true; this.#invalidate();
        this.#editController = new AbortController();
        const signal = this.#editController.signal;
        this.#status = 'validating'; this.#error = null; this.#notify();
        try {
            await this.#api.validateConfiguration(settings, { signal });
            signal.throwIfAborted();
            if (!this.#available()) throw new SupersededError();
            this.#settings = { ...this.#settings, ...settings };
            await this.#save();
            signal.throwIfAborted();
        } catch (error) {
            if (error instanceof AppError) this.#error = error.message;
            throw error;
        } finally {
            this.#editing = false; this.#editController = null;
            if (this.#status !== 'error') this.#status = this.#idleStatus();
            this.refreshPresence(); this.#notify();
        }
        return this.getState();
    }
    async setEnabled(enabled) {
        if (typeof enabled !== 'boolean') throw new AppError('حالة غير صحيحة.', 400, 'MESSAGE_STATE_INVALID');
        if (this.#editing || !this.#available()) throw new AppError('الإعدادات قيد التحديث. حاول بعد قليل.', 409, 'MESSAGE_BUSY');
        if (enabled === this.#settings.enabled) return this.getState();
        if (enabled) normalizeSettings(this.#settings);
        this.#editing = true; this.#invalidate(); this.#error = null;
        this.#editController = new AbortController();
        const signal = this.#editController.signal;
        // Stop synchronously before any database or Discord request.
        this.#settings.enabled = false; this.#status = enabled ? 'validating' : 'disabled'; this.#notify();
        try {
            if (enabled) await this.#api.validateConfiguration(this.#settings, { signal });
            signal.throwIfAborted();
            if (!this.#available()) throw new SupersededError();
            this.#settings.enabled = enabled;
            await this.#save();
            signal.throwIfAborted();
        } catch (error) {
            this.#settings.enabled = false;
            if (error instanceof AppError) { this.#error = error.message; this.#status = 'error'; }
            throw error;
        } finally {
            this.#editing = false; this.#editController = null;
            if (this.#status !== 'error') this.#status = this.#idleStatus();
            this.refreshPresence(); this.#notify();
        }
        return this.getState();
    }
    #schedule(at) {
        this.#clearTimer(this.#timer); this.#timer = null;
        if (!this.#available() || !this.#settings.enabled || !this.#eligible || this.#editing) return;
        this.#nextSendAt = this.#dailyCount() >= 2 ? nextMidnight(this.#now()) : Math.max(at, this.#retryUntil);
        this.#status = this.#dailyCount() >= 2 ? 'daily_limit' : 'waiting';
        const generation = this.#generation;
        this.#timer = this.#setTimer(() => {
            this.#timer = null;
            if (generation !== this.#generation) return;
            this.#work = this.#work.catch(() => {}).then(() => this.#tick(generation)).catch(() => {});
        }, Math.min(86_400_000, Math.max(1, this.#nextSendAt - this.#now())));
        this.#timer?.unref?.(); this.#notify();
    }
    async #tick(generation) {
        try {
            const wasDailyLimit = this.#status === 'daily_limit';
            this.refreshPresence(); this.#assert(generation);
            if (this.#dailyCount() >= 2 || wasDailyLimit) {
                this.#schedule(this.#now() + this.#settings.intervalMinutes * 60_000); return;
            }
            if (this.#nextSendAt > this.#now()) { this.#schedule(this.#nextSendAt); return; }
            const controller = this.#controller = new AbortController();
            const signal = controller.signal;
            this.#status = 'sending'; this.#notify();
            const channel = await this.#api.validateConfiguration(this.#settings, { signal });
            this.refreshPresence(); this.#assert(generation, signal);
            const last = this.#settings.lastChannelId === this.#settings.channelId ? this.#settings.lastSentAt || 0 : 0;
            const availableAt = last + channel.slowmodeSeconds * 1000;
            if (availableAt > this.#now()) { this.#schedule(availableAt); return; }
            const voiceChannelName = this.#presence.channelName;
            if (typeof voiceChannelName !== 'string' || !voiceChannelName.trim()) {
                throw new AppError('تعذر قراءة اسم رومك الصوتي الحالي؛ ستُعاد المحاولة تلقائيًا.', 503, 'VOICE_CHANNEL_NAME_UNAVAILABLE');
            }
            const cleanName = voiceChannelName.replace(/・/g, '').trim();
            const content = `${this.#settings.content.trimEnd()} ${cleanName}${this.#dailyCount() === 1 ? ' 2' : ''}`;
            if (content.length > 2000) {
                throw new AppError('نص الرسالة مع اسم الروم يتجاوز 2000 حرف. اختصر النص ثم فعّل التلقائي مجددًا.', 400, 'MESSAGE_TEXT_INVALID');
            }
            this.#nonce ||= randomBytes(12).toString('hex');
            await this.#api.send(this.#settings.channelId, content, { nonce: this.#nonce, signal });
            this.#assert(generation, signal);
            const sentDay = dailyKey(this.#now());
            const counts = this.#settings.dailyDate === sentDay ? this.#settings.roomCounts : {};
            this.#settings.roomCounts = { ...counts, [cleanName]: this.#dailyCount() + 1 };
            this.#settings.dailyDate = sentDay;
            this.#settings.lastSentAt = this.#now(); this.#settings.lastChannelId = this.#settings.channelId;
            this.#failures = 0; this.#error = null; this.#nonce = null; this.#retryUntil = 0;
            await this.#save();
            this.#assert(generation, signal);
            this.#schedule(this.#now() + this.#settings.intervalMinutes * 60_000);
        } catch (error) {
            if (generation !== this.#generation || !this.#available() || error instanceof SupersededError) return;
            this.#error = error instanceof AppError ? error.message : 'تعذر الإرسال مؤقتًا؛ ستُعاد المحاولة ما دمت داخل الكاتقوري.';
            if (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) {
                this.#settings.enabled = false; this.#invalidate(); this.#status = 'error'; this.#notify();
                await this.#save();
                return;
            }
            const delay = error.code === 'MESSAGE_RATE_LIMIT'
                ? Math.max(1000, Number(error.retryAfterMs) || 60_000)
                : Math.min(300_000, 30_000 * 2 ** Math.min(this.#failures++, 4));
            this.#retryUntil = this.#now() + delay;
            this.#schedule(this.#retryUntil);
        } finally {
            if (generation === this.#generation) this.#controller = null;
        }
    }
    async drain() { await this.#work; }
    async shutdown() { this.suspend(); this.#closed = true; await this.drain(); this.removeAllListeners(); }
}
