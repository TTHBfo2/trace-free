// Cloudflare Worker — Trace license validation + Lemon Squeezy webhook
//
// Secrets (set via: wrangler secret put <NAME>)
//   PRIVATE_KEY_B64           — Ed25519 private key DER PKCS8, base64-encoded
//   ADMIN_SECRET              — random string for admin endpoints
//   LEMON_SQUEEZY_WEBHOOK_SECRET — from Lemon Squeezy dashboard → Settings → Webhooks
//   RESEND_API_KEY            — from resend.com dashboard
//
// KV binding: LICENSES

const PUBLIC_KEY_B64  = 'MCowBQYDK2VwAyEA+WiFm3fBMP/eHXnHqNN2aEXTlMbJLq51We0DcAN2nL8=';
const MAX_ACTIVATIONS = 3;
const TOKEN_TTL_DAYS  = 30;
const FROM_EMAIL      = 'Trace by Trimwares <noreply@trimwares.com>';
const SUPPORT_EMAIL   = 'hello@trimwares.com';
const MAX_BODY_BYTES  = 64 * 1024;
const UUID_RE         = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function env$(val) { return (val ?? '').trim(); }

// ─── Entry point ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const cors = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST')    return json({ error: 'Method not allowed' }, 405, cors);
    const contentLen = parseInt(request.headers.get('Content-Length') ?? '0');
    if (contentLen > MAX_BODY_BYTES)  return json({ error: 'Request too large' }, 413, cors);

    const path = new URL(request.url).pathname;

    try {
      if (path === '/activate')        return activate(request, env, cors);
      if (path === '/refresh')         return refresh(request, env, cors);
      if (path === '/deactivate')      return deactivate(request, env, cors);
      if (path === '/webhook')         return webhook(request, env, cors);
      if (path === '/admin/seed-key')  return seedKey(request, env, cors);
      if (path === '/admin/revoke')    return revoke(request, env, cors);
      return json({ error: 'Not found' }, 404, cors);
    } catch {
      return json({ error: 'Internal error' }, 500, cors);
    }
  },
};

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signToken(payload, privateKeyB64) {
  const payloadStr   = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadStr);
  const payloadB64   = bytesToB64url(payloadBytes);

  const privKey = await crypto.subtle.importKey(
    'pkcs8', b64ToBytes(privateKeyB64.trim()),
    { name: 'Ed25519' }, false, ['sign'],
  );

  const sigBytes = await crypto.subtle.sign('Ed25519', privKey, payloadBytes);
  return `${payloadB64}.${bytesToB64url(sigBytes)}`;
}

async function verifyToken(tokenStr) {
  const parts = tokenStr.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const payloadBytes = b64ToBytes(payloadB64);
    const pubKey = await crypto.subtle.importKey(
      'spki', b64ToBytes(PUBLIC_KEY_B64),
      { name: 'Ed25519' }, false, ['verify'],
    );
    const valid = await crypto.subtle.verify('Ed25519', pubKey, b64ToBytes(sigB64), payloadBytes);
    if (!valid) return null;
    return JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch { return null; }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyLemonSignature(rawBody, signatureHex, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig     = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = bytesToHex(sig);
  return timingSafeEqual(computed, signatureHex);
}

function tokenExpiry() {
  return Math.floor(Date.now() / 1000) + TOKEN_TTL_DAYS * 86400;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// ─── /webhook  (Lemon Squeezy order_created) ──────────────────────────────────

async function webhook(request, env) {
  const rawBody  = await request.text();
  const sigHex   = request.headers.get('X-Signature') ?? '';

  // Verify Lemon Squeezy signature
  const webhookSecret = env$(env.LEMON_SQUEEZY_WEBHOOK_SECRET);
  if (!webhookSecret) return json({ error: 'Webhook secret not configured' }, 500);
  const valid = await verifyLemonSignature(rawBody, sigHex, webhookSecret);
  if (!valid) return json({ error: 'Invalid webhook signature' }, 401);

  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // Only process completed orders
  if (event.meta?.event_name !== 'order_created') return json({ ok: true, skipped: true });
  if (event.data?.attributes?.status !== 'paid')  return json({ ok: true, skipped: true });

  const attrs     = event.data.attributes;
  const orderId   = String(event.data.id);
  const email     = attrs.user_email;
  const name      = attrs.user_name ?? email.split('@')[0];
  const variant     = (attrs.first_order_item?.variant_name ?? '').toLowerCase();
  const isAnnual    = variant.includes('annual') || variant.includes('year');
  const isPerpetual = variant.includes('perpetual') || variant.includes('lifetime');
  const days        = isPerpetual ? null : isAnnual ? 366 : 35;

  if (!email) return json({ error: 'No email in payload' }, 400);

  // Idempotency — skip if already processed
  const idempKey  = `order:${orderId}`;
  const existing  = await env.LICENSES.get(idempKey);
  if (existing)   return json({ ok: true, skipped: true, reason: 'already processed' });

  // Generate license key (perpetual has no exp claim)
  const now        = Math.floor(Date.now() / 1000);
  const exp        = days ? now + days * 86400 : null;
  const licenseKey = await signToken(
    { tier: 'pro', email, customerId: `ls_${orderId}`, iat: now, ...(exp ? { exp } : {}) },
    env$(env.PRIVATE_KEY_B64),
  );

  // Seed into KV (perpetual: expires = null so it never expires)
  const keyId = licenseKey.split('.')[0];
  await env.LICENSES.put(`license:${keyId}`, JSON.stringify({
    tier:        'pro',
    email,
    customerId:  `ls_${orderId}`,
    expires:     exp,
    activations: [],
    revoked:     false,
    createdAt:   now,
  }));

  // Mark order as processed (idempotency)
  await env.LICENSES.put(idempKey, JSON.stringify({ keyId, email, processedAt: now }));

  // Send welcome email via Resend
  const emailResult = await sendWelcomeEmail({ env, to: email, name, licenseKey, isAnnual, isPerpetual });

  return json({ ok: true, orderId, email, emailSent: emailResult.ok });
}

// ─── Email via Resend ─────────────────────────────────────────────────────────

async function sendWelcomeEmail({ env, to, name, licenseKey, isAnnual, isPerpetual }) {
  const resendKey = (env.RESEND_API_KEY ?? '').trim();
  if (!resendKey) return { ok: false, reason: 'RESEND_API_KEY not set' };

  const planLabel = isPerpetual ? 'Perpetual' : isAnnual ? 'Annual' : 'Monthly';
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Trace Pro License</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e5e5">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:40px auto">
    <tr><td style="padding:0 24px">

      <!-- Header -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px">
        <tr>
          <td style="padding:24px 0;border-bottom:1px solid #1f1f1f">
            <span style="font-size:14px;font-weight:600;color:#fff;letter-spacing:-0.3px">⚡ Trace</span>
            <span style="font-size:11px;color:#555;margin-left:6px">by Trimwares</span>
          </td>
        </tr>
      </table>

      <!-- Body -->
      <p style="font-size:15px;color:#888;margin:0 0 8px">Hi ${name},</p>
      <h1 style="font-size:24px;font-weight:600;color:#fff;margin:0 0 8px;letter-spacing:-0.5px">
        Your Trace Pro license is ready
      </h1>
      <p style="font-size:14px;color:#666;margin:0 0 32px">${planLabel} plan — activate in under 2 minutes.</p>

      <!-- Key -->
      <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#555;margin:0 0 8px">License key</p>
      <div style="background:#111;border:1px solid #1f1f1f;border-radius:8px;padding:16px;margin-bottom:32px">
        <code style="font-size:11px;color:#4ade80;font-family:'SF Mono',Monaco,Consolas,monospace;word-break:break-all;line-height:1.6">${licenseKey}</code>
      </div>

      <!-- Steps -->
      <p style="font-size:13px;font-weight:600;color:#fff;margin:0 0 16px;text-transform:uppercase;letter-spacing:0.06em">Get started</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px">
        ${[
          ['1', 'Install the SDK in your project', 'npm install @trimwares/trace'],
          ['2', 'Activate your license', `npx trimwares login --key ${licenseKey}`],
          ['3', 'Wrap your LLM client (one line)', 'const openai = trimwares.openai(new OpenAI())'],
          ['4', 'Open the dashboard', 'npx trimwares serve'],
        ].map(([num, label, code]) => `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #141414;vertical-align:top">
            <span style="display:inline-block;width:20px;height:20px;background:#1f1f1f;border-radius:50%;font-size:10px;font-weight:600;color:#888;text-align:center;line-height:20px;margin-right:12px;flex-shrink:0">${num}</span>
            <span style="font-size:13px;color:#888">${label}</span><br>
            <code style="font-size:11px;color:#4ade80;font-family:monospace;margin-left:32px">${code}</code>
          </td>
        </tr>`).join('')}
      </table>

      <!-- Footer -->
      <p style="font-size:12px;color:#444;margin:0;line-height:1.8">
        Questions? Reply to this email or contact
        <a href="mailto:${SUPPORT_EMAIL}" style="color:#4ade80;text-decoration:none">${SUPPORT_EMAIL}</a><br>
        <a href="https://trimwares.com" style="color:#555;text-decoration:none">trimwares.com</a>
      </p>

    </td></tr>
  </table>
</body></html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    FROM_EMAIL,
        to:      [to],
        subject: `Your Trace Pro License Key (${planLabel})`,
        html,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── /activate ────────────────────────────────────────────────────────────────

async function activate(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { key, machineId } = body;
  if (!key || !machineId) return json({ error: 'key and machineId are required' }, 400, cors);
  if (!UUID_RE.test(machineId)) return json({ error: 'Invalid machineId' }, 400, cors);

  const keyPayload = await verifyToken(key);
  if (!keyPayload) return json({ error: 'Invalid license key' }, 401, cors);

  const keyId  = key.split('.')[0];
  const record = await env.LICENSES.get(`license:${keyId}`, 'json');

  if (!record)        return json({ error: 'License key not found' }, 404, cors);
  if (record.revoked) return json({ error: 'License key has been revoked' }, 403, cors);

  const now = Math.floor(Date.now() / 1000);
  if (record.expires && record.expires < now) return json({ error: 'License key has expired' }, 403, cors);

  const activations = record.activations ?? [];
  if (!activations.includes(machineId)) {
    if (activations.length >= MAX_ACTIVATIONS) {
      return json({
        error: `This license is active on ${MAX_ACTIVATIONS} devices (the maximum for a personal license). Run \`npx trimwares deactivate\` on one of your existing machines to free up a slot, or contact ${SUPPORT_EMAIL}.`,
        code: 'DEVICE_LIMIT_REACHED',
        activeDevices: MAX_ACTIVATIONS,
      }, 403, cors);
    }
    activations.push(machineId);
    await env.LICENSES.put(`license:${keyId}`, JSON.stringify({ ...record, activations }));
  }

  const token = await signToken({
    keyId, machineId,
    tier:         record.tier,
    email:        record.email ?? null,
    keyExpires:   record.expires ?? null,
    tokenExpires: tokenExpiry(),
    iat:          now,
  }, env$(env.PRIVATE_KEY_B64));

  return json({
    token,
    tier:    record.tier,
    email:   record.email ?? null,
    expires: record.expires ? new Date(record.expires * 1000).toISOString().split('T')[0] : 'never',
  }, 200, cors);
}

// ─── /refresh ─────────────────────────────────────────────────────────────────

async function refresh(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { token, machineId } = body;
  if (!token || !machineId) return json({ error: 'token and machineId are required' }, 400, cors);

  const payload = await verifyToken(token);
  if (!payload)                        return json({ error: 'Invalid token signature' }, 401, cors);
  if (payload.machineId !== machineId) return json({ error: 'Machine ID mismatch' }, 403, cors);

  const record = await env.LICENSES.get(`license:${payload.keyId}`, 'json');
  if (!record)        return json({ error: 'License not found' }, 404, cors);
  if (record.revoked) return json({ error: 'License has been revoked' }, 403, cors);

  const now = Math.floor(Date.now() / 1000);
  if (record.expires && record.expires < now) return json({ error: 'License has expired' }, 403, cors);

  const newToken = await signToken({
    keyId:        payload.keyId,
    machineId,
    tier:         record.tier,
    email:        record.email ?? null,
    keyExpires:   record.expires ?? null,
    tokenExpires: tokenExpiry(),
    iat:          now,
  }, env$(env.PRIVATE_KEY_B64));

  return json({ token: newToken, tier: record.tier }, 200, cors);
}

// ─── /deactivate ─────────────────────────────────────────────────────────────

async function deactivate(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { token, machineId } = body;
  if (!token || !machineId) return json({ error: 'token and machineId are required' }, 400, cors);
  if (!UUID_RE.test(machineId)) return json({ error: 'Invalid machineId' }, 400, cors);

  const payload = await verifyToken(token);
  if (!payload)                        return json({ error: 'Invalid token signature' }, 401, cors);
  if (payload.machineId !== machineId) return json({ error: 'Machine ID mismatch' }, 403, cors);

  const record = await env.LICENSES.get(`license:${payload.keyId}`, 'json');
  if (!record) return json({ error: 'License not found' }, 404, cors);

  const activations = (record.activations ?? []).filter(id => id !== machineId);
  await env.LICENSES.put(`license:${payload.keyId}`, JSON.stringify({ ...record, activations }));

  return json({
    ok: true,
    activeDevices: activations.length,
    slotsAvailable: MAX_ACTIVATIONS - activations.length,
  }, 200, cors);
}

// ─── /admin/seed-key ─────────────────────────────────────────────────────────

async function seedKey(request, env, cors) {
  if (!timingSafeEqual(request.headers.get('X-Admin-Secret') ?? '', env$(env.ADMIN_SECRET))) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { key, tier, email, customerId, expires } = body;
  if (!key || !tier) return json({ error: 'key and tier are required' }, 400, cors);

  const keyId = key.split('.')[0];
  const kvKey = `license:${keyId}`;
  if (await env.LICENSES.get(kvKey)) return json({ error: 'Key already registered', keyId }, 409, cors);

  await env.LICENSES.put(kvKey, JSON.stringify({
    tier, email: email ?? null, customerId: customerId ?? null,
    expires: expires ?? null, activations: [], revoked: false,
    createdAt: Math.floor(Date.now() / 1000),
  }));

  return json({ ok: true, keyId }, 200, cors);
}

// ─── /admin/revoke ────────────────────────────────────────────────────────────

async function revoke(request, env, cors) {
  if (!timingSafeEqual(request.headers.get('X-Admin-Secret') ?? '', env$(env.ADMIN_SECRET))) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  const { key } = body;
  if (!key) return json({ error: 'key is required' }, 400, cors);

  const kvKey  = `license:${key.split('.')[0]}`;
  const record = await env.LICENSES.get(kvKey, 'json');
  if (!record) return json({ error: 'Key not found' }, 404, cors);

  await env.LICENSES.put(kvKey, JSON.stringify({ ...record, revoked: true }));
  return json({ ok: true }, 200, cors);
}
