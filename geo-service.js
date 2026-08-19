// PAW MAP — privacy-bounded geocoding helpers
// Explicit manual search can use Photon, then Nominatim as a result-quality fallback.
// Automatic geocoding and reverse geocoding remain Photon-only.

import { extension_settings } from '../../../extensions.js';

const EXTENSION_NAME = 'rp-world-tracker';
const PHOTON_BASE = 'https://photon.komoot.io';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const CACHE_LIMIT = 100;
const REQUEST_INTERVAL_MS = 1000;
const COORDINATE_PRECISION = 4;
const AMBIGUOUS_AUTOMATIC_PLACE = new Set([
    'room', 'bedroom', 'bathroom', 'kitchen', 'living room', 'hall', 'lobby',
    'office', 'home', 'house', 'bar', 'club', 'cafe', 'restaurant', 'shop',
    'store', 'park', 'hotel', 'hospital', 'school', 'station',
    '방', '침실', '화장실', '욕실', '부엌', '주방', '거실', '복도', '로비',
    '사무실', '집', '술집', '클럽', '카페', '식당', '가게', '공원',
    '호텔', '병원', '학교', '역',
]);
const searchCache = new Map();
const reverseCache = new Map();
let lastRequestAt = 0;

function settings() {
    return extension_settings?.[EXTENSION_NAME] || {};
}

function cleanQuery(value) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[<>]/g, ' ')
        .replace(/"/g, '”')
        .replace(/'/g, '’')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
}

export function isAmbiguousAutomaticPlaceQuery(value) {
    const key = cleanQuery(value).normalize('NFKC').toLocaleLowerCase();
    return AMBIGUOUS_AUTOMATIC_PLACE.has(key);
}

function finiteCoordinate(value, min, max) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function remember(cache, key, value) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, value);
    return value;
}

async function fairFetch(url, init = {}) {
    const wait = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
            headers: { Accept: 'application/json', ...(init.headers || {}) },
            credentials: 'omit',
            referrerPolicy: init.referrerPolicy || 'no-referrer',
        });
    } finally {
        clearTimeout(timer);
    }
}

function resultLabel(properties) {
    const streetAddress = [properties?.street, properties?.housenumber]
        .map(cleanQuery)
        .filter(Boolean)
        .join(' ');
    const pieces = [
        properties?.name,
        streetAddress,
        properties?.locality,
        properties?.district,
        properties?.city,
        properties?.state,
        properties?.postcode,
        properties?.country,
    ].map(cleanQuery).filter(Boolean);
    return [...new Set(pieces)].slice(0, 7).join(', ');
}

function applyResultLanguage(url) {
    // Photon의 공개 서버는 `lang=ko`를 HTTP 400으로 거부한다.
    // 한국어 모드는 lang을 생략하면 OSM의 현지어 이름(한국은 한국어)을 돌려준다.
    if (settings().mapSearchLanguage === 'en') url.searchParams.set('lang', 'en');
}

function normalizeFeature(feature) {
    const coordinates = feature?.geometry?.coordinates;
    const properties = feature?.properties || {};
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const lng = finiteCoordinate(coordinates[0], -180, 180);
    const lat = finiteCoordinate(coordinates[1], -90, 90);
    if (lat == null || lng == null) return null;
    const name = cleanQuery(properties.name) || resultLabel(properties) || 'Unknown place';
    const fullName = resultLabel(properties) || name;
    return {
        name,
        fullName,
        display_name: fullName,
        lat,
        lng,
        lon: lng,
        type: cleanQuery(properties.type || properties.osm_value || ''),
        category: cleanQuery(properties.osm_key || ''),
        osmId: properties.osm_id || null,
    };
}

function normalizeNominatimResult(item) {
    const lat = finiteCoordinate(item?.lat, -90, 90);
    const lng = finiteCoordinate(item?.lon, -180, 180);
    if (lat == null || lng == null) return null;
    const named = item?.namedetails || {};
    const address = item?.address || {};
    const name = cleanQuery(named['name:ko'] || named.name || item?.name || address.amenity || address.building || address.road || item?.display_name) || 'Unknown place';
    const fullName = cleanQuery(item?.display_name) || name;
    return {
        name,
        fullName,
        display_name: fullName,
        lat,
        lng,
        lon: lng,
        type: cleanQuery(item?.addresstype || item?.type || ''),
        category: cleanQuery(item?.category || item?.class || ''),
        osmId: item?.osm_id || null,
    };
}

function normalizedSearchText(value) {
    return cleanQuery(value).normalize('NFKC').toLocaleLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
}

function hasUsefulQueryOverlap(query, results) {
    const tokens = cleanQuery(query).normalize('NFKC').toLocaleLowerCase()
        .split(/[\s,]+/).map(normalizedSearchText).filter(token => token.length >= 2);
    if (!tokens.length) return results.length > 0;
    return results.some(result => {
        const haystack = normalizedSearchText(`${result.name} ${result.fullName}`);
        return tokens.some(token => haystack.includes(token));
    });
}

async function searchNominatim(query, limit) {
    const url = new URL(`${NOMINATIM_BASE}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('namedetails', '1');
    url.searchParams.set('accept-language', 'ko,en');
    url.searchParams.set('limit', String(limit));
    // 수동 Enter 검색에서만 호출한다. 공개 서버 정책상 자동완성·백그라운드 호출은 하지 않는다.
    const response = await fairFetch(url.toString(), { referrerPolicy: 'origin' });
    if (!response.ok) return { ok: false, results: [] };
    const data = await response.json();
    return {
        ok: true,
        results: Array.isArray(data) ? data.map(normalizeNominatimResult).filter(Boolean) : [],
    };
}

/**
 * Search OpenStreetMap place data through Photon.
 * `automatic: true` is blocked unless the user explicitly enables it.
 */
export async function searchPlaces(query, options = {}) {
    const automatic = options.automatic === true;
    const throwOnError = options.throwOnError === true;
    if (automatic && settings().allowAutoGeocoding !== true) return [];

    const q = cleanQuery(query);
    if (q.length < 2) return [];
    // Bare generic RP labels have thousands of real-world namesakes. Manual
    // search remains available, but background geocoding must not turn "Room"
    // or "방" into an unrelated country.
    if (automatic && isAmbiguousAutomaticPlaceQuery(q)) return [];
    const limit = Math.max(1, Math.min(5, Number(options.limit) || 5));
    const lat = finiteCoordinate(options.bias?.lat, -90, 90);
    const lng = finiteCoordinate(options.bias?.lng, -180, 180);
    // v0.9.52: globalMerge — bias 결과와 전세계(bias 없는) 결과를 병합.
    //   수동 주소 검색에서 "New York" 쳤는데 서울 주변만 나오는 문제 해결.
    const globalMerge = options.globalMerge === true && lat != null && lng != null;
    const cacheKey = JSON.stringify([q.toLowerCase(), limit, lat, lng, globalMerge]);
    if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);

    const buildUrl = (useBias) => {
        const url = new URL(`${PHOTON_BASE}/api/`);
        url.searchParams.set('q', q);
        url.searchParams.set('limit', String(limit));
        applyResultLanguage(url);
        if (useBias && lat != null && lng != null) {
            url.searchParams.set('lat', lat.toFixed(COORDINATE_PRECISION));
            url.searchParams.set('lon', lng.toFixed(COORDINATE_PRECISION));
        }
        return url;
    };

    try {
        const requests = [fairFetch(buildUrl(true).toString())];
        if (globalMerge) requests.push(fairFetch(buildUrl(false).toString()));
        const responses = await Promise.allSettled(requests);

        const features = [];
        let anyOk = false;
        for (const settled of responses) {
            if (settled.status !== 'fulfilled' || !settled.value?.ok) continue;
            anyOk = true;
            try {
                const data = await settled.value.json();
                if (Array.isArray(data?.features)) features.push(...data.features);
            } catch (_) {}
        }
        // 정규화 + 좌표 기준 dedupe (bias/global 중복 제거)
        const photonResults = [];
        for (const feature of features) {
            const norm = normalizeFeature(feature);
            if (!norm) continue;
            photonResults.push(norm);
            if (photonResults.length >= limit * 2) break; // bias+global 합쳐 최대 2배
        }

        // Photon 결과가 없거나 한글 검색어와 전혀 맞지 않을 때만 Nominatim을 보조로 사용한다.
        // 자동 장소 탐지에는 사용하지 않아 외부 전송 범위를 늘리지 않는다.
        let nominatimOk = false;
        let nominatimResults = [];
        const hasHangul = /[가-힣]/.test(q);
        const needsFallback = !automatic && (!photonResults.length || (hasHangul && !hasUsefulQueryOverlap(q, photonResults)));
        if (needsFallback) {
            try {
                const fallback = await searchNominatim(q, limit);
                nominatimOk = fallback.ok;
                nominatimResults = fallback.results;
            } catch (_) {}
        }
        if (!anyOk && !nominatimOk) {
            if (throwOnError) throw new Error('Map search failed');
            return [];
        }

        const seen = new Set();
        const results = [];
        for (const norm of [...nominatimResults, ...photonResults]) {
            const key = `${norm.lat.toFixed(4)}|${norm.lng.toFixed(4)}|${normalizedSearchText(norm.fullName)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push(norm);
            if (results.length >= limit * 2) break;
        }
        return remember(searchCache, cacheKey, results);
    } catch (error) {
        if (throwOnError) throw error;
        return [];
    }
}

/** Reverse-geocode RP-map coordinates. No chat text or place name is sent. */
export async function reverseGeocode(latValue, lngValue) {
    const lat = finiteCoordinate(latValue, -90, 90);
    const lng = finiteCoordinate(lngValue, -180, 180);
    if (lat == null || lng == null) return null;
    const cacheKey = `${lat.toFixed(COORDINATE_PRECISION)},${lng.toFixed(COORDINATE_PRECISION)}`;
    if (reverseCache.has(cacheKey)) return reverseCache.get(cacheKey);

    const url = new URL(`${PHOTON_BASE}/reverse`);
    url.searchParams.set('lat', lat.toFixed(COORDINATE_PRECISION));
    url.searchParams.set('lon', lng.toFixed(COORDINATE_PRECISION));
    applyResultLanguage(url);

    try {
        const response = await fairFetch(url.toString());
        if (!response.ok) return null;
        const data = await response.json();
        const result = normalizeFeature(data?.features?.[0]);
        return remember(reverseCache, cacheKey, result);
    } catch (_) {
        return null;
    }
}

export function clearGeoCaches() {
    searchCache.clear();
    reverseCache.clear();
}
