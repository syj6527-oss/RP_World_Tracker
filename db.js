// 🐶 World Tracker — db.js

const DB_NAME = 'RPWorldTracker';
const DB_VERSION = 2;
const SECRET_FIELD_PATTERN = /^(?:api[_-]?key|private[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|vertexSaJson|llmApiKey)$/i;

export function redactSecretFields(value, depth = 0) {
    if (value == null || typeof value !== 'object') return value;
    if (depth > 16) return undefined;
    if (Array.isArray(value)) return value.map(item => redactSecretFields(item, depth + 1)).filter(item => item !== undefined);
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key) || SECRET_FIELD_PATTERN.test(key)) continue;
        const clean = redactSecretFields(child, depth + 1);
        if (clean !== undefined) output[key] = clean;
    }
    return output;
}

export class WorldTrackerDB {
    constructor() { this.db = null; }

    async open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('locations')) {
                    const s = db.createObjectStore('locations', { keyPath: 'id' });
                    s.createIndex('chatId', 'chatId', { unique: false });
                }
                if (!db.objectStoreNames.contains('movements')) {
                    const s = db.createObjectStore('movements', { keyPath: 'id', autoIncrement: true });
                    s.createIndex('chatId', 'chatId', { unique: false });
                }
                if (!db.objectStoreNames.contains('mapConfig'))
                    db.createObjectStore('mapConfig', { keyPath: 'chatId' });
                if (!db.objectStoreNames.contains('distances')) {
                    const s = db.createObjectStore('distances', { keyPath: 'id' });
                    s.createIndex('chatId', 'chatId', { unique: false });
                }
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    _tx(store, mode = 'readonly') { return this.db.transaction(store, mode).objectStore(store); }
    _p(req, val) { return new Promise((ok, no) => { req.onsuccess = () => ok(val); req.onerror = (e) => no(e.target.error); }); }
    _r(req) { return new Promise((ok, no) => { req.onsuccess = () => ok(req.result || null); req.onerror = (e) => no(e.target.error); }); }

    async putLocation(l) { return this._p(this._tx('locations', 'readwrite').put(l), l); }
    async getLocationsByChatId(id) { return this._r(this._tx('locations').index('chatId').getAll(id)); }
    async deleteLocation(id) { return this._p(this._tx('locations', 'readwrite').delete(id), true); }
    async addMovement(m) {
        const request = this._tx('movements', 'readwrite').add(m);
        return new Promise((resolve, reject) => {
            request.onsuccess = () => { m.id = request.result; resolve(m); };
            request.onerror = event => reject(event.target.error);
        });
    }
    async getMovementsByChatId(id) { return this._r(this._tx('movements').index('chatId').getAll(id)); }
    async deleteMovement(id) { return this._p(this._tx('movements', 'readwrite').delete(id), true); }
    async getMapConfig(id) { return this._r(this._tx('mapConfig').get(id)); }
    async saveMapConfig(c) { return this._p(this._tx('mapConfig', 'readwrite').put(c), c); }
    async saveDistance(d) { return this._p(this._tx('distances', 'readwrite').put(d), d); }
    async getDistancesByChatId(id) { return this._r(this._tx('distances').index('chatId').getAll(id)); }
    async deleteDistance(id) { return this._p(this._tx('distances', 'readwrite').delete(id), true); }

    // ========== 데이터 관리 ==========
    // 채팅별 백업
    async exportChat(chatId) {
        const locs = await this.getLocationsByChatId(chatId) || [];
        const movs = await this.getMovementsByChatId(chatId) || [];
        const dists = await this.getDistancesByChatId(chatId) || [];
        const cfg = await this.getMapConfig(chatId);
        return redactSecretFields({ chatId, locations: locs, movements: movs, distances: dists, mapConfig: cfg, exportedAt: Date.now(), version: '0.9.50-secure-beta' });
    }

    // 채팅별 복원
    async importChat(data) {
        data = redactSecretFields(data);
        if (!data?.chatId) return false;
        for (const l of data.locations || []) await this.putLocation(l);
        for (const m of data.movements || []) { try { await this._p(this._tx('movements','readwrite').put(m), m); } catch(_){} }
        for (const d of data.distances || []) await this.saveDistance(d);
        if (data.mapConfig) await this.saveMapConfig(data.mapConfig);
        return true;
    }

    // 채팅별 삭제
    async deleteChat(chatId) {
        const locs = await this.getLocationsByChatId(chatId) || [];
        for (const l of locs) await this.deleteLocation(l.id);
        const movs = await this.getMovementsByChatId(chatId) || [];
        for (const m of movs) { try { await this._p(this._tx('movements','readwrite').delete(m.id), true); } catch(_){} }
        const dists = await this.getDistancesByChatId(chatId) || [];
        for (const d of dists) { try { await this._p(this._tx('distances','readwrite').delete(d.id), true); } catch(_){} }
        try { await this._p(this._tx('mapConfig','readwrite').delete(chatId), true); } catch(_){}
        return true;
    }

    // 전체 백업
    async exportAll() {
        const allData = {};
        const tx = this.db.transaction(['locations','movements','distances','mapConfig'], 'readonly');
        allData.locations = await this._r(tx.objectStore('locations').getAll()) || [];
        allData.movements = await this._r(tx.objectStore('movements').getAll()) || [];
        allData.distances = await this._r(tx.objectStore('distances').getAll()) || [];
        allData.mapConfigs = await this._r(tx.objectStore('mapConfig').getAll()) || [];
        allData.exportedAt = Date.now(); allData.version = '0.9.50-secure-beta';
        return redactSecretFields(allData);
    }

    // 전체 복원
    async importAll(data) {
        data = redactSecretFields(data);
        if (!data?.locations) return false;
        for (const l of data.locations) await this.putLocation(l);
        for (const m of data.movements || []) { try { await this._p(this._tx('movements','readwrite').put(m), m); } catch(_){} }
        for (const d of data.distances || []) await this.saveDistance(d);
        for (const c of data.mapConfigs || []) await this.saveMapConfig(c);
        return true;
    }

    // 전체 삭제
    async deleteAll() {
        await this._p(this._tx('locations','readwrite').clear(), true);
        await this._p(this._tx('movements','readwrite').clear(), true);
        await this._p(this._tx('distances','readwrite').clear(), true);
        await this._p(this._tx('mapConfig','readwrite').clear(), true);
        return true;
    }
}
