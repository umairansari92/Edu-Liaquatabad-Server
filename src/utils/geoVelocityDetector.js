/**
 * Impossible Travel & Geo-Velocity Anomaly Detection Engine
 * CVifyPro Enterprise Security Architecture
 */

// Max realistic commercial passenger flight speed in km/h
const MAX_COMMERCIAL_FLIGHT_SPEED_KMH = 800;

// Earth radius in kilometers
const EARTH_RADIUS_KM = 6371;

/**
 * Calculates Great-Circle Distance between two coordinates using Haversine formula
 */
export const calculateHaversineDistance = (lat1, lon1, lat2, lon2) => {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
};

/**
 * Evaluates whether two consecutive access events represent "Impossible Travel"
 * @param {Object} previousLocation { latitude, longitude, country, city, timestamp }
 * @param {Object} currentLocation  { latitude, longitude, country, city, timestamp }
 * @returns {Object} { isImpossibleTravel: boolean, velocityKmh: number, distanceKm: number, timeDeltaHours: number, reason: string }
 */
export const evaluateImpossibleTravel = (previousLocation, currentLocation) => {
  if (!previousLocation || !currentLocation) {
    return { isImpossibleTravel: false, velocityKmh: 0, distanceKm: 0 };
  }

  const timeDeltaMs = currentLocation.timestamp - previousLocation.timestamp;
  const timeDeltaHours = timeDeltaMs / (1000 * 60 * 60);

  // If previous event was more than 48 hours ago, treat as normal
  if (timeDeltaHours > 48 || timeDeltaHours <= 0) {
    return { isImpossibleTravel: false, velocityKmh: 0, distanceKm: 0 };
  }

  // If different countries accessed in under 1 hour, immediately flag
  if (
    previousLocation.country &&
    currentLocation.country &&
    previousLocation.country !== currentLocation.country &&
    timeDeltaHours < 1
  ) {
    return {
      isImpossibleTravel: true,
      velocityKmh: 9999,
      distanceKm: 2000,
      timeDeltaHours,
      reason: `Impossible international geographic hop from ${previousLocation.country} to ${currentLocation.country} in ${(timeDeltaHours * 60).toFixed(0)} minute(s).`,
    };
  }

  // Calculate Great-Circle Distance
  const distanceKm = calculateHaversineDistance(
    previousLocation.latitude || 24.8607, // Default Karachi
    previousLocation.longitude || 67.0011,
    currentLocation.latitude || 24.8607,
    currentLocation.longitude || 67.0011
  );

  const velocityKmh = distanceKm / timeDeltaHours;

  if (distanceKm > 100 && velocityKmh > MAX_COMMERCIAL_FLIGHT_SPEED_KMH) {
    return {
      isImpossibleTravel: true,
      velocityKmh: Math.round(velocityKmh),
      distanceKm: Math.round(distanceKm),
      timeDeltaHours: Number(timeDeltaHours.toFixed(2)),
      reason: `Geo-velocity (${Math.round(velocityKmh)} km/h) over ${Math.round(distanceKm)} km exceeds realistic physical travel limits (${MAX_COMMERCIAL_FLIGHT_SPEED_KMH} km/h).`,
    };
  }

  return {
    isImpossibleTravel: false,
    velocityKmh: Math.round(velocityKmh),
    distanceKm: Math.round(distanceKm),
    timeDeltaHours: Number(timeDeltaHours.toFixed(2)),
  };
};
