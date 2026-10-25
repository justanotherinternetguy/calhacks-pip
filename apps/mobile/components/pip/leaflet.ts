// Leaflet from unpkg (web only; react-native-maps has no web target). Typed with just the API the maps use.
const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/';
/** Esri's light grey canvas (no key needed), tinted toward cream with a CSS filter; street names come as a second layer. */
export const LIGHT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
export const LIGHT_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
export const LIGHT_TILES_ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';
export const TILE_OPTS = { maxZoom: 19, maxNativeZoom: 16 };

export type LLatLng = [number, number];
export type LLayer = { addTo(target: LMap | LLayerGroup): LLayer; bindTooltip(text: string, opts?: Record<string, unknown>): LLayer; remove(): void };
export type LLayerGroup = LLayer & { clearLayers(): void };
export type LMarker = LLayer & {
  setLatLng(p: LLatLng): LMarker;
  setIcon(icon: unknown): LMarker;
  setZIndexOffset(n: number): LMarker;
  on(ev: 'click' | 'keypress', cb: (e: { originalEvent?: KeyboardEvent }) => void): LMarker;
};
export type LCircle = LLayer & { setLatLng(p: LLatLng): LCircle; setRadius(m: number): LCircle };
export type LMap = {
  on(ev: 'click', cb: (e: { latlng: { lat: number; lng: number } }) => void): void;
  setView(center: LLatLng, zoom: number, opts?: { animate?: boolean }): void;
  flyTo(center: LLatLng, zoom?: number, opts?: { duration?: number }): void;
  fitBounds(bounds: unknown, opts?: { padding?: [number, number]; paddingTopLeft?: [number, number]; paddingBottomRight?: [number, number]; maxZoom?: number; animate?: boolean }): void;
  flyToBounds(bounds: unknown, opts?: { padding?: [number, number]; paddingTopLeft?: [number, number]; paddingBottomRight?: [number, number]; maxZoom?: number; duration?: number }): void;
  getZoom(): number;
  invalidateSize(): void;
  remove(): void;
};
export type Leaflet = {
  map(el: HTMLElement, opts?: Record<string, unknown>): LMap;
  tileLayer(url: string, opts?: Record<string, unknown>): LLayer;
  layerGroup(): LLayerGroup;
  polyline(pts: LLatLng[], opts?: Record<string, unknown>): LLayer;
  circleMarker(p: LLatLng, opts?: Record<string, unknown>): LLayer;
  circle(p: LLatLng, opts?: Record<string, unknown>): LCircle;
  marker(p: LLatLng, opts?: Record<string, unknown>): LMarker;
  divIcon(opts: Record<string, unknown>): unknown;
  latLngBounds(pts: LLatLng[]): unknown;
};

/** Page CSS for the maps: the cream tint on the tiles and the pins drawn as HTML. */
const MAP_CSS = `
.leaflet-container{background:#F6ECD6;font-family:Figtree,system-ui,sans-serif}
.leaflet-container .leaflet-tile-pane{filter:sepia(.5) saturate(.9) brightness(1.04)}
.leaflet-control-attribution{background:rgba(251,243,228,.85)!important;color:#5A5470!important;font:11px Figtree,system-ui,sans-serif}
.leaflet-control-attribution a{color:#3A3552!important}
.leaflet-bar{border:2px solid #1E1B2E!important;border-radius:14px!important;box-shadow:0 3px 0 #1E1B2E!important;overflow:hidden}
.leaflet-bar a{background:#FFFCF5!important;color:#1E1B2E!important;border-bottom:1.5px solid #E6D8BD!important;font:600 18px/26px Fredoka,system-ui,sans-serif!important}
.leaflet-bar a:last-child{border-bottom:0!important}
.pip-pin{position:relative;display:flex;flex-direction:column;align-items:center;padding-top:24px;cursor:pointer;transition:transform 160ms cubic-bezier(.34,1.56,.64,1)}
.pip-pin:hover{transform:translateY(-2px)}
.pip-pin__disc{position:relative;box-sizing:border-box;border-radius:50%;background:var(--fill);border:2.5px solid #1E1B2E}
.pip-pin--dim{opacity:.5}
.pip-pin__name{display:flex;align-items:center;height:24px;font:600 13px/16px Fredoka,system-ui,sans-serif;color:#3A3552;white-space:nowrap;text-shadow:0 0 3px #FBF3E4,0 0 3px #FBF3E4}
.pip-pin__chip{padding:3px 10px;border-radius:999px;background:#1E1B2E;color:#FBF3E4;font-weight:500;text-shadow:none}
.pip-pin--pulse .pip-pin__disc::after,.pip-pin--me .pip-pin__disc::after{content:"";position:absolute;inset:-3px;border-radius:50%;background:#FF6B5C;opacity:.5;animation:pip-pulse 2.4s ease-out infinite;z-index:-1}
.pip-pin--me .pip-pin__disc::after{background:#4AA8FF;animation-duration:2.2s}
@keyframes pip-pulse{0%{transform:scale(1);opacity:.45}100%{transform:scale(3.4);opacity:0}}
.pip-tip{background:#1E1B2E!important;color:#FBF3E4!important;border:0!important;border-radius:999px!important;padding:3px 10px!important;font:500 12.5px Fredoka,system-ui,sans-serif!important;box-shadow:none!important}
.pip-tip::before{display:none!important}
`;

let leafletPromise: Promise<Leaflet> | null = null;
export function loadLeaflet(): Promise<Leaflet> {
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise<Leaflet>((resolve, reject) => {
    const g = globalThis as unknown as { L?: Leaflet };
    if (g.L) return resolve(g.L);
    if (!document.querySelector(`link[href="${LEAFLET}leaflet.css"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${LEAFLET}leaflet.css`;
      document.head.appendChild(link);
      const style = document.createElement('style');
      style.textContent = MAP_CSS;
      document.head.appendChild(style);
    }
    const s = document.createElement('script');
    s.src = `${LEAFLET}leaflet.js`;
    s.async = true;
    s.onload = () => (g.L ? resolve(g.L) : reject(new Error('Leaflet loaded but window.L is missing')));
    s.onerror = () => reject(new Error('could not load Leaflet from unpkg'));
    document.head.appendChild(s);
  }).catch((e) => { leafletPromise = null; throw e; });
  return leafletPromise;
}
