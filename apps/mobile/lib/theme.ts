export const colors = {
  bg: '#0b0d12', card: '#151924', border: '#232a3a', text: '#f3f4f6', muted: '#8b93a7',
  accent: '#7c9cff', danger: '#ff3b5c', ok: '#34d399', warn: '#fbbf24',
};
export const radius = 16;
export const levelColor = (level: string) =>
  ({ idle: colors.ok, resolved: colors.ok, check: colors.warn, heads_up: colors.warn, unlocked: colors.danger, snatch: colors.danger, sos: colors.danger, offline: colors.warn, battery_dying: colors.warn }[level] ?? colors.muted);
