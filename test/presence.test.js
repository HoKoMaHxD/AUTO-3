import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OwnerVoicePresence } from '../ownerVoicePresence.js';
import { OWNER, ACCOUNT, GUILD, CATEGORY, VOICE, OTHER, TOKEN } from '../test-support/fixtures.js';

async function fixture(t, initial = false) {
    let client;
    const channels = new Map([[VOICE, { id: VOICE, name: 'الرس', type: 'GUILD_VOICE', parentId: CATEGORY }],
        [OTHER, { id: OTHER, name: 'بريدة', type: 'GUILD_VOICE', parentId: CATEGORY }]]);
    const guild = { id: GUILD, available: true, channels: { cache: channels }, voiceStates: { cache: new Map() } };
    if (initial) guild.voiceStates.cache.set(ACCOUNT, { id: ACCOUNT, channelId: VOICE, sessionId: 'desktop' });
    class Client extends EventEmitter {
        constructor() { super(); client = this; this.user = { id: ACCOUNT }; this.guilds = { cache: new Map([[GUILD, guild]]) }; }
        async login() { this.emit('ready'); }
        async destroy() { this.destroyed = true; }
    }
    const observer = new OwnerVoicePresence({ token: TOKEN, accountId: ACCOUNT, ClientClass: Client });
    t.after(() => observer.shutdown());
    assert.deepEqual(observer.getPresence(GUILD, CATEGORY), { known: false, present: false });
    await observer.start();
    const state = (channel_id, session_id = 'mobile', user_id = ACCOUNT) => observer.observeVoiceState({ guild_id: GUILD, user_id, channel_id, session_id });
    return { observer, client, state, channels, guild };
}
test('initial snapshot and events observe the token account, not the panel controller', async t => {
    const { observer, state } = await fixture(t);
    state(VOICE, 'desktop', OWNER); assert.equal(observer.getPresence(GUILD, CATEGORY).present, false);
    state(VOICE); assert.equal(observer.getPresence(GUILD, CATEGORY).present, true);
    assert.equal(observer.getPresence(GUILD, CATEGORY).channelName, 'الرس');
    state(null); assert.equal(observer.getPresence(GUILD, CATEGORY).present, false);
    const initial = await fixture(t, true); assert.equal(initial.observer.getPresence(GUILD, CATEGORY).present, true);
});
test('wrong category, channel relocation and deleted channel cannot qualify', async t => {
    const { observer, state, channels, client } = await fixture(t);
    state(VOICE); assert.equal(observer.getPresence(GUILD, OTHER).present, false);
    channels.get(VOICE).name = 'عنيزة'; client.emit('channelUpdate');
    assert.equal(observer.getPresence(GUILD, CATEGORY).channelName, 'عنيزة');
    channels.get(VOICE).parentId = OTHER; client.emit('channelUpdate');
    assert.equal(observer.getPresence(GUILD, CATEGORY).present, false);
    channels.delete(VOICE); client.emit('channelDelete');
    assert.equal(observer.getPresence(GUILD, CATEGORY).known, false);
});
test('late disconnect from old desktop session cannot erase newer mobile session', async t => {
    const { observer, state } = await fixture(t);
    state(VOICE, 'desktop'); state(OTHER, 'mobile'); state(null, 'desktop');
    assert.equal(observer.getPresence(GUILD, CATEGORY).channelId, OTHER);
    assert.equal(observer.getPresence(GUILD, CATEGORY).channelName, 'بريدة');
    state(null, 'mobile'); assert.equal(observer.getPresence(GUILD, CATEGORY).present, false);
});
test('voiceStateUpdate supports device changes, and disconnect/reconnect fails closed', async t => {
    const { observer, client } = await fixture(t);
    client.emit('voiceStateUpdate', { id: ACCOUNT, guild: { id: GUILD } }, { id: ACCOUNT, guild: { id: GUILD }, channelId: VOICE, sessionId: 'mobile' });
    assert.equal(observer.getPresence(GUILD, CATEGORY).present, true);
    client.emit('shardDisconnect'); assert.equal(observer.getPresence(GUILD, CATEGORY).known, false);
    client.emit('shardResume'); assert.equal(observer.getPresence(GUILD, CATEGORY).present, true);
    client.emit('guildUnavailable', { id: GUILD }); assert.equal(observer.getPresence(GUILD, CATEGORY).known, false);
});
test('stage rooms under the configured category are accepted, text channels are not', async t => {
    const { observer, state, channels } = await fixture(t);
    channels.get(VOICE).type = 'GUILD_STAGE_VOICE'; state(VOICE);
    assert.equal(observer.getPresence(GUILD, CATEGORY).present, true);
    channels.get(VOICE).type = 'GUILD_TEXT'; assert.equal(observer.getPresence(GUILD, CATEGORY).present, false);
});
