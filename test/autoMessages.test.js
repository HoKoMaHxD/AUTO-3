import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../errors.js';
import { normalizeSettings } from '../autoMessageSession.js';
import { sessionFixture, SETTINGS, inside, outside, OTHER, CHANNEL, MessageApi, deferred } from '../test-support/fixtures.js';

test('waits 40 full minutes after entry, then repeats the text and plain voice room name in the selected room', async t => {
    const { session, clock, api, enter } = sessionFixture(t, { saved: { ...SETTINGS, content: 'Room' } });
    await clock.advance(4_800_000, session); assert.equal(api.sends.length, 0);
    enter();
    await clock.advance(2_399_999, session); assert.equal(api.sends.length, 0);
    await clock.advance(1, session); assert.equal(api.sends.length, 1);
    assert.equal(api.sends[0].channelId, CHANNEL); assert.equal(api.sends[0].content, 'Room الرس');
    await clock.advance(2_400_000, session); assert.equal(api.sends.length, 2);
    assert.equal(api.sends[1].content, 'Room الرس 2');
    assert.equal(session.getSettings().content, 'Room');
});
test('leaving the category cancels elapsed time; returning starts the whole interval', async t => {
    const { session, clock, api, enter } = sessionFixture(t, { presence: inside() });
    await clock.advance(2_000_000, session); enter(outside());
    assert.equal(session.getState().nextSendAt, null);
    await clock.advance(800_000, session); assert.equal(api.sends.length, 0);
    enter(); await clock.advance(2_399_999, session); assert.equal(api.sends.length, 0);
    await clock.advance(1, session); assert.equal(api.sends.length, 1);
});
test('same-category moves reset the deadline, repeated mute/deafen events preserve it', async t => {
    const { session, clock, api, enter } = sessionFixture(t, { presence: inside() });
    const deadline = session.getState().nextSendAt;
    await clock.advance(60_000, session);
    enter({ ...inside(), channelId: OTHER, channelName: 'بريدة' }); enter({ ...inside(), channelId: OTHER, channelName: 'بريدة' });
    assert.equal(session.getState().nextSendAt, deadline + 60_000);
    await clock.advance(2_399_999, session); assert.equal(api.sends.length, 0);
    await clock.advance(1, session); assert.equal(api.sends.length, 1);
    assert.equal(api.sends[0].content, `${SETTINGS.content} بريدة`);
});
test('the single toggle stops immediately and re-enabling while inside starts a full interval', async t => {
    const { session, clock, api } = sessionFixture(t, { presence: inside() });
    await clock.advance(600_000, session); await session.setEnabled(false);
    await clock.advance(3_000_000, session); assert.equal(api.sends.length, 0);
    await session.setEnabled(true); const deadline = session.getState().nextSendAt;
    await clock.advance(100, session); await session.setEnabled(true);
    assert.equal(session.getState().nextSendAt, deadline, 'duplicate enable clicks cannot reset time');
    await clock.advance(2_399_900, session); assert.equal(api.sends.length, 1);
});
test('disconnect or restart requires a fresh full interval and never catches up missed messages', async t => {
    const { session, clock, api, enter } = sessionFixture(t, { presence: inside() });
    await clock.advance(2_300_000, session); enter({ known: false, present: false });
    assert.equal(session.getState().status, 'checking_voice');
    await clock.advance(2_400_000, session); assert.equal(api.sends.length, 0);
    enter(); await clock.advance(100_000, session); assert.equal(api.sends.length, 0);
    session.suspend(); session.activate();
    await clock.advance(2_399_999, session); assert.equal(api.sends.length, 0);
    await clock.advance(1, session); assert.equal(api.sends.length, 1);
});
test('legacy unconditional schedules are disabled and defaults are 40 minutes', t => {
    const { session, clock } = sessionFixture(t, { saved: { version: 1, enabled: true, nextSendAt: 1, messages: ['old'] }, presence: inside() });
    assert.equal(session.getState().enabled, false); assert.equal(session.getState().intervalMinutes, 40);
    assert.equal(clock.timers.size, 0); assert.equal(session.getSettings().content, '');
});
test('config edits preserve multiline text and reset the current interval only after validation', async t => {
    const { session, clock, api } = sessionFixture(t, { presence: inside() });
    await clock.advance(1_000_000, session);
    await session.configure({ ...SETTINGS, intervalMinutes: '٢', content: '  أول سطر\nثاني سطر  ' });
    await clock.advance(119_999, session); assert.equal(api.sends.length, 0);
    await clock.advance(1, session); assert.equal(api.sends[0].content, '  أول سطر\nثاني سطر الرس');
    assert.equal(session.getSettings().content, '  أول سطر\nثاني سطر  ');
});
test('invalid IDs, categories, empty messages and invalid intervals do not change valid settings', async t => {
    const { session, api } = sessionFixture(t, { presence: inside() });
    for (const intervalMinutes of ['0', '-1', '1.5', '1e2', '1441', '']) {
        assert.throws(() => normalizeSettings({ ...SETTINGS, intervalMinutes }), { code: 'MESSAGE_INTERVAL_INVALID' });
    }
    assert.throws(() => normalizeSettings({ ...SETTINGS, content: '  ' }), { code: 'MESSAGE_TEXT_INVALID' });
    assert.throws(() => normalizeSettings({ ...SETTINGS, guildId: 'bad' }), { code: 'MESSAGE_TARGET_INVALID' });
    api.validateHook = async () => { throw new AppError('bad category', 400, 'MESSAGE_CATEGORY_INVALID'); };
    await assert.rejects(session.configure({ ...SETTINGS, categoryId: OTHER }), { code: 'MESSAGE_CATEGORY_INVALID' });
    assert.equal(session.getSettings().categoryId, SETTINGS.categoryId);
    assert.ok(session.getState().nextSendAt);
});
test('an exit during target validation aborts the operation before sending', async t => {
    const latch = deferred(), api = new MessageApi();
    let signal;
    api.validateHook = async (_, options) => { signal = options.signal; await latch.promise; };
    const { session, clock, enter } = sessionFixture(t, { api, presence: inside() });
    clock.fireNext(clock.time + 2_400_000);
    await new Promise(resolve => setImmediate(resolve));
    enter(outside()); assert.equal(signal.aborted, true); latch.resolve(); await session.drain();
    assert.equal(api.sends.length, 0);
});
test('disabling aborts an in-flight POST and never schedules another send', async t => {
    const latch = deferred(), api = new MessageApi(); let signal;
    api.sendHook = async (_, __, options) => { signal = options.signal; await latch.promise; options.signal.throwIfAborted(); };
    const { session, clock } = sessionFixture(t, { api, presence: inside() });
    clock.fireNext(clock.time + 2_400_000); await new Promise(resolve => setImmediate(resolve));
    await session.setEnabled(false); assert.equal(signal.aborted, true);
    latch.resolve(); await session.drain(); await clock.advance(4_800_000, session);
    assert.equal(api.sends.length, 1); assert.equal(session.getState().nextSendAt, null);
});
test('rate limits retry with the same nonce only while still present', async t => {
    const api = new MessageApi(); let attempts = 0;
    api.sendHook = async () => {
        if (!attempts++) { const error = new AppError('wait', 429, 'MESSAGE_RATE_LIMIT'); error.retryAfterMs = 50_000; throw error; }
    };
    const { session, clock, enter } = sessionFixture(t, { api, presence: inside() });
    await clock.advance(2_400_000, session);
    await clock.advance(49_999, session); assert.equal(api.sends.length, 1);
    await clock.advance(1, session); assert.equal(api.sends.length, 2);
    assert.equal(api.sends[0].nonce, api.sends[1].nonce);
    attempts = 0; await clock.advance(2_400_000, session); enter(outside());
    await clock.advance(100_000, session); assert.equal(api.sends.length, 3);
});
test('channel slowmode delays the next message even when the configured interval is shorter', async t => {
    const api = new MessageApi(); api.slowmodeSeconds = 180;
    const { session, clock } = sessionFixture(t, { saved: { ...SETTINGS, intervalMinutes: 1 }, api, presence: inside() });
    await clock.advance(60_000, session); assert.equal(api.sends.length, 1);
    await clock.advance(179_999, session); assert.equal(api.sends.length, 1);
    await clock.advance(1, session); assert.equal(api.sends.length, 2);
});
test('permission errors and failed durable writes stop automatic messages', async t => {
    const api = new MessageApi(); api.sendHook = async () => { throw new AppError('forbidden', 403, 'MESSAGE_FORBIDDEN'); };
    const first = sessionFixture(t, { api, presence: inside() });
    await first.clock.advance(2_400_000, first.session);
    assert.equal(first.session.getState().enabled, false); assert.equal(first.session.getState().status, 'error');
    const second = sessionFixture(t, { presence: inside(), persist: async () => { throw new Error('database offline'); } });
    await second.clock.advance(2_400_000, second.session);
    assert.equal(second.session.getState().enabled, false);
    await second.clock.advance(9_000_000, second.session); assert.equal(second.api.sends.length, 1);
});
test('save failure during enable leaves no armed timer', async t => {
    const { session, clock } = sessionFixture(t, { saved: { ...SETTINGS, enabled: false }, presence: inside(), persist: async () => { throw new Error('offline'); } });
    await assert.rejects(session.setEnabled(true), { code: 'MESSAGE_SAVE_FAILED' });
    assert.equal(clock.timers.size, 0); assert.equal(session.getState().enabled, false);
});

test('daily limit survives re-entry and resets at Riyadh midnight; removes separator', async t => {
    const { session, clock, api, enter } = sessionFixture(t, { presence: { ...inside(), channelName: '・الرس・' } });
    const enteredAt = session.getState().enteredAt;
    await clock.advance(4_800_000, session);
    assert.equal(session.getState().enteredAt, enteredAt);
    assert.equal(api.sends[0].content, `${SETTINGS.content} الرس`);
    assert.equal(api.sends[1].content, `${SETTINGS.content} الرس 2`);
    assert.equal(session.getState().sentToday, 2);
    enter(outside()); enter({ ...inside(), channelName: '・الرس' });
    await clock.advance(4_800_000, session); assert.equal(api.sends.length, 2);
    session.suspend(); session.activate();
    const midnight = session.getState().dailyResetAt;
    await clock.advance(midnight - clock.time, session);
    assert.equal(session.getState().sentToday, 0);
    await clock.advance(2_400_000, session);
    assert.equal(api.sends.length, 3);
    assert.equal(api.sends[2].content, `${SETTINGS.content} الرس`);
});
test('saved daily quota remains enforced after restart', async t => {
    const { session, clock, api } = sessionFixture(t, { presence: inside(), saved: { ...SETTINGS, dailyDate: '1970-01-01', roomCounts: { 'الرس': 2 } } });
    await clock.advance(4_800_000, session);
    assert.equal(api.sends.length, 0);
    assert.equal(session.getState().status, 'daily_limit');
});

test('each normalized room name has two sends; switching resets timer and returning retains quota', async t => {
    const { session, clock, api, enter } = sessionFixture(t, { presence: inside() });
    await clock.advance(2_400_000, session);
    enter({ ...inside(), channelId: OTHER, channelName: '・بريدة' });
    await clock.advance(2_400_000, session);
    assert.equal(api.sends[1].content, `${SETTINGS.content} بريدة`);
    enter(inside());
    await clock.advance(2_400_000, session);
    assert.equal(api.sends[2].content, `${SETTINGS.content} الرس 2`);
    await clock.advance(2_400_000, session); assert.equal(api.sends.length, 3);
    enter({ ...inside(), channelId: OTHER, channelName: 'بريدة' });
    await clock.advance(2_400_000, session);
    assert.equal(api.sends[3].content, `${SETTINGS.content} بريدة 2`);
    await clock.advance(2_400_000, session); assert.equal(api.sends.length, 4);
    const saved = session.getSettings();
    const restart = sessionFixture(t, { saved, presence: inside() });
    await restart.clock.advance(2_400_000, restart.session); assert.equal(restart.api.sends.length, 0);
});
