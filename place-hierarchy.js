// Pure hierarchy helpers shared by detection and storage recovery.
// Keeping these functions browser-independent also lets the real movement flow
// be covered by the regression tests with a small in-memory location manager.

export function normalizePlaceLabel(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, ' ')
        .trim();
}

export function equivalentPlaceLabel(left, right, dictionary = []) {
    const a = normalizePlaceLabel(left);
    const b = normalizePlaceLabel(right);
    if (!a || !b) return false;
    if (a === b) return true;
    return dictionary.some(group => {
        const labels = (Array.isArray(group) ? group : []).map(normalizePlaceLabel);
        return labels.includes(a) && labels.includes(b);
    });
}

export function locationMatchesExact(location, name) {
    const key = normalizePlaceLabel(name);
    if (!location || !key) return false;
    return [location.name, ...(location.aliases || [])]
        .some(label => normalizePlaceLabel(label) === key);
}

export function isSameLocationLabel(location, name, dictionary = []) {
    if (!location) return false;
    return [location.name, ...(location.aliases || [])]
        .some(label => equivalentPlaceLabel(label, name, dictionary));
}

export function topLevelLocationById(locations, id) {
    return (locations || []).find(location => location.id === id && !location.parentId) || null;
}

export function currentTopLevelLocation(locationManager) {
    const locations = locationManager?.locations || [];
    const current = locations.find(location => location.id === locationManager?.currentLocationId);
    if (!current) return null;
    if (!current.parentId) return current;
    return topLevelLocationById(locations, current.parentId);
}

export function resolveTopLevelParent(locationManager, childName, explicitParentId = '', dictionary = []) {
    const locations = locationManager?.locations || [];
    if (explicitParentId) {
        const explicit = topLevelLocationById(locations, explicitParentId);
        return explicit && !isSameLocationLabel(explicit, childName, dictionary) ? explicit : null;
    }
    const current = currentTopLevelLocation(locationManager);
    if (current && !isSameLocationLabel(current, childName, dictionary)) return current;
    return null;
}

// Exact sub-place names are contextual. Prefer the current top-level place and
// its own children; never borrow an identically named child from another parent.
export function findContextualExactLocation(locationManager, name) {
    const locations = locationManager?.locations || [];
    const currentTop = currentTopLevelLocation(locationManager);
    if (currentTop && locationMatchesExact(currentTop, name)) return currentTop;
    if (currentTop) {
        const currentSub = locations.find(location =>
            location.parentId === currentTop.id && locationMatchesExact(location, name));
        if (currentSub) return currentSub;
    }
    return locations.find(location => !location.parentId && locationMatchesExact(location, name)) || null;
}

export async function moveToDetectedLocation(locationManager, location, rpDate) {
    if (!locationManager || !location) return false;
    if (location.parentId) {
        const parent = topLevelLocationById(locationManager.locations, location.parentId);
        if (!parent) return false;
        if (locationManager.currentLocationId !== parent.id) await locationManager.moveTo(parent.id, rpDate);
        if (locationManager.currentSubLocationId !== location.id) await locationManager.moveToSub(location.id);
        return true;
    }
    if (locationManager.currentLocationId !== location.id) await locationManager.moveTo(location.id, rpDate);
    return true;
}

export async function commitDetectedSubLocation(locationManager, parentId, childName, rpDate, dictionary = []) {
    const parent = topLevelLocationById(locationManager?.locations, parentId);
    if (!parent || isSameLocationLabel(parent, childName, dictionary)) return null;
    const sub = await locationManager.findOrCreateSub(parent.id, childName);
    if (!sub || sub.parentId !== parent.id || sub.id === parent.id) return null;
    await moveToDetectedLocation(locationManager, sub, rpDate);
    return sub;
}

export function recoverCurrentLocationState(locations, configuredCurrentId, configuredSubId = '') {
    const current = (locations || []).find(location => location.id === configuredCurrentId);
    if (!current) {
        return { currentLocationId: null, currentSubLocationId: null, repaired: Boolean(configuredCurrentId || configuredSubId) };
    }
    if (!current.parentId) {
        const configuredSub = (locations || []).find(location =>
            location.id === configuredSubId && location.parentId === current.id);
        return {
            currentLocationId: current.id,
            currentSubLocationId: configuredSub?.id || null,
            repaired: Boolean(configuredSubId && !configuredSub),
        };
    }
    const parent = topLevelLocationById(locations, current.parentId);
    if (!parent) {
        return { currentLocationId: null, currentSubLocationId: null, repaired: true };
    }
    return { currentLocationId: parent.id, currentSubLocationId: current.id, repaired: true };
}
