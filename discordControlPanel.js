import { AppError, SupersededError } from './errors.js';
import { isDiscordId } from './accountRecordCipher.js';
import { DiscordTokenForms } from './discordTokenForms.js';

const none = { parse: [] };
const row = (...components) => ({ type: 1, components });
const button = (label, custom_id, style = 2) => ({ type: 2, label, style, custom_id });
const reply = (content, components = []) => ({ type: 4, data: { content, components, flags: 64, allowed_mentions: none } });
const clean = (value, max = 900) => String(value || '').replace(/@/g, '@\u200b').slice(0, max);
const idFor = (entry, action) => `am:${entry.ownerId}:${entry.revision}:${action}`;

export function buildControlPanel(entry) {
    const state = entry.autoMessages.getState(), id = action => idFor(entry, action);
    const labels = { disabled: '🔴 متوقف', waiting_voice: '🟡 ينتظر دخولك الكاتقوري', checking_voice: '🟡 يتحقق من اتصال الحساب',
        validating: 'يتحقق من الإعدادات', waiting: '🟢 يحسب الوقت', daily_limit: '✅ تم إرسال رسالتي هذا الروم اليوم', sending: 'يرسل الرسالة', error: '⚠️ يحتاج مراجعة' };
    const fields = [
        { name: 'الحالة', value: `${labels[state.status] || 'متوقف'}${state.nextSendAt ? `\n${state.status === 'daily_limit' ? 'تصفير اليوم' : 'الإرسال القادم'} <t:${Math.floor(state.nextSendAt / 1000)}:R>` : ''}` },
        { name: 'مؤقت دخول الروم', value: state.enteredAt ? `دخلت <t:${Math.floor(state.enteredAt / 1000)}:R>` : 'ينتظر دخولك' },
        { name: 'إرسال الروم اليوم', value: `${state.sentToday || 0} / 2 · التصفير 12 ليلًا بتوقيت السعودية` },
        { name: 'المدة', value: `${state.intervalMinutes} دقيقة`, inline: true },
        { name: 'السيرفر', value: state.guildId || 'لم يُحدد', inline: true },
        { name: 'الكاتقوري المطلوب', value: state.categoryId ? `<#${state.categoryId}> · ${state.categoryId}` : 'حدد الكاتقوري من إعدادات الرسائل' },
        { name: 'روم إرسال الرسالة', value: state.channelId ? `<#${state.channelId}>` : 'لم يُحدد' },
        { name: 'وجودك في الفويس', value: !state.presenceKnown ? 'جارٍ التحقق' : state.voiceChannelId
            ? `<#${state.voiceChannelId}>${state.inCategory ? ' · داخل الكاتقوري المحدد' : ' · خارج الكاتقوري المحدد'}` : 'خارج الرومات الصوتية' },
        { name: 'النص قبل اسم الروم', value: state.content ? clean(state.content, 980) + (state.content.length > 980 ? '\n… بقية النص في الإعدادات' : '') : 'اكتب رسالتك من إعدادات الرسائل' },
    ];
    if (state.lastSentAt) fields.push({ name: 'آخر إرسال', value: `<t:${Math.floor(state.lastSentAt / 1000)}:R> في <#${state.lastChannelId}>` });
    if (state.error) fields.push({ name: 'تفاصيل الحالة', value: clean(state.error) });
    if (entry.persistenceError) fields.push({ name: 'الحفظ', value: entry.persistenceError });
    return { content: '', allowed_mentions: none,
        embeds: [{ title: 'الرسائل التلقائية', color: state.enabled ? 0x38b67b : 0x475569,
            description: `الحساب المرتبط: <@${entry.accountId}>\nيبدأ العد عند دخول هذا الحساب أي روم صوتي داخل الكاتقوري المحدد، ويُرسل مرتين لكل اسم روم يوميًا؛ الثانية برقم 2. تغيير الروم يبدأ المدة من جديد.\nيُضاف اسم رومك الصوتي الحالي بعد النص ومسافة تلقائيًا، بدون منشن أو الرمز ・.`,
            fields, footer: { text: 'الخروج يصفّر العد · تغيير الروم يصفّر المؤقت · الإعدادات تُحفظ تلقائيًا' } }],
        components: [row(button('⚙️ إعدادات الرسائل', id('configure'), 1),
            button(state.enabled ? '⏹️ إيقاف تلقائي' : '▶️ تفعيل تلقائي', id(state.enabled ? 'disable' : 'enable'), state.enabled ? 4 : 3),
            button('تحديث', id('refresh'))),
        row(button('تغيير التوكن', id('replace')), button('حذف حسابي', id('logout'), 4))] };
}

function field(custom_id, label, value = '', max_length = 20, style = 1, placeholder) {
    return { type: 18, label, component: { type: 4, custom_id, style, required: true, max_length,
        ...(String(value) ? { value: String(value) } : {}), ...(placeholder ? { placeholder } : {}) } };
}
export function buildModal(entry) {
    const settings = entry.autoMessages.getSettings();
    return { type: 9, data: { title: 'إعدادات الرسائل التلقائية', custom_id: idFor(entry, 'submit-configure'), components: [
        field('guildId', 'أيدي السيرفر', settings.guildId),
        field('categoryId', 'أيدي الكاتقوري الذي فيه رومات الفويس', settings.categoryId),
        field('channelId', 'أيدي روم إرسال الرسالة', settings.channelId),
        field('intervalMinutes', 'المدة بالدقائق: من 1 إلى 1440', settings.intervalMinutes, 4, 1, '40'),
        field('content', 'النص قبل اسم الروم', settings.content, 2000, 2, 'مثال: Room — تُرسل Room الرس إذا كنت في روم الرس'),
    ] } };
}
export function modalValues(components = []) {
    const result = Object.create(null);
    const visit = item => {
        if (!item || typeof item !== 'object') return;
        if (item.type === 4 && typeof item.custom_id === 'string' && typeof item.value === 'string') result[item.custom_id] = item.value;
        if (item.component) visit(item.component);
        if (Array.isArray(item.components)) item.components.forEach(visit);
    };
    if (Array.isArray(components)) components.forEach(visit);
    return result;
}
function takeSubmittedToken(components) {
    let token, count = 0;
    const visit = item => {
        if (!item || typeof item !== 'object') return;
        if (item.type === 4 && item.custom_id === 'token') { token = item.value; count++; }
        delete item.value;
        if (item.component) visit(item.component);
        if (Array.isArray(item.components)) item.components.forEach(visit);
    };
    if (Array.isArray(components)) components.forEach(visit);
    return count === 1 && typeof token === 'string' ? token : undefined;
}

export class DiscordControlPanel {
    #service; #api; #forms; #applicationId;
    #jobs = new Set(); #timers = new Map(); #sends = new Map(); #stopped = false;
    constructor({ service, api, forms = new DiscordTokenForms(), applicationId }) {
        this.#service = service; this.#api = api; this.#forms = forms; this.#applicationId = applicationId;
        service.on('state', ownerId => this.scheduleRefresh(ownerId));
        service.on('removed', ownerId => {
            clearTimeout(this.#timers.get(ownerId)); this.#timers.delete(ownerId); this.#forms.revoke(ownerId);
        });
    }
    async installCommands() {
        for (const command of [
            { name: 'setup', description: 'إرسال لوحة الدخول للرسائل التلقائية', default_member_permissions: '32', contexts: [0] },
            { name: 'لوحتي', description: 'إعداد الرسائل المرتبطة بوجودك في الفويس', contexts: [0, 1] },
        ]) await this.#api.request('POST', `/applications/${this.#applicationId}/commands`, { type: 1, integration_types: [0], ...command });
    }
    welcome() {
        return { embeds: [{ title: 'الرسائل التلقائية', color: 0x38b67b,
            description: 'اربط حسابك، ثم حدد الكاتقوري وروم الإرسال والرسالة والمدة من لوحتك بالخاص. يبدأ العد عند دخولك الفويس.\nيُحفظ التوكن مشفّرًا لدى مشغل الخدمة؛ أدخله في نافذة الدخول فقط.' }],
            components: [row(button('دخول', 'vc-login', 3), button('لوحتي', 'vc-panel', 1))], allowed_mentions: none };
    }
    #revision(ownerId) {
        try { return this.#service.get(ownerId).revision; }
        catch (error) { if (error.code === 'ACCOUNT_NOT_REGISTERED') return null; throw error; }
    }
    #loginReply(ownerId) {
        const revision = this.#revision(ownerId);
        const input = field('token', 'توكن حسابك الذي تسمح للخدمة بتشغيله', '', 512);
        input.description = 'لا يُنشر في الشات. يُحفظ مشفّرًا لدى مشغل الخدمة.';
        input.component.min_length = 20;
        return { type: 9, data: { title: revision ? 'تغيير توكن حسابك' : 'ربط حسابك',
            custom_id: this.#forms.issue(ownerId, revision), components: [input] } };
    }
    #background(interaction, operation) {
        const callback = { token: interaction.token };
        const job = Promise.resolve().then(operation).catch(async error => {
            const message = error instanceof AppError ? error.message : error instanceof SupersededError ? 'تم إلغاء العملية.' : 'تعذر تنفيذ الطلب. حاول مجددًا.';
            await this.finish(callback, { content: clean(message), embeds: [], components: [], allowed_mentions: none }).catch(() => {});
        });
        this.#jobs.add(job); void job.finally(() => this.#jobs.delete(job));
    }
    finish(interaction, message) {
        return this.#api.request('PATCH', `/webhooks/${this.#applicationId}/${encodeURIComponent(interaction.token)}/messages/@original`, message, { webhook: true });
    }
    handle(interaction) {
        const tokenForm = interaction.type === 5 && String(interaction.data?.custom_id || '').startsWith('vc-token:');
        let submittedToken = tokenForm ? takeSubmittedToken(interaction.data?.components) : undefined;
        const ownerId = interaction.member?.user?.id || interaction.user?.id;
        if (!isDiscordId(ownerId)) return reply('تعذر التحقق من هويتك.');
        try {
            if (this.#stopped) return reply('الخدمة تعيد التشغيل. حاول بعد قليل.');
            if (tokenForm) {
                const revision = this.#revision(ownerId);
                this.#forms.consume(ownerId, interaction.data.custom_id, revision);
                const callback = { token: interaction.token };
                this.#background(callback, async () => {
                    try {
                        if (this.#revision(ownerId) !== revision) throw new AppError('تغير حسابك. افتح نافذة دخول جديدة.', 409, 'STALE_TOKEN_FORM');
                        await this.#service.register(ownerId, submittedToken);
                    } finally { submittedToken = undefined; }
                    let content = 'تم ربط الحساب. افتح الخاص وحدد إعدادات الرسائل ثم فعّل التلقائي.';
                    try { await this.sendPanel(ownerId); }
                    catch { content = 'تم ربط الحساب، لكن الخاص مغلق. فعّل الرسائل الخاصة ثم افتح /لوحتي.'; }
                    await this.finish(callback, { content, allowed_mentions: none });
                });
                return { type: 5, data: { flags: 64 } };
            }
            if (interaction.type === 2 && interaction.data?.name === 'setup') {
                const permissions = BigInt(interaction.member?.permissions || '0');
                if (!interaction.guild_id || !(permissions & (32n | 8n))) return reply('الأمر يحتاج صلاحية إدارة السيرفر.');
                if (!isDiscordId(interaction.channel_id)) return reply('الشات غير صحيح.');
                this.#background(interaction, async () => {
                    await this.#api.request('POST', `/channels/${interaction.channel_id}/messages`, this.welcome());
                    await this.finish(interaction, { content: 'تم إرسال لوحة الدخول.', allowed_mentions: none });
                });
                return { type: 5, data: { flags: 64 } };
            }
            if (interaction.type === 3 && interaction.data?.custom_id === 'vc-login') return this.#loginReply(ownerId);
            if ((interaction.type === 2 && interaction.data?.name === 'لوحتي') || (interaction.type === 3 && interaction.data?.custom_id === 'vc-panel')) {
                if (!this.#revision(ownerId)) return this.#loginReply(ownerId);
                this.#background(interaction, async () => {
                    await this.sendPanel(ownerId);
                    await this.finish(interaction, { content: 'لوحتك جاهزة في الخاص.', allowed_mentions: none });
                });
                return { type: 5, data: { flags: 64 } };
            }
            const parts = String(interaction.data?.custom_id || '').split(':');
            const [prefix, owner, revision, action] = parts;
            if (prefix === 'vc') return reply('تحدثت اللوحة إلى الرسائل التلقائية فقط. افتح /لوحتي.');
            if (parts.length !== 4 || prefix !== 'am' || owner !== ownerId) return reply('هذه اللوحة ليست لك. افتح /لوحتي.');
            const entry = this.#service.get(ownerId, revision);
            if (interaction.type === 3) {
                if (action === 'replace') return this.#loginReply(ownerId);
                if (action === 'configure') return buildModal(entry);
                if (action === 'logout') return reply('هل تريد إيقاف الرسائل وحذف حسابك وإعداداته المحفوظة؟',
                    [row(button('تأكيد حذف حسابي', idFor(entry, 'confirm-logout'), 4))]);
            }
            const submitted = interaction.type === 5 && action === 'submit-configure';
            if (!submitted && !(interaction.type === 3 && ['enable', 'disable', 'refresh', 'confirm-logout'].includes(action))) return reply('العملية غير مسموحة.');
            const values = submitted ? modalValues(interaction.data.components) : {};
            this.#background(interaction, async () => {
                if (action === 'confirm-logout') {
                    await this.#service.logout(ownerId, revision);
                    if (entry.dmChannelId && entry.dmMessageId) await this.#api.request('PATCH', `/channels/${entry.dmChannelId}/messages/${entry.dmMessageId}`,
                        { content: 'تم إيقاف الرسائل وحذف الحساب.', embeds: [], components: [], allowed_mentions: none }).catch(() => {});
                    await this.finish(interaction, { content: 'تم حذف حسابك وإعداداته.', components: [], allowed_mentions: none });
                    return;
                }
                await this.#service.action(ownerId, revision, submitted ? 'configure' : action, values);
                await this.sendPanel(ownerId);
                await this.finish(interaction, { content: action === 'disable' ? 'تم إيقاف التلقائي وإلغاء العدّ.'
                    : action === 'enable' ? 'تم تفعيل التلقائي. يبدأ العدّ عندما تكون داخل الكاتقوري المحدد.'
                    : submitted ? 'تم حفظ الإعدادات. إذا كان التلقائي مفعّلًا يبدأ العدّ من جديد وأنت داخل الكاتقوري.' : 'تم تحديث لوحتك.',
                    components: [], allowed_mentions: none });
            });
            // Acknowledge immediately; validation, database access and DMs run afterwards.
            return { type: 5, data: { flags: 64 } };
        } catch (error) { return reply(error instanceof AppError ? clean(error.message) : 'تعذر تنفيذ الطلب.'); }
    }
    scheduleRefresh(ownerId) {
        if (this.#stopped || this.#timers.has(ownerId)) return;
        const timer = setTimeout(() => {
            this.#timers.delete(ownerId);
            if (!this.#stopped) void this.sendPanel(ownerId, false).catch(() => {});
        }, 1800);
        timer.unref?.(); this.#timers.set(ownerId, timer);
    }
    sendPanel(ownerId, createIfMissing = true) {
        const next = (this.#sends.get(ownerId) || Promise.resolve()).catch(() => {}).then(async () => {
            if (this.#stopped) return;
            const entry = this.#service.get(ownerId);
            if (!entry.dmChannelId) {
                if (!createIfMissing) return;
                const dm = await this.#api.request('POST', '/users/@me/channels', { recipient_id: ownerId });
                if (!isDiscordId(dm?.id)) throw new AppError('تعذر فتح الخاص.', 502, 'DIRECT_MESSAGES_CLOSED');
                entry.dmChannelId = dm.id;
            }
            if (entry.dmMessageId) {
                try {
                    await this.#api.request('PATCH', `/channels/${entry.dmChannelId}/messages/${entry.dmMessageId}`, buildControlPanel(entry)); return;
                } catch (error) {
                    if (error.code !== 'CONTROL_MESSAGE_MISSING' || !createIfMissing) throw error;
                    entry.dmMessageId = null;
                }
            }
            if (!createIfMissing) return;
            const message = await this.#api.request('POST', `/channels/${entry.dmChannelId}/messages`, buildControlPanel(entry));
            if (!isDiscordId(message?.id)) throw new AppError('تعذر إرسال اللوحة.', 502, 'CONTROL_BOT_REQUEST_FAILED');
            entry.dmMessageId = message.id; await this.#service.persist(entry);
        });
        this.#sends.set(ownerId, next);
        return next.finally(() => { if (this.#sends.get(ownerId) === next) this.#sends.delete(ownerId); });
    }
    async drain() { await Promise.allSettled([...this.#jobs, ...this.#sends.values()]); }
    async shutdown() {
        this.#stopped = true;
        for (const timer of this.#timers.values()) clearTimeout(timer);
        this.#timers.clear(); this.#forms.clear(); await this.drain();
    }
}
