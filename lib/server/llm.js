// Server-only: calls to LLM providers with the user's decrypted key. Keys never leave this module
// except in the outbound Authorization header to the provider.
import dns from 'node:dns/promises';
import net from 'node:net';
import { providerById } from '../domain/providers.js';
import { demoResponse } from './demo.js';

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180000);
const MAX_OUTPUT_TOKENS = Number(process.env.LLM_MAX_OUTPUT_TOKENS || 16000);

export class LlmError extends Error {
  constructor(message, status = 502, code = 'llm_error') { super(message); this.status = status; this.code = code; }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') ||
    (l.startsWith('::ffff:') && isPrivateIp(l.slice(7)));
}

/** SSRF guard for user-supplied base URLs (custom provider). */
export async function assertSafeBaseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new LlmError('Custom base URL is not a valid URL.', 400, 'bad_base_url'); }
  const allowPrivate = process.env.ALLOW_PRIVATE_BASE_URLS === 'true';
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) {
    throw new LlmError('Custom base URL must use https://', 400, 'bad_base_url');
  }
  if (u.username || u.password) throw new LlmError('Custom base URL must not contain credentials.', 400, 'bad_base_url');
  if (!allowPrivate) {
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new LlmError('Custom base URL host could not be resolved.', 400, 'bad_base_url');
    if (addrs.some((a) => isPrivateIp(a.address))) throw new LlmError('Custom base URL points to a private network address.', 400, 'bad_base_url');
  }
  return u.toString().replace(/\/+$/, '');
}

async function httpJson(url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal, redirect: 'error' });
  } catch (e) {
    throw new LlmError(e.name === 'AbortError' ? 'The model took too long to respond.' : 'Could not reach the provider.', 504, 'network');
  } finally { clearTimeout(t); }
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const msg = (body && (body.error?.message || body.error?.type || body.message)) || `HTTP ${res.status}`;
    const status = res.status === 401 || res.status === 403 ? 401 : res.status === 429 ? 429 : res.status === 404 ? 400 : 502;
    const code = status === 401 ? 'provider_auth' : status === 429 ? 'provider_rate_limit' : 'provider_error';
    throw new LlmError(`Provider said: ${String(msg).slice(0, 300)}`, status, code);
  }
  if (!body) throw new LlmError('Provider returned a non-JSON response.', 502);
  return body;
}

/**
 * complete({provider, model, apiKey, baseUrl, system, user, json}) → { text, usage:{input,output} }
 */
export async function complete({ provider, model, apiKey, baseUrl, system, user, json = true }) {
  const p = providerById(provider);
  if (!p) throw new LlmError('Unknown provider', 400, 'bad_provider');
  if (p.kind === 'demo') return demoResponse({ system, user });
  const base = (p.customBaseUrl ? baseUrl : p.baseUrl);
  if (!base) throw new LlmError('No base URL configured for this provider.', 400, 'bad_base_url');

  if (p.kind === 'openai') {
    const body = {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_completion_tokens: MAX_OUTPUT_TOKENS,
    };
    if (json && (p.id === 'openai' || p.id === 'xai')) body.response_format = { type: 'json_object' };
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    if (p.id === 'openrouter') { headers['X-Title'] = 'ClipScript Studio'; }
    const r = await httpJson(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = r.choices?.[0]?.message?.content;
    if (!text) throw new LlmError(r.choices?.[0]?.finish_reason === 'length' ? 'The model ran out of output tokens.' : 'The model returned an empty response.', 502);
    return { text, usage: { input: r.usage?.prompt_tokens || 0, output: r.usage?.completion_tokens || 0 } };
  }
  if (p.kind === 'anthropic') {
    const r = await httpJson(`${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, system, messages: [{ role: 'user', content: user }] }),
    });
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (!text) throw new LlmError('The model returned an empty response.', 502);
    return { text, usage: { input: r.usage?.input_tokens || 0, output: r.usage?.output_tokens || 0 } };
  }
  if (p.kind === 'gemini') {
    const r = await httpJson(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, ...(json ? { responseMimeType: 'application/json' } : {}) },
      }),
    });
    const text = (r.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
    if (!text) throw new LlmError('The model returned an empty response (possibly blocked by safety filters).', 502);
    return { text, usage: { input: r.usageMetadata?.promptTokenCount || 0, output: r.usageMetadata?.candidatesTokenCount || 0 } };
  }
  throw new LlmError('Unsupported provider kind', 400);
}

/** List models available to a key (used by "Test key"). */
export async function listModels({ provider, apiKey, baseUrl }) {
  const p = providerById(provider);
  if (!p) throw new LlmError('Unknown provider', 400);
  if (p.kind === 'demo') return p.models;
  const base = p.customBaseUrl ? baseUrl : p.baseUrl;
  if (p.kind === 'openai') {
    const r = await httpJson(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    return (r.data || []).map((m) => m.id).filter(Boolean).sort();
  }
  if (p.kind === 'anthropic') {
    const r = await httpJson(`${base}/models?limit=100`, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    return (r.data || []).map((m) => m.id).filter(Boolean);
  }
  if (p.kind === 'gemini') {
    const r = await httpJson(`${base}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
    return (r.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''));
  }
  return [];
}
