import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DiscordControlPanel, buildControlPanel, buildModal } from '../discordControlPanel.js';
import { AppError } from '../errors.js';
import { sessionFixture, SETTINGS, OWNER, ACCOUNT, CHANNEL, OTHER, TOKEN, inside, deferred } from '../test-support/fixtures.js';

function fixture(t, enabled = true) {
    const { session } = sessionFixture(t, { saved: { ...SETTINGS, enabled }, presence: inside() });
    const entry = { ownerId: OWNER, accountId: ACCOUNT, revision: 'a'.repeat(20), autoMessages: session };
    const service = new EventEmitter(), calls = [], actions = [];
    service.get = (id, revision) => {
        if (id !== OWNER) throw new AppError('not registered', 404, 'ACCOUNT_NOT_REGISTERED');
        if (revision && revision !== entry.revision) throw new AppError('old panel', 409, 'STALE_PANEL');
        return entry;
    };
    service.persist = async () => {};
    service.action = async (...args) => { actions.push(args); };
    const api = { async request(method, route, body) { calls.push({ method, route, body }); return { id: route === '/users/@me/channels' ? CHANNEL : OTHER }; } };
    const panel = new DiscordControlPanel({ service, api, applicationId: ACCOUNT });
    t.after(() => panel.shutdown());
    const click = action => ({ type: 3, user: { id: OWNER }, token: 'synthetic-interaction', data: { custom_id: `am:${OWNER}:${entry.revision}:${action}` } });
    return { entry, service, panel, calls, actions, click };
}
test('panel contains only automatic messages and exactly one dynamic enable/disable button', async t => {
    const { entry } = fixture(t);
    let payload = buildControlPanel(entry);
    let buttons = payload.components.flatMap(row => row.components);
    assert.equal(buttons.filter(b => /:(enable|disable)$/.test(b.custom_id)).length, 1);
    assert.equal(buttons.find(b => b.custom_id.endsWith(':disable')).label, '⏹️ إيقاف تلقائي');
    await entry.autoMessages.setEnabled(false); payload = buildControlPanel(entry);
    buttons = payload.components.flatMap(row => row.components);
    assert.equal(buttons.find(b => b.custom_id.endsWith(':enable')).label, '▶️ تفعيل تلقائي');
    assert.equal(/Twitch|YouTube|FPS|الكام|الشير/.test(JSON.stringify(payload)), false);
    assert.ok(payload.embeds[0].fields.some(field => field.name === 'مؤقت دخول الروم'));
    for (const b of buttons) assert.ok(b.custom_id.length <= 100);
});
test('config modal contains all five required fields, with minutes and multiline content', t => {
    const { entry, panel, click } = fixture(t);
    const response = panel.handle(click('configure'));
    assert.equal(response.type, 9); assert.equal(response.data.components.length, 5);
    const fields = buildModal(entry).data.components.map(item => item.component);
    assert.deepEqual(fields.map(f => f.custom_id), ['guildId', 'categoryId', 'channelId', 'intervalMinutes', 'content']);
    assert.equal(fields[3].value, '40'); assert.equal(fields[4].style, 2);
});
test('buttons ACK immediately while slow work completes in the background', async t => {
    const { service, panel, click, actions, calls } = fixture(t);
    const latch = deferred(); service.action = async (...args) => { actions.push(args); await latch.promise; };
    const response = panel.handle(click('disable'));
    assert.deepEqual(response, { type: 5, data: { flags: 64 } });
    await Promise.resolve(); assert.equal(actions[0][2], 'disable');
    latch.resolve(); await panel.drain();
    assert.ok(calls.some(c => c.route.endsWith('/messages/@original')));
});
test('foreign owners, old revisions and old voice controls never execute an action', async t => {
    const { panel, click, actions } = fixture(t);
    const foreign = click('disable'); foreign.user.id = OTHER;
    assert.equal(panel.handle(foreign).type, 4);
    const old = click('disable'); old.data.custom_id = `am:${OWNER}:${'b'.repeat(20)}:disable`;
    assert.equal(panel.handle(old).type, 4);
    const legacy = click('disable'); legacy.data.custom_id = `vc:${OWNER}:${'a'.repeat(20)}:0:join`;
    assert.match(panel.handle(legacy).data.content, /لوحتي/);
    await panel.drain(); assert.equal(actions.length, 0);
});
test('nested modal values reach the selected account and setup requires manage-guild permission', async t => {
    const { entry, panel, click, actions, calls } = fixture(t);
    const modal = click('submit-configure'); modal.type = 5;
    modal.data.components = buildModal(entry).data.components;
    modal.data.components[3].component.value = '25';
    assert.equal(panel.handle(modal).type, 5); await panel.drain();
    assert.equal(actions[0][2], 'configure'); assert.equal(actions[0][3].intervalMinutes, '25');
    const setup = { type: 2, token: 'synthetic-interaction', data: { name: 'setup' }, channel_id: CHANNEL, guild_id: OTHER,
        member: { user: { id: OWNER }, permissions: '0' } };
    assert.equal(panel.handle(setup).type, 4);
    setup.member.permissions = '32'; assert.equal(panel.handle(setup).type, 5); await panel.drain();
    assert.ok(calls.some(c => c.method === 'POST' && c.route === `/channels/${CHANNEL}/messages` && c.body.embeds?.[0]?.title === 'الرسائل التلقائية'));
});
test('token form is one-use, owner-bound, and credentials are scrubbed from the interaction', async t => {
    const { service, panel } = fixture(t);
    const tokenForm = panel.handle({ type: 3, user: { id: OWNER }, data: { custom_id: 'vc-login' } });
    let saved;
    service.register = async (ownerId, token) => { saved = { ownerId, token }; };
    const submit = { type: 5, user: { id: OWNER }, token: 'synthetic-interaction', data: {
        custom_id: tokenForm.data.custom_id, components: [{ type: 18, component: { type: 4, custom_id: 'token', value: TOKEN } }] } };
    assert.equal(panel.handle(submit).type, 5); assert.equal(JSON.stringify(submit).includes(TOKEN), false);
    await panel.drain(); assert.deepEqual(saved, { ownerId: OWNER, token: TOKEN });
    assert.equal(panel.handle(submit).type, 4);
});
