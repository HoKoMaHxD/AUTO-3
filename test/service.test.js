import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MultiAccountService } from '../multiAccountService.js';
import { AutoMessageSession } from '../autoMessageSession.js';
import { createTestStore, rawRecord } from '../test-support/memoryMongo.js';
import { Clock, MessageApi, Presence, OWNER, ACCOUNT, TOKEN, OTHER, SETTINGS, inside, outside, deferred } from '../test-support/fixtures.js';

async function fixture(t, { store, verifyToken = async () => ({ id: ACCOUNT }) } = {}) {
    store ||= createTestStore({ encryptionKey: randomBytes(32).toString('hex') });
    const clock = new Clock(), apis = [];
    const service = new MultiAccountService({ store, verifyToken, createPresenceObserver: options => new Presence(options),
        createAutoMessages: options => {
            const api = new MessageApi(); apis.push(api);
            return new AutoMessageSession({ ...options, api, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
        } });
    await service.initialize(); t.after(() => service.shutdown());
    return { store, service, clock, apis };
}
test('V43 migration retains encrypted accounts and removes all retired media and unconditional schedules', async t => {
    const store = createTestStore({ encryptionKey: randomBytes(32).toString('hex') });
    await store.save(OWNER, { accountId: ACCOUNT, token: TOKEN, revision: 'a'.repeat(20), rooms: [{ inputUrl: 'old' }],
        streamingStatus: 'old', selectedSection: 'rooms', dmChannelId: OTHER,
        autoMessages: { version: 1, enabled: true, messages: ['old'] } });
    const { service } = await fixture(t, { store });
    const entry = service.get(OWNER), record = await store.load(OWNER);
    assert.equal(entry.accountId, ACCOUNT); assert.equal(entry.dmChannelId, OTHER);
    assert.equal(record.token, TOKEN); assert.equal(record.rooms, undefined); assert.equal(record.streamingStatus, undefined);
    assert.equal(record.autoMessages.enabled, false); assert.equal(record.autoMessages.version, 2);
    assert.equal(entry.rooms, undefined); assert.equal(entry.presence.options.accountId, ACCOUNT);
    assert.equal((await rawRecord(store, OWNER)).includes(TOKEN), false);
    assert.equal(JSON.stringify(service.publicState(OWNER)).includes(TOKEN), false);
});
test('configuration and activation survive restart, but a full new interval is required', async t => {
    const { service, store, clock } = await fixture(t);
    await service.register(OWNER, TOKEN); let entry = service.get(OWNER);
    await service.action(OWNER, entry.revision, 'configure', SETTINGS);
    await service.action(OWNER, entry.revision, 'enable'); entry.presence.change(inside());
    await clock.advance(2_000_000, entry.autoMessages); await service.shutdown();
    const next = await fixture(t, { store }); entry = next.service.get(OWNER);
    assert.equal(entry.autoMessages.getState().enabled, true);
    assert.equal(entry.autoMessages.getState().nextSendAt, null);
    entry.presence.change(inside());
    await next.clock.advance(2_399_999, entry.autoMessages); assert.equal(next.apis[0].sends.length, 0);
    await next.clock.advance(1, entry.autoMessages); assert.equal(next.apis[0].sends.length, 1);
});
test('two users have independent timers, settings and controls; duplicate accounts are rejected', async t => {
    const TOKEN_B = `${TOKEN}.second`;
    const { service, clock, apis } = await fixture(t, { verifyToken: async token => ({ id: token === TOKEN_B ? OTHER : ACCOUNT }) });
    await service.register(OWNER, TOKEN); await service.register(OTHER, TOKEN_B);
    const first = service.get(OWNER), second = service.get(OTHER);
    for (const entry of [first, second]) {
        await service.action(entry.ownerId, entry.revision, 'configure', { ...SETTINGS, intervalMinutes: 1 });
        await service.action(entry.ownerId, entry.revision, 'enable'); entry.presence.change(inside());
    }
    await service.action(OWNER, first.revision, 'disable');
    await clock.advance(60_000, first.autoMessages, second.autoMessages);
    assert.equal(apis[0].sends.length, 0); assert.equal(apis[1].sends.length, 1);
    await assert.rejects(service.register('999999999999999999', TOKEN), { code: 'ACCOUNT_ALREADY_LINKED' });
});
test('changing tokens shuts down the old observer and rejects old panel buttons', async t => {
    const { service } = await fixture(t);
    await service.register(OWNER, TOKEN); const old = service.get(OWNER);
    await service.action(OWNER, old.revision, 'configure', SETTINGS);
    await service.register(OWNER, `${TOKEN}.new`);
    assert.equal(old.presence.stopped, true);
    assert.notEqual(service.get(OWNER).revision, old.revision);
    assert.throws(() => service.get(OWNER, old.revision), { code: 'STALE_PANEL' });
    assert.equal(service.get(OWNER).autoMessages.getSettings().content, SETTINGS.content);
});
test('switching token identity clears the previous account schedule', async t => {
    let account = ACCOUNT;
    const { service } = await fixture(t, { verifyToken: async () => ({ id: account }) });
    await service.register(OWNER, TOKEN); const old = service.get(OWNER);
    await service.action(OWNER, old.revision, 'configure', SETTINGS); await service.action(OWNER, old.revision, 'enable');
    account = OTHER; await service.register(OWNER, `${TOKEN}.new`);
    const state = service.get(OWNER).autoMessages.getState();
    assert.equal(state.enabled, false); assert.equal(state.content, '');
});
test('logout cancels the timer and removes the encrypted token from MongoDB', async t => {
    const { service, store, clock, apis } = await fixture(t);
    await service.register(OWNER, TOKEN); const entry = service.get(OWNER);
    await service.action(OWNER, entry.revision, 'configure', SETTINGS); await service.action(OWNER, entry.revision, 'enable');
    entry.presence.change(inside()); await service.logout(OWNER, entry.revision);
    await clock.advance(3_000_000, entry.autoMessages);
    assert.equal(apis[0].sends.length, 0); assert.equal(entry.presence.stopped, true);
    assert.equal(await store.load(OWNER), null); assert.equal((await rawRecord(store, OWNER)).includes('ciphertext'), false);
});
test('verification in flight cannot activate an account after shutdown', async t => {
    const latch = deferred();
    const { service, store } = await fixture(t, { verifyToken: () => latch.promise });
    const registering = service.register(OWNER, TOKEN);
    const rejected = assert.rejects(registering, { code: 'SERVICE_CLOSING' });
    const shutdown = service.shutdown(); latch.resolve({ id: ACCOUNT }); await rejected; await shutdown;
    assert.equal(await store.load(OWNER), null);
});
test('a failed config save stops sends, marks persistence error and can be saved after database recovery', async t => {
    const { service, store, clock, apis } = await fixture(t);
    await service.register(OWNER, TOKEN); const entry = service.get(OWNER);
    await service.action(OWNER, entry.revision, 'configure', SETTINGS); await service.action(OWNER, entry.revision, 'enable');
    entry.presence.change(inside());
    const save = store.save.bind(store); store.save = async () => { throw new Error('offline'); };
    await assert.rejects(service.action(OWNER, entry.revision, 'configure', { ...SETTINGS, content: 'new' }), { code: 'MESSAGE_SAVE_FAILED' });
    assert.equal(entry.autoMessages.getState().enabled, false); assert.ok(entry.persistenceError);
    await clock.advance(9_000_000, entry.autoMessages); assert.equal(apis[0].sends.length, 0);
    store.save = save; await service.persist(entry);
    assert.equal((await store.load(OWNER)).autoMessages.enabled, false); assert.equal(entry.persistenceError, null);
});
