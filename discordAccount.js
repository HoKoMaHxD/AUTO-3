import { AppError } from './errors.js';

export function normalizeAccountToken(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{20,512}$/.test(value.trim())) {
        throw new AppError('أدخل توكن حساب صالحًا بدون بادئة أو مسافات داخلية.', 400, 'INVALID_ACCOUNT_TOKEN');
    }
    return value.trim();
}

// A fixed HTTPS destination: never send this credential to user-supplied URLs.
export async function verifyDiscordToken(token, { fetchImpl = fetch } = {}) {
    let response;
    try {
        response = await fetchImpl('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: token },
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 401) {
            throw new AppError('التوكن غير صحيح أو انتهت صلاحيته. لم يتم تغيير الحساب.', 400, 'DISCORD_TOKEN_INVALID');
        }
        if (response.status === 429) {
            throw new AppError('Discord طلب الانتظار. حاول حفظ التوكن لاحقًا.', 429, 'DISCORD_RATE_LIMITED');
        }
        if (!response.ok) throw new Error('Verification unavailable');
        const user = await response.json();
        if (!/^\d{17,20}$/.test(String(user?.id || '')) || user.bot) throw new Error('Unexpected account');
        return { id: String(user.id) };
    }
    catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('تعذر التحقق من الحساب لدى Discord. حاول لاحقًا؛ لم يتم تغيير الحساب.', 502, 'DISCORD_TOKEN_CHECK_FAILED');
    }
    finally { await response?.body?.cancel().catch(() => undefined); }
}
