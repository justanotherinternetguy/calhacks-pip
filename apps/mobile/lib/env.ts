export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
// Placeholder key keeps createClient() from throwing when no backend is configured (demo/mock mode).
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? 'demo-anon-key';
export const DEMO_MODE = !process.env.EXPO_PUBLIC_SUPABASE_URL;

// OpenRouter (AI analysis on the friends' monitor), from apps/mobile/.env. app.config.ts aliases a plain
// OPENROUTER_API_KEY / OPENROUTER_MODEL to these. The key ships inside the web bundle: use a free-tier key.
// Default: NVIDIA Nemotron 3.5 Lightning (30B MoE, 3B active), free. Picked over the other free models on our own
// danger / benign incident scenarios: right risk level every run, no invented incident ids, never rate-limited.
const clean = (v: string | undefined) => (v && v !== 'undefined' ? v.trim() : '');
export const OPENROUTER_API_KEY = clean(process.env.EXPO_PUBLIC_OPENROUTER_API_KEY);
export const OPENROUTER_MODEL = clean(process.env.EXPO_PUBLIC_OPENROUTER_MODEL) || 'nvidia/nemotron-3.5-lightning:free';
