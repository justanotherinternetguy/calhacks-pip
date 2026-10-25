// Words for where a friend is from you: "300 m north-east", "1.2 km south".
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const dirWord = (b: number) => COMPASS[Math.round((((b % 360) + 360) % 360) / 45) % 8];
export const fmtDist = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`);
export const whereIs = (p: { distM: number | null; bearing: number | null }) => (p.distM != null && p.bearing != null ? `${fmtDist(p.distM)} ${dirWord(p.bearing)}` : null);
