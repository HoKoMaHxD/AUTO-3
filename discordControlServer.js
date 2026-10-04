import { createPublicKey, verify } from 'node:crypto';
import express from 'express';
import { AppError, publicError } from './errors.js';

export function createDiscordControlApp({ panel, publicKey, applicationId, now = Date.now }) {
    if (!/^[a-f\d]{64}$/i.test(publicKey || '')) throw new AppError('أضف DISCORD_PUBLIC_KEY من صفحة General Information للتطبيق.', 503, 'INVALID_DISCORD_PUBLIC_KEY');
    const verifyKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
    const seen = new Map();
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            'Strict-Transport-Security': 'max-age=31536000', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
        next();
    });
    app.get('/health', (req, res) => res.json({ ok: true }));
    app.post('/discord/interactions', express.raw({ type: 'application/json', limit: '64kb' }), (req, res) => {
        const signature = req.get('X-Signature-Ed25519') || '';
        const timestamp = req.get('X-Signature-Timestamp') || '';
        if (!Buffer.isBuffer(req.body) || !/^[a-f\d]{128}$/i.test(signature) || !/^\d{10,13}$/.test(timestamp)
            || Math.abs(now() - Number(timestamp) * 1000) > 300_000
            || !verify(null, Buffer.concat([Buffer.from(timestamp), req.body]), verifyKey, Buffer.from(signature, 'hex'))) {
            return res.status(401).json({ error: 'Invalid request signature' });
        }
        let interaction;
        try { interaction = JSON.parse(req.body.toString('utf8')); }
        catch { return res.status(400).json({ error: 'Invalid JSON' }); }
        finally { req.body.fill(0); req.body = undefined; }
        if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) return res.status(400).json({ error: 'Invalid interaction' });
        if (interaction.application_id && interaction.application_id !== applicationId) return res.status(401).json({ error: 'Wrong application' });
        if (interaction.type === 1) return res.json({ type: 1 });
        if (!/^\d{17,20}$/.test(interaction.id || '') || typeof interaction.token !== 'string' || !/^[\w.-]{1,512}$/.test(interaction.token)) return res.status(400).json({ error: 'Invalid interaction' });
        for (const [id, record] of seen) if (now() - record.at >= 300_000) seen.delete(id);
        if (seen.has(interaction.id)) return res.json(seen.get(interaction.id).response);
        if (seen.size >= 10000) return res.status(429).json({ error: 'Please retry later' });
        const response = panel.handle(interaction);
        seen.set(interaction.id, { at: now(), response });
        return res.json(response);
    });
    // This is only Discord's signed callback and Render's health endpoint. No website or token API.
    app.use((req, res) => res.status(404).json({ ok: false, error: 'المسار غير موجود.' }));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const safe = error instanceof SyntaxError || error.type === 'entity.too.large'
            ? new AppError('بيانات الطلب غير صحيحة.', 400, 'INVALID_JSON') : publicError(error);
        res.status(safe.statusCode).json({ ok: false, error: safe.message, code: safe.code });
    });
    return app;
}
