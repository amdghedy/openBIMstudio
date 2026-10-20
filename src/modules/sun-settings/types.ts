/** Sun settings & shadows — solar study controls. */
export interface SunSettings {
  enabled: boolean;
  /** DateTime for sun position. */
  date: string;
  /** Time of day (24h, e.g. "14:30"). */
  time: string;
  /** Latitude (degrees, -90 to 90). */
  latitude: number;
  /** Longitude (degrees, -180 to 180). */
  longitude: number;
  /** Timezone offset (hours). */
  timezone: number;
  /** Shadow intensity (0-1). */
  shadowIntensity: number;
  /** North direction (degrees, 0 = +Z). */
  northOffset: number;
}

export const DEFAULT_SUN: SunSettings = {
  enabled: true, date: "2026-06-21", time: "12:00",
  latitude: 30.05, longitude: 31.24, timezone: 2,
  shadowIntensity: 0.6, northOffset: 0,
};

let current: SunSettings = { ...DEFAULT_SUN };

export function getSunSettings(): SunSettings { return { ...current }; }
export function setSunSettings(s: Partial<SunSettings>): SunSettings {
  current = { ...current, ...s };
  applySun();
  return current;
}

/** Compute sun direction (azimuth + elevation) from date/time/lat/long. */
export function computeSunPosition(s: SunSettings = current): { azimuth: number; elevation: number; dir: [number, number, number] } {
  const d = new Date(`${s.date}T${s.time}:00${s.timezone >= 0 ? "+" : "-"}${String(Math.abs(s.timezone)).padStart(2,"0")}:00`);
  const dayOfYear = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000);
  const hours = d.getHours() + d.getMinutes() / 60;
  // Solar declination (degrees)
  const decl = 23.45 * Math.sin(((360 / 365) * (dayOfYear - 81)) * Math.PI / 180);
  // Hour angle (degrees)
  const hourAngle = 15 * (hours - 12);
  const latRad = s.latitude * Math.PI / 180;
  const declRad = decl * Math.PI / 180;
  const haRad = hourAngle * Math.PI / 180;
  // Solar elevation
  const elevation = Math.asin(
    Math.sin(latRad) * Math.sin(declRad) + Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad)
  ) * 180 / Math.PI;
  // Solar azimuth (measured from North, clockwise)
  const azimuth = Math.atan2(
    Math.sin(haRad),
    Math.cos(haRad) * Math.sin(latRad) - Math.tan(declRad) * Math.cos(latRad)
  ) * 180 / Math.PI;
  // Direction vector (x=East, y=Up, z=North)
  const azRad = (azimuth + s.northOffset) * Math.PI / 180;
  const elRad = elevation * Math.PI / 180;
  const dir: [number, number, number] = [
    Math.sin(azRad) * Math.cos(elRad),
    Math.sin(elRad),
    Math.cos(azRad) * Math.cos(elRad),
  ];
  return { azimuth, elevation, dir };
}

function applySun() {
  try {
    const scene = (globalThis as any).__OBS_CTX__?.world?.scene?.three;
    if (!scene) return;
    const sunPos = computeSunPosition();
    // Find directional light (sun)
    scene.traverse?.((obj: any) => {
      if (obj?.isDirectionalLight) {
        obj.position.set(sunPos.dir[0] * 100, sunPos.dir[1] * 100, sunPos.dir[2] * 100);
        obj.intensity = current.enabled ? Math.max(0.3, Math.sin(sunPos.elevation * Math.PI / 180)) : 0;
        if (obj.shadow) {
          obj.castShadow = current.enabled;
          obj.shadow.intensity = current.shadowIntensity;
        }
      }
      if (obj?.isAmbientLight) {
        obj.intensity = current.enabled ? 0.55 : 0.3;
      }
    });
  } catch { /* */ }
}

let installed = false;
export function setupSunSettings() {
  if (installed) return; installed = true;
  (window as any).__obsSun = { get: getSunSettings, set: setSunSettings, compute: computeSunPosition };
  setTimeout(applySun, 2000);
  console.log("[sun-settings] ready. Configure via __obsSun.set({ date, time, latitude, ... }).");
}
