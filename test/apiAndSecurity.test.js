import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { AccountRecordCipher } from '../accountRecordCipher.js';
import { verifyDiscordToken } from '../discordAccount.js';
import { DiscordMessageApi } from '../discordMessageApi.js';
import { createDiscordControlApp } from '../discordControlServer.js';
import { SETTINGS, GUILD, CATEGORY, CHANNEL, OWNER, ACCOUNT, OTHER, TOKEN } from '../test-support/fixtures.js';

test('category and destination must belong to the configured guild; voice-chat destinations work', async () => {
    let categoryType = 4, guildId = GUILD, channelType = 2;
    const api = new DiscordMessageApi({ token: TOKEN, fetchImpl: async (url, options) => {
        assert.equal(options.headers.Authorization, TOKEN); assert.equal(options.redirect, 'error');
        const id = url.split('/').at(-1);
        return Response.json({ id, guild_id: guildId, type: id === CATEGORY ? categoryType : channelType, rate_limit_per_user: 15 });
    } });
    assert.deepEqual(await api.validateConfiguration(SETTINGS), { id: CHANNEL, slowmodeSeconds: 15 });
    categoryType = 0; await assert.rejects(api.validateConfiguration(SETTINGS), { code: 'MESSAGE_CATEGORY_INVALID' });
    categoryType = 4; guildId = OTHER; await assert.rejects(api.validateConfiguration(SETTINGS), { code: 'MESSAGE_CATEGORY_INVALID' });
    guildId = GUILD; channelType = 15; await assert.rejects(api.validateConfiguration(SETTINGS), { code: 'MESSAGE_CHANNEL_TYPE' });
});
test('messages use fixed Discord routes, exact text and nonce enforcement without pinging mentions', async () => {
    const api = new DiscordMessageApi({ token: TOKEN, fetchImpl: async (url, options) => {
        assert.equal(url, `https://discord.com/api/v10/channels/${CHANNEL}/messages`);
        assert.equal(options.method, 'POST');
        const body = JSON.parse(options.body);
        assert.equal(body.content, SETTINGS.content); assert.equal(body.enforce_nonce, true);
        assert.deepEqual(body.allowed_mentions, { parse: [] });
        return Response.json({ id: OTHER, channel_id: CHANNEL });
    } });
    await api.send(CHANNEL, SETTINGS.content, { nonce: 'a'.repeat(24) });
});
test('Discord 429 cooldown prevents extra requests and honors retry_after', async () => {
    let now = 1000, requests = 0;
    const api = new DiscordMessageApi({ token: TOKEN, now: () => now, fetchImpl: async () => {
        requests++; return Response.json({ retry_after: 12 }, { status: 429 });
    } });
    await assert.rejects(api.validateConfiguration(SETTINGS), error => error.retryAfterMs === 12000);
    await assert.rejects(api.validateConfiguration(SETTINGS), { code: 'MESSAGE_RATE_LIMIT' });
    assert.equal(requests, 1); now += 12001;
    await assert.rejects(api.validateConfiguration(SETTINGS), { code: 'MESSAGE_RATE_LIMIT' }); assert.equal(requests, 2);
});
test('encryption remains V43-compatible, randomized and bound to the owning Discord user', () => {
    const key = randomBytes(32).toString('hex'), cipher = new AccountRecordCipher(key);
    const first = cipher.encrypt(OWNER, { token: TOKEN }), second = cipher.encrypt(OWNER, { token: TOKEN });
    assert.notDeepEqual(first, second); assert.equal(JSON.stringify(first).includes(TOKEN), false);
    assert.equal(new AccountRecordCipher(key).decrypt(OWNER, first).token, TOKEN);
    assert.throws(() => cipher.decrypt(OTHER, first), { code: 'USER_ACCOUNT_UNREADABLE' });
    const altered = { ...first, tag: Buffer.alloc(16).toString('base64') };
    assert.throws(() => cipher.decrypt(OWNER, altered), { code: 'USER_ACCOUNT_UNREADABLE' });
});
test('account verification rejects bots and never echoes a credential in errors', async () => {
    const valid = await verifyDiscordToken(TOKEN, { fetchImpl: async (url, options) => {
        assert.equal(url, 'https://discord.com/api/v10/users/@me'); assert.equal(options.redirect, 'error');
        return Response.json({ id: ACCOUNT });
    } });
    assert.deepEqual(valid, { id: ACCOUNT });
    await assert.rejects(verifyDiscordToken(TOKEN, { fetchImpl: async () => Response.json({ id: ACCOUNT, bot: true }) }), { code: 'DISCORD_TOKEN_CHECK_FAILED' });
    await assert.rejects(verifyDiscordToken(TOKEN, { fetchImpl: async () => { throw new Error(TOKEN); } }), error => !error.message.includes(TOKEN));
});
test('signed interaction endpoint authenticates requests, handles PING and deduplicates deliveries', async t => {
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    let calls = 0;
    const panel = { handle() { calls++; return { type: 5, data: { flags: 64 } }; } };
    const server = createDiscordControlApp({ panel, publicKey, applicationId: ACCOUNT }).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    async function post(payload, { timestamp = String(Math.floor(Date.now() / 1000)), invalid = false } = {}) {
        const body = JSON.stringify(payload), signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex');
        return fetch(`${url}/discord/interactions`, { method: 'POST', body, headers: {
            'Content-Type': 'application/json', 'X-Signature-Timestamp': timestamp,
            'X-Signature-Ed25519': invalid ? '0'.repeat(128) : signature } });
    }
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true });
    assert.deepEqual(await (await post({ type: 1 })).json(), { type: 1 });
    const interaction = { id: OWNER, application_id: ACCOUNT, type: 3, token: 'synthetic-interaction', user: { id: OWNER } };
    assert.equal((await post(interaction, { invalid: true })).status, 401);
    assert.equal((await post(interaction, { timestamp: '1000000000' })).status, 401);
    assert.equal((await post({ ...interaction, application_id: OTHER })).status, 401);
    assert.equal((await post(interaction)).status, 200); assert.equal((await post(interaction)).status, 200);
    assert.equal(calls, 1);
});
