import { EventEmitter } from 'node:events';
import { AutoMessageSession } from '../autoMessageSession.js';

export const OWNER = '111111111111111111', ACCOUNT = '222222222222222222';
export const GUILD = '333333333333333333', CATEGORY = '444444444444444444';
export const CHANNEL = '555555555555555555', VOICE = '666666666666666666';
export const OTHER = '777777777777777777';
export const TOKEN = 'synthetic.account_token.abcdefghijklmnopqrstuvwxyz';
export const SETTINGS = { version: 2, enabled: true, guildId: GUILD, categoryId: CATEGORY,
    channelId: CHANNEL, intervalMinutes: 40, content: 'الرسالة المحددة\nبالسطر الثاني' };
export const inside = () => ({ known: true, present: true, channelId: VOICE, channelName: 'الرس' });
export const outside = () => ({ known: true, present: false });

export class Clock {
    time = 1_000_000; timers = new Map(); sequence = 0;
    now = () => this.time;
    setTimer = (fn, delay) => { const id = ++this.sequence; this.timers.set(id, { fn, at: this.time + delay }); return id; };
    clearTimer = id => this.timers.delete(id);
    fireNext(until) {
        const first = [...this.timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) { this.time = until; return false; }
        this.time = first[1].at; this.timers.delete(first[0]); first[1].fn(); return true;
    }
    async advance(ms, ...sessions) {
        const until = this.time + ms;
        while (this.fireNext(until)) await Promise.all(sessions.map(session => session.drain()));
    }
}
export class MessageApi {
    sends = []; validations = []; slowmodeSeconds = 0; validateHook = null; sendHook = null;
    async validateConfiguration(settings, options) {
        this.validations.push({ ...settings });
        if (this.validateHook) await this.validateHook(settings, options);
        return { id: settings.channelId, slowmodeSeconds: this.slowmodeSeconds };
    }
    async send(channelId, content, options) {
        this.sends.push({ channelId, content, ...options });
        if (this.sendHook) await this.sendHook(channelId, content, options);
        return { id: '888888888888888888' };
    }
}
export function sessionFixture(t, { saved = SETTINGS, presence = outside(), api = new MessageApi(), persist = async () => {} } = {}) {
    const clock = new Clock(); let current = presence;
    const session = new AutoMessageSession({ token: TOKEN, saved, api, persist,
        now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, getPresence: () => current });
    session.activate(); t.after(() => session.shutdown());
    return { session, api, clock, enter(value = inside()) { current = value; session.refreshPresence(); } };
}
export class Presence extends EventEmitter {
    state = outside(); started = false; stopped = false;
    constructor(options) { super(); this.options = options; }
    getPresence() { return this.state; }
    async start() { this.started = true; }
    change(state) { this.state = state; this.emit('change'); }
    async shutdown() { this.stopped = true; this.removeAllListeners(); }
}
export const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
