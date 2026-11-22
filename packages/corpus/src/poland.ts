/**
 * Is a point in Poland? Farcaster stores a stated location as coordinates rounded to about a kilometre.
 * The outline below is a coarse polygon of the border (longitude, latitude); it is good to a few kilometres,
 * which is all rounded coordinates can support. A town that straddles the border may fall on either side.
 */
const BORDER: [number, number][] = [
  [14.22, 53.93], [16.2, 54.3], [17.9, 54.83], [18.6, 54.75], [19.6, 54.45], [22.8, 54.36], [23.5, 53.95], [23.9, 52.7], [23.65, 52.08], [24.15, 50.86],
  [23.6, 50.4], [22.65, 49.5], [22.89, 49.0], [22.0, 49.1], [20.9, 49.3], [20.1, 49.17], [19.8, 49.19], [19.47, 49.4], [19.2, 49.4], [18.85, 49.52], [18.0, 50.0], [17.0, 50.4], [16.2, 50.4],
  [15.0, 50.9], [14.82, 50.87], [14.97, 51.4], [14.6, 52.1], [14.13, 52.84], [14.4, 53.3],
];

const CITIES: [string, number, number][] = [
  ['Warszawa', 52.23, 21.01], ['Kraków', 50.06, 19.94], ['Łódź', 51.76, 19.46], ['Wrocław', 51.11, 17.03], ['Poznań', 52.41, 16.93], ['Gdańsk', 54.35, 18.65],
  ['Szczecin', 53.43, 14.55], ['Bydgoszcz', 53.12, 18.01], ['Lublin', 51.25, 22.57], ['Białystok', 53.13, 23.16], ['Katowice', 50.26, 19.02], ['Gdynia', 54.52, 18.53],
  ['Rzeszów', 50.04, 22.0], ['Toruń', 53.01, 18.6], ['Kielce', 50.87, 20.63], ['Olsztyn', 53.78, 20.48], ['Opole', 50.67, 17.93], ['Zielona Góra', 51.94, 15.51],
  ['Gorzów Wielkopolski', 52.73, 15.24], ['Częstochowa', 50.81, 19.12], ['Radom', 51.4, 21.15], ['Bielsko-Biała', 49.82, 19.05], ['Gliwice', 50.29, 18.67],
  ['Tarnów', 50.01, 20.99], ['Nowy Sącz', 49.62, 20.7], ['Koszalin', 54.19, 16.17], ['Słupsk', 54.46, 17.03], ['Płock', 52.55, 19.71], ['Elbląg', 54.16, 19.4], ['Zakopane', 49.3, 19.95],
];

/** Point-in-polygon by ray casting. */
export function inPoland(lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = BORDER.length - 1; i < BORDER.length; j = i++) {
    const [xi, yi] = BORDER[i];
    const [xj, yj] = BORDER[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The nearest larger Polish city and the distance to it in kilometres. */
export function nearestCity(lat: number, lon: number): { city: string; km: number } {
  let best = { city: CITIES[0][0], km: Infinity };
  for (const [city, clat, clon] of CITIES) {
    const km = Math.hypot((lat - clat) * 111, (lon - clon) * 111 * Math.cos((lat * Math.PI) / 180));
    if (km < best.km) best = { city, km: Math.round(km) };
  }
  return best;
}

/** "geo:52.23,21.01" → coordinates. */
export function parseGeo(value: string | undefined): { lat: number; lon: number } | undefined {
  const m = value?.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : undefined;
}
