// PAW MAP — device-local storage for a Vertex AI Express API key.
// The key is intentionally kept out of SillyTavern extension settings and
// PAW MAP exports. Other scripts running on the same SillyTavern origin can
// still access browser storage, so this is not a hardware-backed secret vault.

const STORAGE_KEY = 'paw-map.vertex-express-key.v1';
let memoryKey = '';

function normalizeKey(value) {
    return String(value || '').trim().slice(0, 4096);
}

export function getVertexApiKey() {
    try {
        const stored = normalizeKey(localStorage.getItem(STORAGE_KEY));
        if (stored) memoryKey = stored;
    } catch (_) {}
    return memoryKey;
}

export function saveVertexApiKey(value) {
    const key = normalizeKey(value);
    if (!key) return false;
    memoryKey = key;
    try { localStorage.setItem(STORAGE_KEY, key); } catch (_) {}
    return getVertexApiKey() === key;
}

export function clearVertexApiKey() {
    memoryKey = '';
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

export function maskVertexApiKey() {
    const key = getVertexApiKey();
    return key ? `***${key.slice(-4)}` : 'none';
}
