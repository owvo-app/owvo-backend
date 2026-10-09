/**
 * ETA utility — Google Distance Matrix (traffic-aware).
 *
 * OWVO Map Standard: ETA hamesha traffic-aware hona chahiye
 * (duration_in_traffic + departure_time=now).
 */

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Customer ki location se washer ke driveway tak traffic-aware ETA + distance.
 *
 * @param {number} originLat - customer latitude
 * @param {number} originLng - customer longitude
 * @param {number} destLat - driveway latitude
 * @param {number} destLng - driveway longitude
 * @returns {Promise<{etaMinutes: number|null, distanceMiles: number|null}>}
 */
export async function getTrafficEta(originLat, originLng, destLat, destLng) {
  const fallback = { etaMinutes: null, distanceMiles: null };

  if (
    ![originLat, originLng, destLat, destLng].every(
      (v) => typeof v === "number" && Number.isFinite(v)
    )
  ) {
    return fallback;
  }
  if (!GOOGLE_API_KEY) {
    return fallback;
  }

  try {
    const url =
      "https://maps.googleapis.com/maps/api/distancematrix/json" +
      `?origins=${originLat},${originLng}` +
      `&destinations=${destLat},${destLng}` +
      "&mode=driving" +
      "&departure_time=now" +
      "&traffic_model=best_guess" +
      `&key=${GOOGLE_API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) return fallback;

    const data = await res.json();
    const element = data?.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") return fallback;

    // duration_in_traffic prefer karo (traffic-aware), warna duration
    const durationSec =
      element.duration_in_traffic?.value ?? element.duration?.value ?? null;
    const distanceMeters = element.distance?.value ?? null;

    return {
      etaMinutes:
        typeof durationSec === "number" ? Math.round(durationSec / 60) : null,
      distanceMiles:
        typeof distanceMeters === "number"
          ? Math.round((distanceMeters / 1609.344) * 10) / 10
          : null,
    };
  } catch {
    return fallback;
  }
}
