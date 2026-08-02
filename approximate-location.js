// Deterministic, local-only placement for RP places without a confirmed address.

function finiteCoordinate(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
}

export function approximateCoordinatesNear(anchor, seed, minMeters = 30, maxMeters = 150) {
    const lat = finiteCoordinate(anchor?.lat, -90, 90);
    const lng = finiteCoordinate(anchor?.lng, -180, 180);
    if (lat == null || lng == null) return null;

    const min = Math.max(1, Math.min(10_000, Number(minMeters) || 30));
    const max = Math.max(min, Math.min(10_000, Number(maxMeters) || 150));
    const hash = stableHash(seed);
    const angle = ((hash % 3600) / 3600) * Math.PI * 2;
    const distance = min + ((hash >>> 12) % (Math.floor(max - min) + 1));
    const latitudeRadians = lat * Math.PI / 180;
    const longitudeScale = Math.max(0.2, Math.abs(Math.cos(latitudeRadians)));

    return {
        lat: lat + (distance / 111320) * Math.cos(angle),
        lng: lng + (distance / (111320 * longitudeScale)) * Math.sin(angle),
        distanceMeters: distance,
    };
}
