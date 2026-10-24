// Chat client for the monitor's AI analysis. Called straight from the friend's browser, so incident data goes
// browser → model provider and never through our Supabase backend (which only sees ciphertext / coarse status).
// Claude (official SDK) is used when EXPO_PUBLIC_ANTHROPIC_API_KEY is set; OpenRouter's free models are the
// fallback when Claude fails or declines, and the only provider when no Claude key is set.
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL, OPENROUTER_API_KEY, OPENROUTER_MODEL } from './env';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
/** Small free models tried in order when the primary is down or rate-limited (OpenRouter `models` fallback list). */
const FREE_FALLBACKS = ['liquid/lfm-2.5-2.6b:free', 'google/gemma-4-26b-a4b-it:free'];
/** Low-effort reasoning answers in 20-40 s on the default OpenRouter model. */
const TIMEOUT_MS = 90_000;

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type ChatOpts = {
  json?: boolean;
  /** JSON schema for the answer: enforced by Claude (structured outputs); OpenRouter gets plain JSON mode */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
};

export class LlmError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}

export const claudeConfigured = () => ANTHROPIC_API_KEY.length > 0;
export const openRouterConfigured = () => OPENROUTER_API_KEY.length > 0;
export const llmConfigured = () => claudeConfigured() || openRouterConfigured();

let claudeClient: Anthropic | null = null;
function claude(): Anthropic {
  // The key is in the web bundle by design (see lib/env.ts); the SDK refuses browser use unless told otherwise.
  claudeClient ??= new Anthropic({ apiKey: ANTHROPIC_API_KEY, dangerouslyAllowBrowser: true, timeout: TIMEOUT_MS, maxRetries: 1 });
  return claudeClient;
}

async function chatClaude(messages: ChatMessage[], opts: ChatOpts): Promise<{ text: string; model: string }> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  try {
    const res = await claude().messages.create(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: opts.maxTokens ?? 16000,
        // The system prompt is identical on every read: cache it (reads re-run within minutes while incidents change).
        system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
        messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        output_config: { effort: 'medium', ...(opts.schema ? { format: { type: 'json_schema' as const, schema: opts.schema } } : {}) },
      },
      { signal: opts.signal },
    );
    if (res.stop_reason === 'refusal') throw new LlmError('Claude declined this request.', 422);
    // Thinking blocks come first; the answer is the text.
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
    if (!text) throw new LlmError(res.stop_reason === 'max_tokens' ? 'Claude ran out of tokens before answering.' : 'Claude returned an empty answer.', 502);
    return { text, model: res.model };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (e instanceof Anthropic.APIUserAbortError) throw new LlmError('Request cancelled.', 499);
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw new LlmError('Claude timed out.', 408);
    if (e instanceof Anthropic.APIConnectionError) throw new LlmError(`Claude unreachable: ${e.message}`, 0);
    if (e instanceof Anthropic.APIError) {
      const retry = Number(e.headers?.get('retry-after'));
      throw new LlmError(`Claude: ${e.message}`, e.status ?? 0, Number.isFinite(retry) && retry > 0 ? retry * 1000 : null);
    }
    throw new LlmError(e instanceof Error ? e.message : String(e), 0);
  }
}

async function chatOpenRouter(messages: ChatMessage[], opts: ChatOpts): Promise<{ text: string; model: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  opts.signal?.addEventListener('abort', () => ctl.abort());
  const models = [OPENROUTER_MODEL, ...FREE_FALLBACKS.filter((m) => m !== OPENROUTER_MODEL)];
  const referer = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://safe.app';
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': referer, 'X-Title': 'Safe monitor' },
      body: JSON.stringify({
        model: models[0],
        models,
        messages,
        temperature: 0.2,
        // Reasoning tokens count toward max_tokens: a tight cap ends the turn before any answer is written.
        max_tokens: opts.maxTokens ?? 8000,
        ...(opts.json || opts.schema ? { response_format: { type: 'json_object' } } : {}),
        // Low effort keeps small models accurate without minutes of thinking; reasoning-off made them invent incidents.
        reasoning: { effort: 'low', exclude: true },
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { choices?: { finish_reason?: string; message?: { content?: string | null } }[]; model?: string; error?: { message?: string; code?: number } }
      | null;
    if (!res.ok || body?.error) {
      const status = body?.error?.code ?? res.status;
      const retry = Number(res.headers.get('retry-after'));
      throw new LlmError(body?.error?.message ?? `OpenRouter HTTP ${res.status}`, status, Number.isFinite(retry) && retry > 0 ? retry * 1000 : null);
    }
    const choice = body?.choices?.[0];
    const text = choice?.message?.content?.trim() ?? '';
    if (!text) throw new LlmError(choice?.finish_reason === 'length' ? 'The model ran out of tokens before answering.' : 'The model returned an empty answer.', 502);
    return { text, model: body?.model ?? models[0] };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (ctl.signal.aborted) throw new LlmError('OpenRouter timed out.', 408);
    throw new LlmError(e instanceof Error ? e.message : String(e), 0);
  } finally {
    clearTimeout(timer);
  }
}

/** One chat completion. Returns the message text and the model that actually answered. */
export async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<{ text: string; model: string }> {
  if (!llmConfigured()) {
    throw new LlmError('No AI key: set EXPO_PUBLIC_ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) in apps/mobile/.env and restart Metro.', 0);
  }
  if (!claudeConfigured()) return chatOpenRouter(messages, opts);
  try {
    return await chatClaude(messages, opts);
  } catch (e) {
    const err = e as LlmError;
    if (err.status === 499 || !openRouterConfigured()) throw err;
    try {
      return await chatOpenRouter(messages, opts);
    } catch (e2) {
      const err2 = e2 instanceof LlmError ? e2 : new LlmError(String(e2), 0);
      // Report Claude's failure (the primary); keep the fallback's reason in the text.
      throw new LlmError(`${err.message} (OpenRouter fallback: ${err2.message})`, err.status, err.retryAfterMs);
    }
  }
}

/** Pulls the first JSON object out of a model answer (tolerates ```json fences and chatter around it). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
