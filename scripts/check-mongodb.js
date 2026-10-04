import { UserAccountStore } from '../userAccountStore.js';
import { AppError } from '../errors.js';
let store;
try {
    store = new UserAccountStore(); await store.initialize();
    const owners = await store.listOwners();
    for (const id of owners) await store.load(id);
    console.log(`MongoDB connected; ${owners.length} encrypted accounts readable. No data changed.`);
} catch (error) {
    console.error(error instanceof AppError ? `[${error.code}] ${error.message}` : 'MongoDB check failed.'); process.exitCode = 1;
} finally { await store?.close().catch(() => { process.exitCode = 1; }); }
