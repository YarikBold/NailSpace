import { createClient } from 'npm:@supabase/supabase-js@2';

// Все значения — из секретов (supabase secrets set ...)
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!; // внедряется автоматически
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; // внедряется автоматически
const MASTER_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}

async function tg(method: string, payload: unknown) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!res) {
    console.error(`Telegram API unavailable [${method}]`);
    return null;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) {
    const err = body?.description || 'unknown error';
    console.error(`Telegram API error [${method}]:`, res.status, err);
  }
  return body;
}

async function validateInitData(initData: unknown) {
  if (typeof initData !== 'string' || !initData) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date') || 0);
  const userJson = params.get('user');
  if (!receivedHash || !userJson || !authDate || !Number.isFinite(authDate) || Date.now() / 1000 - authDate > 86400 || authDate > Date.now() / 1000 + 60) return null;
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(BOT_TOKEN));
  const checkKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', checkKey, encoder.encode(dataCheckString)));
  const expectedHash = [...signature].map(b => b.toString(16).padStart(2, '0')).join('');
  if (!sameSecret(expectedHash, receivedHash)) return null;
  const user = JSON.parse(userJson);
  return Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
}

async function validateMasterInitData(initData: unknown) {
  const user = await validateInitData(initData);
  return user && String(user.id) === MASTER_CHAT_ID ? MASTER_CHAT_ID : null;
}

function sameSecret(expected: string | undefined, actual: string | null) {
  if (!expected || !actual || actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}

export { BOT_TOKEN, MASTER_CHAT_ID, SUPABASE_URL, TG, corsHeaders, json, sameSecret, supabase, tg, validateInitData, validateMasterInitData };
