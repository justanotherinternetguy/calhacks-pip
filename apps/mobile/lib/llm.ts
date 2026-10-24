// Minimal OpenRouter chat client (OpenAI-compatible). Called straight from the friend's browser, so incident
// data goes browser → OpenRouter and never through our Supabase backend (which only sees ciphertext / coarse status).
import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from './env';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
/** Small free models tried in order when the primary is down or rate-limited (OpenRouter `models` fallback list). */
const FREE_FALLBACKS = ['liquid/lfm-2.5-2.6b:free', 'google/gemma-4-26b-a4b-it:free'];
/** Low-effort reasoning answers in 20-40 s on the default model. */
const TIMEOUT_MS = 90_000;

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export class LlmError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}

export const llmConfigured = () => OPENROUTER_API_KEY.length > 0;

/** One chat completion. Returns the message text and the model that actually answered. */
export async function chat(messages: ChatMessage[], opts: { json?: boolean; maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}): Promise<{ text: string; model: string }> {
  if (!llmConfigured()) throw new LlmError('No OpenRouter key: set OPENROUTER_API_KEY in apps/mobile/.env and restart Metro.', 0);
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
        temperature: opts.temperature ?? 0.2,
        // Reasoning tokens count toward max_tokens: a tight cap ends the turn before any answer is written.
        max_tokens: opts.maxTokens ?? 8000,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
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
