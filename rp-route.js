// Session-only, local RP routing between two PAW MAP pins.
// This deliberately does not call a road-routing provider.

function coordinate(value, min, max) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

export function calculateRpRoute(origin, destination) {
    const originLat = coordinate(origin?.lat, -90, 90);
    const originLng = coordinate(origin?.lng, -180, 180);
    const destinationLat = coordinate(destination?.lat, -90, 90);
    const destinationLng = coordinate(destination?.lng, -180, 180);
    if (originLat == null || originLng == null || destinationLat == null || destinationLng == null) return null;

    const earthRadius = 6_371_000;
    const dLat = (destinationLat - originLat) * Math.PI / 180;
    const dLng = (destinationLng - originLng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(originLat * Math.PI / 180) * Math.cos(destinationLat * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    const distanceMeters = Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    const walkingMinutes = Math.max(1, Math.round((distanceMeters * 1.4) / 80));

    return {
        originId: String(origin?.id || ''),
        destinationId: String(destination?.id || ''),
        originName: String(origin?.name || '출발지'),
        destinationName: String(destination?.name || '도착지'),
        coordinates: [[originLng, originLat], [destinationLng, destinationLat]],
        distanceMeters,
        walkingMinutes,
        approximate: origin?._approximateCoordinates === true || destination?._approximateCoordinates === true,
    };
}

export function rpRouteGeoJson(route) {
    if (!route || !Array.isArray(route.coordinates) || route.coordinates.length !== 2) {
        return { type: 'FeatureCollection', features: [] };
    }
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: { approximate: route.approximate === true },
            geometry: { type: 'LineString', coordinates: route.coordinates },
        }],
    };
}
