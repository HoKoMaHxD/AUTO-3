import { UserAccountStore, isDiscordId } from './userAccountStore.js';
import { MultiAccountService } from './multiAccountService.js';
import { DiscordControlApi } from './discordControlApi.js';
import { DiscordControlPanel } from './discordControlPanel.js';
import { createDiscordControlApp } from './discordControlServer.js';
import { AppError } from './errors.js';

function envNumber(name, fallback, min, max) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
let store, service, panel, server;
let stopping = false;
async function shutdown(signal, code = 0) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: stopping automatic messages and closing connections.`);
    const forceExit = setTimeout(() => process.exit(1), 20_000); forceExit.unref();
    server?.close();
    await Promise.allSettled([service?.shutdown(), panel?.shutdown()]);
    await store?.close().catch(() => { code = 1; });
    server?.closeAllConnections?.(); clearTimeout(forceExit); process.exit(code);
}
try {
    if (!process.env.DISCORD_BOT_TOKEN) throw new AppError('DISCORD_BOT_TOKEN is required.', 503, 'BOT_TOKEN_REQUIRED');
    const applicationId = process.env.DISCORD_APPLICATION_ID;
    if (!isDiscordId(applicationId)) throw new AppError('DISCORD_APPLICATION_ID is required.', 503, 'APPLICATION_ID_REQUIRED');
    store = new UserAccountStore();
    service = new MultiAccountService({ store, maxAccounts: envNumber('MAX_ACCOUNTS', 0, 0, 100_000) });
    panel = new DiscordControlPanel({ service, applicationId, api: new DiscordControlApi({ botToken: process.env.DISCORD_BOT_TOKEN }) });
    const app = createDiscordControlApp({ panel, applicationId, publicKey: process.env.DISCORD_PUBLIC_KEY });
    await store.initialize();
    await service.initialize();
    server = app.listen(envNumber('PORT', 3000, 1, 65535), '0.0.0.0', () => {
        console.log(`Automatic messages only: ${service.size} encrypted accounts loaded from MongoDB.`);
        console.log('Voice category monitoring is active. No automated voice joins or media players.');
        void panel.installCommands().then(() => console.log('Commands ready: /setup and /لوحتي. Interactions endpoint: /discord/interactions.'))
            .catch(error => console.error(`Command registration failed: ${error instanceof AppError ? error.code : 'SETUP_FAILED'}.`));
    });
    server.on('error', () => { console.error('Unable to start the HTTP listener.'); void shutdown('listener-error', 1); });
} catch (error) {
    console.error(error instanceof AppError ? `Startup failed [${error.code}]: ${error.message}` : 'Startup failed. Sensitive details withheld.');
    await shutdown('startup-error', 1);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', () => { console.error('Unexpected asynchronous failure. Sensitive details withheld.'); });
process.on('uncaughtException', () => { console.error('Unexpected error. Sensitive details withheld.'); void shutdown('uncaughtException', 1); });
