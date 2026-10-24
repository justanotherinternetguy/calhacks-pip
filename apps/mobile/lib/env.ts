export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
// Placeholder key keeps createClient() from throwing when no backend is configured (demo/mock mode).
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? 'demo-anon-key';
export const DEMO_MODE = !process.env.EXPO_PUBLIC_SUPABASE_URL;
