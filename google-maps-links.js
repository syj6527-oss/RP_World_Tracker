// User-initiated Google Maps URLs only. No API key, SDK, Places API, or billing account.

const GOOGLE_MAPS_ORIGIN = 'https://www.google.com';
const MAX_MAPS_URL_LENGTH = 2048;
const FORBIDDEN_PARAM = /^(?:key|api[_-]?key|token|access[_-]?token|authorization|utm_.+)$/i;
const SECRET_TEXT = /(?:\bAIza[0-9A-Za-z_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bsk-[0-9A-Za-z_-]{16,}\b|\bBearer\s+\S+|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret)\s*[:=]\s*\S+)/i;

function safeText(value, maxLength = 300) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[<>\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function coordinates(location) {
    if (location?._approximateCoordinates === true) return '';
    if (location?.lat == null || location?.lng == null || String(location.lat).trim() === '' || String(location.lng).trim() === '') return '';
    const lat = Number(location?.lat);
    const lng = Number(location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return '';
    return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function storedLocationQuery(location) {
    if (!location || location.verification === 'candidate') return '';
    const point = coordinates(location);
    if (point) return point;
    const address = safeText(location.address, 300);
    if (address && !SECRET_TEXT.test(address)) return address;
    const name = safeText(location.name, 160);
    return name && !SECRET_TEXT.test(name) ? name : '';
}

function hasOnlyParams(url, allowed) {
    for (const key of url.searchParams.keys()) {
        if (!allowed.has(key) || FORBIDDEN_PARAM.test(key)) return false;
    }
    return [...allowed].every(key => url.searchParams.getAll(key).length <= 1);
}

export function isAllowedGoogleMapsUrl(value) {
    const raw = String(value || '');
    if (!raw || raw.length > MAX_MAPS_URL_LENGTH) return false;
    let url;
    try { url = new URL(raw); } catch (_) { return false; }
    if (url.origin !== GOOGLE_MAPS_ORIGIN || url.username || url.password || url.hash) return false;
    if (url.searchParams.get('api') !== '1' || url.searchParams.getAll('api').length !== 1) return false;

    if (url.pathname === '/maps/search/') {
        return hasOnlyParams(url, new Set(['api', 'query'])) && Boolean(safeText(url.searchParams.get('query'), 500));
    }
    if (url.pathname === '/maps/dir/') {
        const mode = url.searchParams.get('travelmode');
        return hasOnlyParams(url, new Set(['api', 'origin', 'destination', 'travelmode'])) &&
            Boolean(safeText(url.searchParams.get('origin'), 500)) &&
            Boolean(safeText(url.searchParams.get('destination'), 500)) &&
            (!mode || ['walking', 'driving', 'bicycling', 'transit'].includes(mode));
    }
    if (url.pathname === '/maps/@') {
        const viewpoint = String(url.searchParams.get('viewpoint') || '').split(',');
        const location = { lat: viewpoint[0], lng: viewpoint[1] };
        return hasOnlyParams(url, new Set(['api', 'map_action', 'viewpoint'])) &&
            url.searchParams.get('map_action') === 'pano' && viewpoint.length === 2 && Boolean(coordinates(location));
    }
    return false;
}

export function buildGoogleMapsUrl(action, destination, origin = null) {
    const destinationQuery = storedLocationQuery(destination);
    if (!destinationQuery) return null;

    let url;
    if (action === 'view') {
        url = new URL('/maps/search/', GOOGLE_MAPS_ORIGIN);
        url.searchParams.set('api', '1');
        url.searchParams.set('query', destinationQuery);
    } else if (action === 'directions') {
        const originQuery = storedLocationQuery(origin);
        // Never omit origin: Google must not silently substitute the device's real location.
        if (!originQuery) return null;
        url = new URL('/maps/dir/', GOOGLE_MAPS_ORIGIN);
        url.searchParams.set('api', '1');
        url.searchParams.set('origin', originQuery);
        url.searchParams.set('destination', destinationQuery);
        url.searchParams.set('travelmode', 'walking');
    } else if (action === 'streetview') {
        const viewpoint = coordinates(destination);
        if (!viewpoint) return null;
        url = new URL('/maps/@', GOOGLE_MAPS_ORIGIN);
        url.searchParams.set('api', '1');
        url.searchParams.set('map_action', 'pano');
        url.searchParams.set('viewpoint', viewpoint);
    } else {
        return null;
    }

    const result = url.toString();
    return isAllowedGoogleMapsUrl(result) ? result : null;
}

export function openExternalMapUrl(url) {
    if (!isAllowedGoogleMapsUrl(url)) return false;
    const parsed = new URL(String(url));
    const opened = window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    if (opened) {
        try { opened.opener = null; } catch (_) {}
    }
    return true;
}
