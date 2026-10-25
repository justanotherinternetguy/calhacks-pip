// Save a JSON file from the browser (web only; the collect page is a laptop tool).
import { Platform } from 'react-native';

export function downloadJson(name: string, data: unknown): string {
  if (Platform.OS !== 'web') return 'Downloads work in the web build only.';
  try {
    const doc = (globalThis as { document?: Document }).document;
    if (!doc) return 'No document to download from.';
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = name;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
