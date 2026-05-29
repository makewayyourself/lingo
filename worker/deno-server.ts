/* =========================================================
   Lingo Backend — Deno Deploy 버전
   (Cloudflare Worker egress 가 Anthropic 게이트웨이에 403
    "Request not allowed" 로 차단되어 Deno Deploy 로 이전)

   worker.js 와 로직 동일. 차이점:
     - 실행: export default fetch → Deno.serve
     - 시크릿: env.ANTHROPIC_API_KEY → Deno.env.get('ANTHROPIC_API_KEY')
     - 저장소: Cloudflare KV → Deno KV (Deno.openKv)

   배포 (Deno Deploy 대시보드):
     1) https://dash.deno.com → New Project
     2) 이 파일을 엔트리포인트로 (GitHub 연결 또는 Playground 붙여넣기)
     3) Settings → Environment Variables 에
          ANTHROPIC_API_KEY = sk-ant-...  (새로 발급한 키)
     4) KV: Deno Deploy 는 Deno.openKv() 자동 제공 (별도 설정 불필요)

   ⚠️ Cloudflare KV 의 기존 회원/세션은 Deno KV 로 자동 이전되지 않음.
      회원들은 앱에서 다시 회원가입(이름+PIN) 필요. (소그룹이라 부담 적음)
   ========================================================= */

const MAX_MEMBERS = 5;
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_SEC = SESSION_TTL_DAYS * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SEC * 1000;

const kv = await Deno.openKv();

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Member-Token',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Allow-Credentials': 'false'
});

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

function errorResponse(message, status, origin) {
  return jsonResponse({ ok: false, error: message }, status || 400, origin);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const a = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

function newMemberId() {
  return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/* ---------- KV helpers (Deno KV) ---------- */
async function getConfig() {
  const r = await kv.get(['app', 'config']);
  return r.value ?? { members: [], signupCode: null };
}
async function setConfig(cfg) {
  await kv.set(['app', 'config'], cfg);
}
async function getMember(id) {
  const r = await kv.get(['member', id]);
  return r.value ?? null;
}
async function setMember(m) {
  await kv.set(['member', m.id], m);
}
async function listMembers() {
  const cfg = await getConfig();
  const ids = cfg.members || [];
  const out = await Promise.all(ids.map(id => getMember(id)));
  return out.filter(Boolean);
}

async function makeSession(member) {
  const token = randomToken();
  const sess = {
    memberId: member.id,
    name: member.name,
    role: member.role,
    isAdmin: member.role === 'admin',
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  await kv.set(['session', token], sess, { expireIn: SESSION_TTL_MS });
  return token;
}

async function authMember(request) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await kv.get(['session', token]);
  const s = r.value;
  if (!s) return null;
  try {
    if (s.expiresAt < Date.now()) return null;
    return { ...s, token };
  } catch (e) { return null; }
}
async function authAdmin(request) {
  const s = await authMember(request);
  return s && s.isAdmin ? s : null;
}

/* ---------- Handlers ---------- */
async function handleHealth() {
  const cfg = await getConfig();
  return {
    ok: true,
    members: (cfg.members || []).length,
    max: MAX_MEMBERS,
    apiKeyConfigured: !!Deno.env.get('ANTHROPIC_API_KEY'),
    version: '2.0-deno'
  };
}

async function handleSignup(request) {
  const body = await request.json();
  const name = (body.name || '').trim();
  const pin = (body.pin || '').trim();
  const code = (body.signupCode || '').trim();
  if (!name || name.length > 20) throw new Error('이름은 1~20자로 입력해주세요');
  if (!/^\d{6}$/.test(pin)) throw new Error('PIN은 6자리 숫자여야 해요');

  const cfg = await getConfig();
  if ((cfg.members || []).length >= MAX_MEMBERS) throw new Error('정원이 마감됐어요 (최대 ' + MAX_MEMBERS + '명)');
  if (cfg.signupCode && cfg.signupCode !== code) throw new Error('초대 코드가 일치하지 않습니다');

  const all = await listMembers();
  if (all.some(m => m.name === name)) throw new Error('같은 이름이 이미 있어요');

  const isFirst = (cfg.members || []).length === 0;
  const member = {
    id: newMemberId(),
    name,
    pinHash: await sha256(pin),
    role: isFirst ? 'admin' : 'member',
    createdAt: Date.now(),
    lastActive: Date.now(),
    stats: { xp: 0, streak: 0, totalLessons: 0, words: 0, level: null },
    usage: { calls: 0, lastCall: 0 }
  };
  await setMember(member);
  cfg.members = [...(cfg.members || []), member.id];
  await setConfig(cfg);

  const token = await makeSession(member);
  return { ok: true, token, member: { id: member.id, name: member.name, role: member.role } };
}

async function handleLogin(request) {
  const { name, pin } = await request.json();
  if (!name || !/^\d{6}$/.test(pin || '')) throw new Error('이름과 6자리 PIN을 입력해주세요');
  const all = await listMembers();
  const m = all.find(x => x.name === name.trim());
  if (!m) throw new Error('회원을 찾을 수 없어요');
  const h = await sha256(pin);
  if (h !== m.pinHash) throw new Error('PIN이 일치하지 않아요');
  m.lastActive = Date.now();
  await setMember(m);
  const token = await makeSession(m);
  return { ok: true, token, member: { id: m.id, name: m.name, role: m.role } };
}

async function handleLogout(request) {
  const s = await authMember(request);
  if (s) await kv.delete(['session', s.token]);
  return { ok: true };
}

async function handleMe(request) {
  const s = await authMember(request);
  if (!s) throw new Error('로그인이 필요해요');
  const m = await getMember(s.memberId);
  if (!m) throw new Error('회원 정보가 없어요');
  return {
    ok: true,
    member: {
      id: m.id, name: m.name, role: m.role,
      createdAt: m.createdAt, lastActive: m.lastActive,
      stats: m.stats || {}, usage: m.usage || { calls: 0 }
    }
  };
}

async function handleStatsSync(request) {
  const s = await authMember(request);
  if (!s) throw new Error('로그인이 필요해요');
  const stats = await request.json();
  const m = await getMember(s.memberId);
  if (!m) throw new Error('회원 정보가 없어요');
  m.stats = {
    xp: Number(stats.xp || 0),
    streak: Number(stats.streak || 0),
    totalLessons: Number(stats.totalLessons || 0),
    words: Number(stats.words || 0),
    level: String(stats.level || '').slice(0, 10) || null,
    gems: Number(stats.gems || 0),
    grammarMastered: Number(stats.grammarMastered || 0)
  };
  m.lastActive = Date.now();
  await setMember(m);
  return { ok: true };
}

async function handleAiProxy(request) {
  const s = await authMember(request);
  if (!s) throw new Error('로그인이 필요해요');
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('관리자가 API 키를 아직 설정하지 않았어요. Deno Deploy > Settings > Environment Variables 에 ANTHROPIC_API_KEY를 등록해주세요');

  const bodyText = await request.text();

  // 사용량 카운트
  const m = await getMember(s.memberId);
  if (m) {
    m.usage = m.usage || { calls: 0, lastCall: 0 };
    m.usage.calls += 1;
    m.usage.lastCall = Date.now();
    m.lastActive = Date.now();
    await setMember(m);
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: bodyText
  });
  const respText = await upstream.text();
  if (!upstream.ok) {
    let parsed = null;
    try { parsed = JSON.parse(respText); } catch (e) {}
    const requestId = upstream.headers.get('request-id') || upstream.headers.get('x-request-id') || null;
    const errorType = parsed?.error?.type || parsed?.type || null;
    const errorCode = parsed?.error?.code || parsed?.code || null;
    const message = parsed?.error?.message || parsed?.message || respText || ('Anthropic API HTTP ' + upstream.status);
    const detail = [errorType, errorCode, requestId].filter(Boolean).join(' | ');
    return jsonResponse({
      ok: false,
      error: detail ? (message + ' [' + detail + ']') : message,
      upstreamStatus: upstream.status,
      upstreamError: parsed?.error || parsed || null,
      requestId
    }, upstream.status, request.headers.get('Origin'));
  }
  return new Response(respText, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request.headers.get('Origin'))
    }
  });
}

async function handleAdminMembers(request) {
  const s = await authAdmin(request);
  if (!s) throw new Error('관리자 권한이 필요해요');
  const all = await listMembers();
  return {
    ok: true,
    members: all.map(m => ({
      id: m.id, name: m.name, role: m.role,
      createdAt: m.createdAt, lastActive: m.lastActive,
      stats: m.stats || {}, usage: m.usage || { calls: 0 }
    }))
  };
}

async function handleAdminDelete(request) {
  const s = await authAdmin(request);
  if (!s) throw new Error('관리자 권한이 필요해요');
  const { id } = await request.json();
  const m = await getMember(id);
  if (!m) throw new Error('회원을 찾을 수 없어요');
  if (m.role === 'admin') throw new Error('관리자는 삭제할 수 없어요');
  await kv.delete(['member', id]);
  const cfg = await getConfig();
  cfg.members = (cfg.members || []).filter(x => x !== id);
  await setConfig(cfg);
  return { ok: true };
}

async function handleAdminResetPin(request) {
  const s = await authAdmin(request);
  if (!s) throw new Error('관리자 권한이 필요해요');
  const { id, newPin } = await request.json();
  if (!/^\d{6}$/.test(newPin || '')) throw new Error('6자리 PIN 필요');
  const m = await getMember(id);
  if (!m) throw new Error('회원을 찾을 수 없어요');
  m.pinHash = await sha256(newPin);
  await setMember(m);
  return { ok: true };
}

async function handleAdminSetSignupCode(request) {
  const s = await authAdmin(request);
  if (!s) throw new Error('관리자 권한이 필요해요');
  const { code } = await request.json();
  const cfg = await getConfig();
  cfg.signupCode = code ? String(code).trim() : null;
  await setConfig(cfg);
  return { ok: true, signupCode: cfg.signupCode };
}

/* ---------- Router ---------- */
const routes = [
  ['GET',  '/health',              handleHealth],
  ['POST', '/signup',              handleSignup],
  ['POST', '/login',               handleLogin],
  ['POST', '/logout',              handleLogout],
  ['GET',  '/me',                  handleMe],
  ['POST', '/me/stats',            handleStatsSync],
  ['POST', '/ai/messages',         handleAiProxy],
  ['GET',  '/admin/members',       handleAdminMembers],
  ['POST', '/admin/delete',        handleAdminDelete],
  ['POST', '/admin/reset-pin',     handleAdminResetPin],
  ['POST', '/admin/signup-code',   handleAdminSetSignupCode]
];

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

  const route = routes.find(r => r[0] === request.method && r[1] === url.pathname);
  if (!route) return errorResponse('Not found', 404, origin);

  try {
    const handler = route[2];
    const result = await handler(request);
    if (result instanceof Response) return result;
    return jsonResponse(result, 200, origin);
  } catch (e) {
    return errorResponse(e.message || String(e), 400, origin);
  }
});
