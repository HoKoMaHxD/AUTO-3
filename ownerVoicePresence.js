import { EventEmitter } from 'node:events';
import { Client } from 'discord.js-selfbot-v13';

// This connection only observes the verified token identity. It never joins voice.
export class OwnerVoicePresence extends EventEmitter {
    #token; #accountId; #Client; #client = null; #states = new Map(); #guilds = new Set();
    #ready = false; #closed = false; #starting = null; #retry = null;
    constructor({ token, accountId, ClientClass = Client }) {
        super(); this.#token = token; this.#accountId = String(accountId); this.#Client = ClientClass;
    }
    #notify() { this.emit('change'); }
    getPresence(guildId, categoryId) {
        if (!this.#ready || !this.#guilds.has(guildId)) return { known: false, present: false };
        const state = this.#states.get(guildId);
        if (!state?.channelId) return { known: true, present: false };
        const guild = this.#client?.guilds?.cache?.get(guildId);
        const channel = guild?.channels?.cache?.get(state.channelId) || this.#client?.channels?.cache?.get(state.channelId);
        if (!channel) return { known: false, present: false };
        const voice = ['GUILD_VOICE', 'GUILD_STAGE_VOICE', 2, 13].includes(channel.type);
        return { known: true, present: voice && String(channel.parentId || '') === categoryId,
            channelId: state.channelId, channelName: channel.name || '' };
    }
    observeVoiceState(data) {
        const guildId = String(data?.guild_id || ''), userId = String(data?.user_id || '');
        if (this.#closed || !guildId || userId !== this.#accountId
            || !(data.channel_id === null || typeof data.channel_id === 'string')) return;
        const previous = this.#states.get(guildId), sessionId = String(data.session_id || '');
        // A delayed leave from an old mobile/desktop session cannot erase a newer join.
        if (!data.channel_id && sessionId && previous?.sessionId && previous.sessionId !== sessionId) return;
        if (data.channel_id) this.#states.set(guildId, { channelId: data.channel_id, sessionId });
        else this.#states.delete(guildId);
        this.#notify();
    }
    #replaceGuild(guild) {
        const id = String(guild?.id || '');
        if (!id) return;
        this.#states.delete(id);
        if (guild.available === false || !guild.voiceStates?.cache) { this.#guilds.delete(id); return; }
        this.#guilds.add(id);
        const voice = guild.voiceStates.cache.get(this.#accountId)
            || [...guild.voiceStates.cache.values()].find(state => String(state.id || state.userId) === this.#accountId);
        if (voice?.channelId) this.#states.set(id, { channelId: String(voice.channelId), sessionId: String(voice.sessionId || '') });
    }
    #unavailable() { this.#ready = false; this.#notify(); }
    start() {
        if (this.#closed || this.#client || this.#starting) return this.#starting || Promise.resolve();
        const client = this.#client = new this.#Client({ checkUpdate: false });
        const current = () => !this.#closed && this.#client === client;
        client.on('ready', () => {
            if (!current()) return;
            if (String(client.user?.id) !== this.#accountId) { this.#restart(client); return; }
            this.#states.clear(); this.#guilds.clear();
            for (const guild of client.guilds?.cache?.values() || []) this.#replaceGuild(guild);
            this.#ready = true; this.#notify();
        });
        client.on('shardResume', () => { if (current()) { this.#ready = true; this.#notify(); } });
        for (const event of ['shardDisconnect', 'shardReconnecting']) client.on(event, () => { if (current()) this.#unavailable(); });
        client.on('invalidated', () => { if (current()) this.#restart(client); });
        client.on('guildCreate', guild => { if (current()) { this.#replaceGuild(guild); this.#notify(); } });
        for (const event of ['guildDelete', 'guildUnavailable']) client.on(event, guild => {
            if (current()) { this.#guilds.delete(String(guild.id)); this.#states.delete(String(guild.id)); this.#notify(); }
        });
        for (const event of ['channelUpdate', 'channelDelete', 'channelCreate']) client.on(event, () => { if (current()) this.#notify(); });
        client.on('voiceStateUpdate', (oldState, newState) => {
            if (current()) this.observeVoiceState({ guild_id: newState.guild?.id || oldState.guild?.id,
                user_id: newState.id || oldState.id, channel_id: newState.channelId,
                session_id: newState.sessionId || oldState.sessionId });
        });
        client.on('error', () => {}); // Never log credentials from library exceptions.
        this.#starting = Promise.resolve().then(() => client.login(this.#token)).catch(() => {
            if (current()) this.#restart(client);
        }).finally(() => { this.#starting = null; });
        return this.#starting;
    }
    #restart(client) {
        this.#unavailable();
        if (this.#client === client) this.#client = null;
        try { void Promise.resolve(client.destroy()).catch(() => {}); } catch {}
        if (this.#closed || this.#retry) return;
        this.#retry = setTimeout(() => { this.#retry = null; void this.start(); }, 15_000);
        this.#retry.unref?.();
    }
    async shutdown() {
        this.#closed = true; clearTimeout(this.#retry);
        const client = this.#client; this.#client = null; this.#ready = false;
        this.#states.clear(); this.#guilds.clear(); this.removeAllListeners();
        try { await client?.destroy(); } catch {}
    }
}
