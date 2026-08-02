// 🐶 월드맵 — location-manager.js (Single Scene)

import { getContext, extension_settings } from '../../../extensions.js';
import { EXTENSION_NAME } from './index.js';
import { reverseGeocode } from './geo-service.js';
import { approximateCoordinatesNear } from './approximate-location.js';
import { equivalentPlaceLabel, recoverCurrentLocationState } from './place-hierarchy.js';

const SECRET_FIELD_PATTERN = /^(?:api[_-]?key|private[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|vertexSaJson|llmApiKey)$/i;

function withoutSecretFields(value, depth = 0) {
    if (depth > 12 || value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, 5000).map(item => withoutSecretFields(item, depth + 1));
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 500)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key) || SECRET_FIELD_PATTERN.test(key)) continue;
        output[key] = withoutSecretFields(child, depth + 1);
    }
    return output;
}

function safeText(value, maxLength = 1000) {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[<>]/g, ' ')
        .replace(/"/g, '”')
        .replace(/'/g, '’')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function safeEmoji(value, fallback = '👤') {
    const text = safeText(value, 12);
    if (!text) return fallback;
    try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)][0]?.segment || fallback; }
    catch (_) { return Array.from(text)[0] || fallback; }
}

function safeIdentifier(value, maxLength = 160) {
    const identifier = String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, maxLength);
    return identifier || '';
}

function normalizedDetectionName(value) {
    return safeText(value, 160)
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, ' ')
        .trim();
}

function finiteNumber(value, min, max, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function finiteInteger(value, min, max, fallback = 0) {
    const number = finiteNumber(value, min, max, fallback);
    return number == null ? fallback : Math.trunc(number);
}

function safeColor(value, fallback = '#A8D8EA') {
    const color = String(value || '').trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : fallback;
}

export class LocationManager {
    constructor(db) {
        this.db = db;
        this.currentChatId = null;
        this.currentLocationId = null;
        this.currentSubLocationId = null; // ★ 현재 서브로케이션 엔티티 ID
        this.locations = [];
        this.movements = [];
        this.distances = [];
        this.ignoredDetectedNames = [];
    }

    _sanitizeEvent(event = {}) {
        return {
            ...withoutSecretFields(event),
            text: safeText(event.text, 5000),
            title: safeText(event.title, 160),
            mood: safeEmoji(event.mood, '📝'),
            source: safeText(event.source, 30),
            rpDate: safeText(event.rpDate, 80),
            planWhen: safeText(event.planWhen, 100),
            planDate: safeText(event.planDate, 80),
            promisePlace: safeText(event.promisePlace, 160),
            timestamp: finiteNumber(event.timestamp, 0, 8_640_000_000_000_000, Date.now()),
            isPlan: event.isPlan === true,
        };
    }

    _sanitizeNpc(npc = {}) {
        return {
            ...withoutSecretFields(npc),
            name: safeText(npc.name, 80) || 'Unknown',
            type: npc.type === 'animal' ? 'animal' : 'npc',
            role: safeText(npc.role, 100),
            avatar: safeEmoji(npc.avatar, npc.type === 'animal' ? '🐾' : '👤'),
            bio: safeText(npc.bio, 1000),
            personality: Array.isArray(npc.personality) ? npc.personality.slice(0, 12).map(v => safeText(v, 80)).filter(Boolean) : [],
            relationship: safeText(npc.relationship, 1000),
            affinity: finiteNumber(npc.affinity, 1, 5, 3),
            count: finiteInteger(npc.count, 0, 1_000_000, 0),
            firstSeen: finiteNumber(npc.firstSeen, 0, 8_640_000_000_000_000, null),
            lastSeen: finiteNumber(npc.lastSeen, 0, 8_640_000_000_000_000, null),
        };
    }

    _sanitizeReply(reply = {}) {
        return {
            name: safeText(reply.name, 80) || '익명',
            handle: safeText(reply.handle, 80),
            avatar: safeEmoji(reply.avatar, '👤'),
            text: safeText(reply.text, 1000),
        };
    }

    _sanitizePost(post = {}) {
        return {
            ...withoutSecretFields(post),
            id: safeIdentifier(post.id, 120),
            name: safeText(post.name, 80) || 'Unknown',
            handle: safeText(post.handle, 80),
            avatar: safeEmoji(post.avatar, post.type === 'animal' ? '🐾' : '👤'),
            type: ['npc', 'animal', 'anon', 'user'].includes(post.type) ? post.type : 'anon',
            mood: safeText(post.mood, 30),
            moodLabel: safeText(post.moodLabel, 60),
            text: safeText(post.text, 2000),
            mentions: Array.isArray(post.mentions) ? post.mentions.slice(0, 30).map(v => safeText(v, 80)).filter(Boolean) : [],
            hashtags: Array.isArray(post.hashtags) ? post.hashtags.slice(0, 30).map(v => safeText(v, 80)).filter(Boolean) : [],
            likes: finiteNumber(post.likes, 0, 1_000_000, 0),
            replies: Array.isArray(post.replies) ? post.replies.slice(0, 10).map(reply => this._sanitizeReply(reply)).filter(reply => reply.text) : [],
            rpDate: safeText(post.rpDate, 80),
            timestamp: finiteNumber(post.timestamp, 0, 8_640_000_000_000_000, Date.now()),
        };
    }

    _sanitizeReview(review = {}) {
        return {
            ...withoutSecretFields(review),
            name: safeText(review.name, 80),
            author: safeText(review.author, 80),
            role: safeText(review.role, 100),
            avatar: safeEmoji(review.avatar, '👤'),
            text: safeText(review.text, 2000),
            stars: finiteNumber(review.stars, 1, 5, 3),
            rating: finiteNumber(review.rating ?? review.stars, 1, 5, 3),
            daysAgo: finiteNumber(review.daysAgo, 0, 36500, 0),
            timestamp: finiteNumber(review.timestamp, 0, 8_640_000_000_000_000, null),
        };
    }

    _sanitizeMovement(movement = {}) {
        const clean = {
            ...withoutSecretFields(movement),
            _securitySanitized0946: true,
            _securitySanitized0947: true,
            chatId: String(movement.chatId || '').slice(0, 500),
            fromId: safeIdentifier(movement.fromId, 160),
            toId: safeIdentifier(movement.toId, 160),
            timestamp: finiteNumber(movement.timestamp, 0, 8_640_000_000_000_000, Date.now()),
            rpDate: safeText(movement.rpDate, 80),
            distance: safeText(movement.distance, 120),
        };
        const id = Number(movement.id);
        if (Number.isSafeInteger(id) && id > 0) clean.id = id;
        else delete clean.id;
        return clean;
    }

    _sanitizeDistance(distance = {}) {
        const distanceText = safeText(distance.distanceText, 120);
        const looksGenerated = /^(?:바로 옆|도보 \d+분|\d+(?:\.\d+)?km)$/.test(distanceText);
        const manual = distance._manual === true || (distance._source !== 'auto' && !looksGenerated);
        return {
            ...withoutSecretFields(distance),
            _securitySanitized0946: true,
            _securitySanitized0947: true,
            id: safeIdentifier(distance.id, 340),
            chatId: String(distance.chatId || '').slice(0, 500),
            fromId: safeIdentifier(distance.fromId, 160),
            toId: safeIdentifier(distance.toId, 160),
            distanceText,
            walkTime: distance.walkTime == null ? null : safeText(distance.walkTime, 120),
            level: finiteInteger(distance.level, 1, 10, 5),
            updatedAt: finiteNumber(distance.updatedAt, 0, 8_640_000_000_000_000, Date.now()),
            _manual: manual,
            _source: manual ? 'manual' : 'auto',
        };
    }

    _sanitizeLocationRecord(location = {}) {
        const clean = { ...withoutSecretFields(location), _securitySanitized0946: true, _securitySanitized0947: true };
        clean.id = safeIdentifier(location.id, 160);
        // chatId is a SillyTavern storage key, not display text; preserve it exactly.
        clean.chatId = String(location.chatId || '').slice(0, 500);
        clean.parentId = location.parentId == null ? null : safeIdentifier(location.parentId, 160);
        clean.name = safeText(location.name, 160) || 'Unnamed place';
        clean.aliases = Array.isArray(location.aliases) ? location.aliases.slice(0, 100).map(v => safeText(v, 160)).filter(Boolean) : [];
        clean.tags = Array.isArray(location.tags) ? location.tags.slice(0, 50).map(v => safeText(v, 80)).filter(Boolean) : [];
        clean.memo = safeText(location.memo, 5000);
        clean.aiNotes = safeText(location.aiNotes, 5000);
        clean.status = safeText(location.status, 500);
        clean.address = safeText(location.address, 500);
        clean.x = finiteNumber(location.x, -1_000_000, 1_000_000, 0);
        clean.y = finiteNumber(location.y, -1_000_000, 1_000_000, 0);
        clean.lat = location.lat == null ? null : finiteNumber(location.lat, -90, 90, null);
        clean.lng = location.lng == null ? null : finiteNumber(location.lng, -180, 180, null);
        clean.color = safeColor(location.color);
        clean.visitCount = finiteInteger(location.visitCount, 0, 1_000_000_000, 0);
        clean.firstVisited = finiteNumber(location.firstVisited, 0, 8_640_000_000_000_000, null);
        clean.lastVisited = finiteNumber(location.lastVisited, 0, 8_640_000_000_000_000, null);
        clean.rpFirstVisited = safeText(location.rpFirstVisited, 80);
        clean.rpLastVisited = safeText(location.rpLastVisited, 80);
        clean.createdAt = finiteNumber(location.createdAt, 0, 8_640_000_000_000_000, Date.now());
        clean.moodResetAt = finiteNumber(location.moodResetAt, 0, 8_640_000_000_000_000, null);
        clean.firstMentionMesId = safeIdentifier(location.firstMentionMesId, 160);
        clean.lastMentionMesId = safeIdentifier(location.lastMentionMesId, 160);
        clean.locationType = safeText(location.locationType, 40);
        clean.verification = location.verification === 'candidate' ? 'candidate' : 'confirmed';
        clean.source = ['manual', 'detected', 'import', 'legacy', 'character', 'schedule'].includes(location.source)
            ? location.source : 'legacy';
        clean.fictional = location.fictional === true;
        clean.injectMode = ['off', 'director', 'character'].includes(location.injectMode) ? location.injectMode : 'off';
        clean._manualXY = location._manualXY === true;
        clean._tempAddress = location._tempAddress === true;
        clean._geoFixed = location._geoFixed === true;
        clean._geocodeSuppressed = location._geocodeSuppressed === true;
        clean._approximateCoordinates = location._approximateCoordinates === true;
        clean._approximateAnchorId = location._approximateAnchorId == null ? null : safeIdentifier(location._approximateAnchorId, 160);
        clean.events = Array.isArray(location.events) ? location.events.slice(-100).map(event => this._sanitizeEvent(event)).filter(event => event.text) : [];
        clean.npcs = Array.isArray(location.npcs) ? location.npcs.slice(0, 100).map(npc => this._sanitizeNpc(npc)) : [];
        clean.community = Array.isArray(location.community) ? location.community.slice(0, 30).map(post => this._sanitizePost(post)).filter(post => post.text) : [];
        clean.generatedReviews = Array.isArray(location.generatedReviews) ? location.generatedReviews.slice(0, 30).map(review => this._sanitizeReview(review)).filter(review => review.text) : [];
        clean.reviewSummary = safeText(location.reviewSummary, 1000);
        clean._pins = Array.isArray(location._pins) ? location._pins.slice(0, 30).map(pin => ({
            kind: pin?.kind === 'review' ? 'review' : 'community',
            who: safeText(pin?.who, 80),
            text: safeText(pin?.text, 1000),
        })).filter(pin => pin.text) : [];
        clean.photos = Array.isArray(location.photos) ? location.photos.slice(0, 5).filter(photo =>
            typeof photo === 'string' && photo.length <= 2_000_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(photo)
        ) : [];
        return clean;
    }

    // ★ 서브로케이션 키워드
    static SUB_LOCATIONS = [
        '거실','부엌','주방','방','침실','안방','작은방','큰방','화장실','욕실','샤워실',
        '베란다','발코니','옥상','지하실','다락','서재','창고','세탁실','드레스룸',
        '복도','현관','로비','계단','엘리베이터',
        '마당','뒤뜰','앞마당','정원','차고','테라스',
        '사무실','회의실','휴게실','탕비실','대기실','접수처',
        '교실','강당','운동장','도서실','급식실','보건실',
        '과자 코너','음료 코너','계산대','진열대','매대',
        'room','bedroom','kitchen','bathroom','living room','restroom','washroom',
        'balcony','rooftop','basement','attic','study','garage','closet','pantry',
        'hallway','corridor','lobby','stairs','staircase','elevator',
        'yard','backyard','front yard','garden','terrace','porch',
        'office','meeting room','break room','waiting room','reception',
        'classroom','auditorium','gym','library','cafeteria',
        'aisle','counter','checkout','shelf',
    ];

    isSubLocation(name) {
        if (!name) return false;
        const lo = name.toLowerCase().trim();
        // 기본 키워드
        if (LocationManager.SUB_LOCATIONS.some(s => lo === s.toLowerCase() || lo.endsWith(s.toLowerCase()))) return true;
        // 별칭 맵
        for (const [key, aliases] of Object.entries(LocationManager.SUB_ALIASES)) {
            if (lo === key || aliases.some(a => lo === a.toLowerCase() || lo.endsWith(a.toLowerCase()))) return true;
        }
        return false;
    }

    // ★ 서브 장소 별칭 맵 (같은 장소의 다른 이름)
    static SUB_ALIASES = {
        '거실': ['리빙룸', '리빙 룸', 'living room', 'livingroom', 'lounge', '응접실', '라운지'],
        '부엌': ['주방', 'kitchen', '키친', '조리실', '요리실'],
        '침실': ['방', 'bedroom', '안방', '침대방', '자는방', '숙소'],
        '화장실': ['욕실', 'bathroom', 'restroom', 'toilet', '세면실', '샤워실', 'washroom', 'lavatory'],
        '서재': ['공부방', 'study', 'study room', '작업실', 'office'],
        '현관': ['입구', 'entrance', 'hallway', 'foyer', '복도'],
        '마당': ['정원', 'garden', 'yard', '뜰', 'backyard'],
        '차고': ['주차장', 'garage', 'parking'],
        '발코니': ['테라스', 'balcony', 'terrace', '베란다', 'veranda'],
        '지하실': ['지하', 'basement', '지하층'],
        '옥상': ['rooftop', '지붕'],
        '다락': ['다락방', 'attic'],
    };

    // ★ 서브 장소 이름 정규화 (긴 이름에서 핵심 키워드 추출)
    _normalizeSubName(raw) {
        const safeRaw = safeText(raw, 160);
        let name = safeRaw;
        // 콤마/괄호 정리 → 마지막 의미 있는 파트
        if (name.includes(',')) {
            const parts = name.split(',').map(p => p.trim()).filter(p => p.length >= 1);
            name = parts[parts.length - 1];
        }
        name = name.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
        // "Honey badger의 침실" → "침실"
        name = name.replace(/.*(?:의|'s)\s*/i, '');
        // "1층 라운지 소파 앞" → "라운지" (위치 수식어 제거)
        name = name.replace(/\d+층\s*/g, '').replace(/\s*(?:앞|뒤|옆|안|밖|위|아래|내부|외부|뒤편|맞은편)\s*$/g, '').trim();
        // 너무 길면 첫 의미 있는 단어만
        if (name.length > 15) {
            const subKws = [...LocationManager.SUB_LOCATIONS, ...Object.keys(LocationManager.SUB_ALIASES), ...Object.values(LocationManager.SUB_ALIASES).flat()];
            for (const kw of subKws) {
                if (name.toLowerCase().includes(kw.toLowerCase())) return kw;
            }
        }
        return name || safeRaw;
    }

    // ★ 서브 장소 찾기/생성 (별칭 매칭 강화)
    async findOrCreateSub(parentId, subName) {
        // A child may only belong to a real top-level place. This final storage
        // guard protects every caller, including old UI and metadata paths.
        const parent = this.locations.find(location => location.id === parentId && !location.parentId);
        if (!parent) return null;
        const normalized = this._normalizeSubName(subName);
        if (!normalized) return null;
        const parentLabels = [parent.name, ...(parent.aliases || [])];
        if (parentLabels.some(label => equivalentPlaceLabel(label, normalized, LocationManager.PLACE_DICT))) return null;
        const lo = normalized.toLowerCase().trim();

        // 별칭 그룹 찾기 (입력이 어떤 그룹에 속하는지)
        let aliasGroup = null;
        for (const [key, aliases] of Object.entries(LocationManager.SUB_ALIASES)) {
            if (key === lo || aliases.some(a => a.toLowerCase() === lo)) {
                aliasGroup = [key, ...aliases].map(a => a.toLowerCase());
                break;
            }
        }

        // 기존 서브 찾기 (이름 + 별칭 + 별칭 그룹)
        const existing = this.locations.find(l => {
            if (l.parentId !== parentId) return false;
            const n = l.name.toLowerCase();
            // 정확 매칭
            if (n === lo) return true;
            // 별칭 매칭
            if ((l.aliases||[]).some(a => a.toLowerCase() === lo)) return true;
            // 별칭 그룹 매칭 (거실 = 리빙룸 = living room)
            if (aliasGroup) {
                if (aliasGroup.includes(n)) return true;
                if ((l.aliases||[]).some(a => aliasGroup.includes(a.toLowerCase()))) return true;
            }
            // 부분 포함 매칭 (침실 ⊂ "NCO Barracks 2층 침실")
            if (lo.length >= 2 && (n.includes(lo) || lo.includes(n))) return true;
            return false;
        });
        if (existing) {
            // 별칭 추가 (normalized 이름이 다르면)
            if (existing.name.toLowerCase() !== lo && !(existing.aliases||[]).some(a => a.toLowerCase() === lo)) {
                const aliases = [...new Set([...(existing.aliases || []), normalized])];
                await this.db.putLocation({ ...existing, aliases });
                existing.aliases = aliases;
            }
            return existing;
        }
        // 새로 생성
        const loc = {
            id: this.generateId(), chatId: this.currentChatId,
            name: normalized, aliases: normalized !== safeText(subName, 160) ? [safeText(subName, 160)].filter(Boolean) : [], parentId: safeText(parent.id, 160),
            x: 0, y: 0, lat: null, lng: null,
            visitCount: 0, firstVisited: null, lastVisited: null,
            memo: '', status: '', color: this._rndColor(), createdAt: Date.now(), verification: 'confirmed', source: 'manual', _securitySanitized0946: true, _securitySanitized0947: true,
        };
        await this.db.putLocation(loc); this.locations.push(loc);
        return loc;
    }

    // ★ 서브 장소로 이동 (부모 이동 아님, visitCount만 업데이트)
    async moveToSub(subId) {
        const sub = this.locations.find(l => l.id === subId);
        if (!sub) return;
        sub.visitCount = (sub.visitCount || 0) + 1;
        sub.lastVisited = Date.now();
        if (!sub.firstVisited) sub.firstVisited = Date.now();
        await this.db.putLocation(sub);
        this.currentSubLocationId = subId;
        await this._saveCfg();
    }

    // ★ 부모 장소의 서브 목록
    getSubLocations(parentId) {
        return this.locations.filter(l => l.parentId === parentId);
    }

    // ★ 최상위 장소만 (서브 제외)
    getTopLocations() {
        return this.locations.filter(l => !l.parentId);
    }

    getChatId() { const ctx = getContext(); return ctx?.chatId ? String(ctx.chatId) : null; }
    getCharacterId() { const ctx = getContext(); return ctx?.characterId != null ? `char_${ctx.characterId}` : null; }
    generateId() { return `loc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

    // ★ 세계관 이어가기: 설정에 따라 characterId 또는 chatId 반환
    getDataKey() {
        const s = extension_settings[EXTENSION_NAME];
        if (s?.worldContinuity) {
            const charKey = this.getCharacterId();
            if (charKey) return charKey;
        }
        return this.getChatId();
    }

    async loadChat() {
        this.currentChatId = this.getDataKey();
        if (!this.currentChatId) { this.locations=[]; this.movements=[]; this.distances=[]; this.ignoredDetectedNames=[]; this.currentLocationId=null; this.currentSubLocationId=null; return; }
        const storedLocations = await this.db.getLocationsByChatId(this.currentChatId) || [];
        this.locations = storedLocations.map(location => this._sanitizeLocationRecord(location));
        for (let i = 0; i < this.locations.length; i++) {
            const original = storedLocations[i];
            const clean = this.locations[i];
            if (original?.id !== clean.id && original?.id != null) await this.db.deleteLocation(original.id);
            if (original?._securitySanitized0947 !== true || original?.id !== clean.id) await this.db.putLocation(clean);
        }
        const storedMovements = await this.db.getMovementsByChatId(this.currentChatId) || [];
        this.movements = [];
        for (const original of storedMovements) {
            const clean = this._sanitizeMovement(original);
            // Movement keys are generated numeric IDs. Drop malformed imported keys.
            if (!clean.id) {
                if (original?.id != null) await this.db.deleteMovement(original.id);
                continue;
            }
            this.movements.push(clean);
            if (original?.id !== clean.id && original?.id != null) await this.db.deleteMovement(original.id);
            if (original?._securitySanitized0947 !== true || original?.id !== clean.id) {
                try { await this.db._p(this.db._tx('movements', 'readwrite').put(clean), clean); } catch (_) {}
            }
        }
        const storedDistances = await this.db.getDistancesByChatId(this.currentChatId) || [];
        this.distances = [];
        for (const original of storedDistances) {
            const clean = this._sanitizeDistance(original);
            if (!clean.fromId || !clean.toId) continue;
            const canonicalId = [clean.fromId, clean.toId].sort().join('_');
            clean.id = canonicalId;
            if (original?.id !== canonicalId && original?.id != null) {
                try { await this.db._p(this.db._tx('distances', 'readwrite').delete(original.id), true); } catch (_) {}
            }
            this.distances.push(clean);
            if (original?._securitySanitized0947 !== true || original?.id !== canonicalId) await this.db.saveDistance(clean);
        }
        const cfg = await this.db.getMapConfig(this.currentChatId);
        const configuredCurrentId = safeIdentifier(cfg?.currentLocationId, 160) || null;
        const configuredSubId = safeIdentifier(cfg?.currentSubLocationId, 160) || null;
        const recoveredCurrent = recoverCurrentLocationState(this.locations, configuredCurrentId, configuredSubId);
        this.currentLocationId = recoveredCurrent.currentLocationId;
        this.currentSubLocationId = recoveredCurrent.currentSubLocationId;
        this.ignoredDetectedNames = Array.isArray(cfg?.ignoredDetectedNames)
            ? [...new Set(cfg.ignoredDetectedNames.slice(0, 300).map(normalizedDetectionName).filter(Boolean))]
            : [];
        // Old builds could persist a child ID as the world-map current location.
        // Repair only the config pointer; the child, its events and its parent stay untouched.
        if (recoveredCurrent.repaired) await this._saveCfg();
    }

    // ★ 마이그레이션: chatId 데이터를 characterId 키로 복사
    async migrateToCharacter() {
        const chatId = this.getChatId();
        const charKey = this.getCharacterId();
        if (!chatId || !charKey || chatId === charKey) return false;
        const existing = await this.db.getLocationsByChatId(charKey);
        if (existing && existing.length > 0) return true;
        const locs = await this.db.getLocationsByChatId(chatId) || [];
        const movs = await this.db.getMovementsByChatId(chatId) || [];
        const dists = await this.db.getDistancesByChatId(chatId) || [];
        const cfg = await this.db.getMapConfig(chatId);
        for (const l of locs) { l.chatId = charKey; await this.db.putLocation(l); }
        for (const m of movs) { m.chatId = charKey; try { await this.db._p(this.db._tx('movements','readwrite').put(m), m); } catch(_){} }
        for (const d of dists) { d.chatId = charKey; await this.db.saveDistance(d); }
        if (cfg) { cfg.chatId = charKey; await this.db.saveMapConfig(cfg); }
        return true;
    }

    async addLocation(name, memo = '', aliases = [], options = {}) {
        if (!this.currentChatId) return null;
        // B6: 이동경로 분리 — "카페→집" 또는 "카페 -> 집" 등
        const arrowPat = /\s*(?:→|->|➡|⟶|=>)\s*/;
        if (arrowPat.test(name)) {
            const parts = name.split(arrowPat).map(p => p.trim()).filter(p => p.length >= 1);
            let lastLoc = null;
            for (const part of parts) {
                const existing = this.findByNameExact(part);
                if (existing) { lastLoc = existing; continue; }
                lastLoc = await this._createSingleLocation(part, memo, aliases, options);
            }
            return lastLoc; // 마지막 장소(도착지) 반환
        }
        return this._createSingleLocation(name, memo, aliases, options);
    }

    async _createSingleLocation(name, memo = '', aliases = [], options = {}) {
        if (!this.currentChatId) return null;
        const safeName = safeText(name, 160);
        if (!safeName) return null;
        const loc = {
            id: this.generateId(), chatId: this.currentChatId,
            name: safeName, aliases: aliases.map(a => safeText(a, 160)).filter(Boolean),
            x: 0, y: 0, lat: null, lng: null,
            visitCount: 0, firstVisited: null, lastVisited: null,
            memo: safeText(memo, 5000), status: '', color: this._rndColor(), createdAt: Date.now(),
            verification: 'confirmed',
            source: ['manual', 'detected', 'import', 'character', 'schedule'].includes(options.source) ? options.source : 'manual',
            fictional: options.fictional === true,
            _securitySanitized0946: true,
            _securitySanitized0947: true,
        };
        const p = this._autoPos(); loc.x = p.x; loc.y = p.y;

        // 좌표가 없는 자동 등록 장소는 현재 장소 반경에 '추정 핀'으로 표시한다.
        // 외부 통신 없이 로컬 계산만 하며, 실제 주소/Street View 좌표로 취급하지 않는다.
        const anchor = this.locations.find(location =>
            location.id === this.currentLocationId && location.lat != null && location.lng != null && !location.parentId
        );
        if (anchor) {
            const approximate = approximateCoordinatesNear(anchor, `${loc.id}|${safeName}`, 30, 150);
            if (approximate) {
                loc.lat = approximate.lat;
                loc.lng = approximate.lng;
                loc._approximateCoordinates = true;
                loc._approximateAnchorId = anchor.id;
                loc._tempAddress = true;
            }
        }

        await this.db.putLocation(loc); this.locations.push(loc); return loc;
    }

    async updateLocation(id, u) {
        const l = this.locations.find(x => x.id === id); if (!l) return null;
        Object.assign(l, u);
        Object.assign(l, this._sanitizeLocationRecord(l));
        await this.db.putLocation(l);
        return l;
    }

    async deleteLocation(id) {
        const ids = new Set([id, ...this.locations.filter(l => l.parentId === id).map(l => l.id)]);
        for (const locId of ids) await this.db.deleteLocation(locId);
        for (const movement of [...this.movements]) {
            if (ids.has(movement.fromId) || ids.has(movement.toId)) {
                if (movement.id) await this.db.deleteMovement(movement.id);
            }
        }
        for (const distance of [...this.distances]) {
            if (ids.has(distance.fromId) || ids.has(distance.toId)) await this.db.deleteDistance(distance.id);
        }
        this.locations = this.locations.filter(l => !ids.has(l.id));
        this.movements = this.movements.filter(m => !ids.has(m.fromId) && !ids.has(m.toId));
        this.distances = this.distances.filter(d => !ids.has(d.fromId) && !ids.has(d.toId));
        if (ids.has(this.currentLocationId)) this.currentLocationId = null;
        if (ids.has(this.currentSubLocationId)) this.currentSubLocationId = null;
        await this._saveCfg();
    }

    // 한영 장소 사전 (이중 등록 방지)
    static PLACE_DICT = [
        ['집','Home','house'],['방','Room'],['학교','School'],['공원','Park'],['병원','Hospital'],
        ['카페','Cafe','cafe','coffee shop'],['식당','Restaurant'],['사무실','Office'],
        ['도서관','Library'],['교회','Church'],['가게','Shop','Store'],['시장','Market'],
        ['역','Station'],['공항','Airport'],['호텔','Hotel'],['숲','Forest'],
        ['해변','Beach'],['강','River'],['산','Mountain'],['궁전','Palace'],
        ['성','Castle'],['감옥','Prison'],['동굴','Cave'],['항구','Port','Harbor'],
        ['술집','Bar','Pub'],['체육관','Gym'],['극장','Theater','Theatre'],
        ['마트','Mart','Supermarket'],['편의점','Convenience store'],
    ];

    findByName(name) {
        const lo = safeText(name, 160).toLowerCase();
        // 직접 매칭
        const direct = this.locations.find(l =>
            l.name.toLowerCase() === lo || (l.aliases || []).some(a => a.toLowerCase() === lo)
        );
        if (direct) return direct;
        // ★ 부분 포함 매칭 (3글자 이상일 때: "Barracks" ⊂ "NCO Barracks")
        if (lo.length >= 3) {
            const partial = this.locations.find(l => {
                const n = l.name.toLowerCase();
                if (n.includes(lo) || lo.includes(n)) return true;
                if ((l.aliases || []).some(a => { const al = a.toLowerCase(); return al.includes(lo) || lo.includes(al); })) return true;
                return false;
            });
            if (partial) return partial;
        }
        // 한영 사전 매칭
        for (const group of LocationManager.PLACE_DICT) {
            const glo = group.map(w => w.toLowerCase());
            if (!glo.includes(lo)) continue;
            for (const loc of this.locations) {
                const names = [loc.name.toLowerCase(), ...(loc.aliases || []).map(a => a.toLowerCase())];
                if (names.some(n => glo.includes(n))) return loc;
            }
        }
        return null;
    }

    findByNameExact(name) {
        const lo = normalizedDetectionName(name);
        if (!lo) return null;
        return this.locations.find(location =>
            normalizedDetectionName(location.name) === lo ||
            (location.aliases || []).some(alias => normalizedDetectionName(alias) === lo)
        ) || null;
    }

    isDetectionIgnored(name) {
        const key = normalizedDetectionName(name);
        return Boolean(key && this.ignoredDetectedNames.includes(key));
    }

    async ignoreDetectedName(name) {
        const key = normalizedDetectionName(name);
        if (!key) return false;
        this.ignoredDetectedNames = [...new Set([...this.ignoredDetectedNames, key])].slice(-300);
        await this._saveCfg();
        return true;
    }

    async clearIgnoredDetectedNames() {
        this.ignoredDetectedNames = [];
        await this._saveCfg();
    }

    async moveTo(locationId, rpDate) {
        const loc = this.locations.find(l => l.id === locationId); if (!loc) return;
        // v0.9.11: rpDate를 명시하지 않으면 현재 RP 날짜를 자동 사용 (RP 내 시간 따름)
        if (rpDate == null) { try { rpDate = window._wtGetRpDate?.() || ''; } catch (_) { rpDate = ''; } }
        rpDate = safeText(rpDate, 80);
        const prevId = this.currentLocationId;
        // ★ 다른 장소로 이동하면 서브로케이션 클리어
        if (prevId !== locationId) this.currentSubLocationId = null;
        loc.visitCount = (loc.visitCount || 0) + 1;
        loc.lastVisited = Date.now();
        if (rpDate) loc.rpLastVisited = rpDate;
        if (!loc.firstVisited) loc.firstVisited = Date.now();
        if (!loc.rpFirstVisited && rpDate) loc.rpFirstVisited = rpDate;
        await this.db.putLocation(loc);
        if (prevId && prevId !== locationId) {
            const d = this.getDistanceBetween(prevId, locationId);
            const mov = this._sanitizeMovement({ chatId: this.currentChatId, fromId: prevId, toId: locationId, timestamp: Date.now(), rpDate: safeText(rpDate, 80), distance: d?.distanceText || null });
            await this.db.addMovement(mov); this.movements.push(mov);
        }
        this.currentLocationId = locationId;
        await this._saveCfg();
    }

    async removeMovement(movId) {
        await this.db.deleteMovement(movId);
        this.movements = this.movements.filter(m => m.id !== movId);
    }

    async setDistance(a, b, text, walk = null, level = 3, options = {}) {
        if (!this.currentChatId) return null;
        const id = [a, b].sort().join('_');
        const d = this._sanitizeDistance({ id, chatId: this.currentChatId, fromId: a, toId: b, distanceText: text, walkTime: walk, level, updatedAt: Date.now(), _manual: options.manual !== false, _source: options.manual === false ? 'auto' : 'manual' });
        await this.db.saveDistance(d);
        const i = this.distances.findIndex(x => x.id === id);
        if (i >= 0) this.distances[i] = d; else this.distances.push(d);
        return d;
    }

    getDistanceBetween(a, b) { return this.distances.find(d => d._manual === true && d.id === [a, b].sort().join('_')) || null; }

    async removeAutomaticDistances() {
        const automatic = this.distances.filter(distance => distance._manual !== true);
        for (const distance of automatic) await this.db.deleteDistance(distance.id);
        this.distances = this.distances.filter(distance => distance._manual === true);
        return automatic.length;
    }

    async _saveCfg() {
        if (!this.currentChatId) return;
        await this.db.saveMapConfig({
            chatId: this.currentChatId,
            currentLocationId: this.currentLocationId,
            currentSubLocationId: this.currentSubLocationId,
            ignoredDetectedNames: this.ignoredDetectedNames.slice(-300),
        });
    }

    _autoPos() {
        // 월드 좌표 중심 (고정 월드 3000×2400 기준)
        const WCX = 1500, WCY = 1200;
        const n = this.locations.length; if (n === 0) return { x: WCX, y: WCY };
        const a = n * 0.8, r = 80 + n * 25;
        return { x: Math.round(WCX + r * Math.cos(a)), y: Math.round(WCY + r * Math.sin(a)) };
    }

    _rndColor() {
        const c = ['#F5A8A8','#FCE7AE','#A8E6CF','#A8D8EA','#C3B1E1','#F5C6AA','#B5EAD7','#FFD3B6'];
        return c[Math.floor(Math.random() * c.length)];
    }

    // ========== 위치 기반 자동 확장 ==========

    // Haversine 공식 (두 좌표 간 직선 거리, 미터)
    _haversine(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    // 거리(m) → 레벨(1~10)
    _metersToLevel(m) {
        if (m < 50) return 1;      // 바로 옆
        if (m < 150) return 2;     // 매우 가까움
        if (m < 300) return 3;     // 가까움
        if (m < 500) return 4;     // 도보 5분
        if (m < 1000) return 5;    // 도보권
        if (m < 2000) return 6;    // 도보 15분+
        if (m < 5000) return 7;    // 대중교통
        if (m < 15000) return 8;   // 차량 필요
        if (m < 50000) return 9;   // 먼 거리
        return 10;                  // 다른 지역
    }

    // 거리(m) → 텍스트 (x1.4 도보 보정)
    _metersToText(m) {
        const walk = m * 1.4; // 직선→도보 보정
        if (m < 50) return '바로 옆';
        if (walk < 1200) return `도보 ${Math.round(walk / 80)}분`;
        if (m < 5000) return `${(m/1000).toFixed(1)}km`;
        return `${Math.round(m/1000)}km`;
    }

    // 좌표 있는 장소 → 주소 자동 저장 (역지오코딩)
    async autoReverseGeocode() {
        if (extension_settings?.[EXTENSION_NAME]?.allowAutoGeocoding !== true) return;
        const targets = this.locations.filter(l => l.lat != null && l.lng != null && !l.address && l._approximateCoordinates !== true);
        if (!targets.length) return;

        for (const loc of targets) {
            try {
                const result = await reverseGeocode(loc.lat, loc.lng);
                if (result?.fullName) await this.updateLocation(loc.id, { address: result.fullName });
            } catch (_) {}
        }
    }

    // 좌표 있는 장소 쌍 → 기존 자동 거리만 갱신. 새 all-pairs 간선은 만들지 않는다.
    async autoCalcDistances() {
        let updated = 0;
        for (const existing of this.distances.filter(distance => distance._manual !== true)) {
            const a = this.locations.find(location => location.id === existing.fromId && location.lat != null && location.lng != null && !location.parentId);
            const b = this.locations.find(location => location.id === existing.toId && location.lat != null && location.lng != null && !location.parentId);
            if (!a || !b) continue;
            const meters = this._haversine(a.lat, a.lng, b.lat, b.lng);
            existing.distanceText = this._metersToText(meters);
            existing.level = this._metersToLevel(meters);
            existing.updatedAt = Date.now();
            await this.db.saveDistance(existing);
            updated++;
        }
        return updated;
    }

    // ========== 터줏대감 (NPC/동물) 관리 — 풀 버전 ==========
    async addNpcToLocation(locId, npc) {
        const loc = this.locations.find(l => l.id === locId);
        if (!loc) return false;
        if (!loc.npcs) loc.npcs = [];
        // 중복 방지 (이름 기준, 대소문자 무시)
        const cleanNpc = this._sanitizeNpc(npc);
        const existing = loc.npcs.find(n => n.name.toLowerCase() === cleanNpc.name.toLowerCase());
        if (existing) {
            existing.count = (existing.count || 1) + 1;
            existing.lastSeen = Date.now();
            await this.db.putLocation(loc);
            return false; // 기존 NPC 카운트 업
        }
        loc.npcs.push({
            ...cleanNpc,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            count: 1,
        });
        await this.db.putLocation(loc);
        return true; // 새 NPC
    }

    async updateNpc(locId, npcName, updates) {
        const loc = this.locations.find(l => l.id === locId);
        if (!loc?.npcs) return false;
        const npc = loc.npcs.find(n => n.name.toLowerCase() === npcName.toLowerCase());
        if (!npc) return false;
        Object.assign(npc, updates);
        Object.assign(npc, this._sanitizeNpc(npc));
        await this.db.putLocation(loc);
        return true;
    }

    async updateNpcAffinity(locId, npcName, delta) {
        const loc = this.locations.find(l => l.id === locId);
        if (!loc?.npcs) return;
        const npc = loc.npcs.find(n => n.name.toLowerCase() === npcName.toLowerCase());
        if (!npc) return;
        npc.affinity = Math.max(1, Math.min(5, (npc.affinity || 3) + delta));
        npc.lastSeen = Date.now();
        await this.db.putLocation(loc);
    }

    async removeNpcFromLocation(locId, npcName) {
        const loc = this.locations.find(l => l.id === locId);
        if (!loc?.npcs) return;
        loc.npcs = loc.npcs.filter(n => n.name.toLowerCase() !== npcName.toLowerCase());
        await this.db.putLocation(loc);
    }

    // ========== 💬 커뮤니티 피드 (v0.6.0 NEW) ==========
    async addCommunityPost(locId, post) {
        const loc = this.locations.find(l => l.id === locId);
        if (!loc) return false;
        if (!loc.community) loc.community = [];
        loc.community.unshift(this._sanitizePost({
            id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: post.name,
            handle: post.handle || `@${post.name.toLowerCase().replace(/\s+/g, '_')}`,
            avatar: post.avatar || '👤',
            type: post.type || 'npc', // 'npc' | 'animal' | 'user'
            mood: post.mood || '',
            moodLabel: post.moodLabel || '',
            text: post.text,
            mentions: post.mentions || [],
            hashtags: post.hashtags || [],
            likes: post.likes || 0,
            replies: post.replies || [],
            retweetOf: post.retweetOf || null,
            timestamp: Date.now(),
            rpDate: post.rpDate || '',
        }));
        // 최대 30개 유지
        if (loc.community.length > 30) loc.community = loc.community.slice(0, 30);
        await this.db.putLocation(loc);
        return true;
    }

    async updateCommunityPost(locId, postId, updates) {
        const loc = this.locations.find(l => l.id === locId);
        if (!loc?.community) return false;
        const post = loc.community.find(p => p.id === postId);
        if (!post) return false;
        Object.assign(post, updates);
        Object.assign(post, this._sanitizePost(post));
        await this.db.putLocation(loc);
        return true;
    }

    async removeCommunityPost(locId, postId) {
        const loc = this.locations.find(l => l.id === locId);
        if (!loc?.community) return;
        loc.community = loc.community.filter(p => p.id !== postId);
        await this.db.putLocation(loc);
    }

    async clearCommunity(locId) {
        const loc = this.locations.find(l => l.id === locId);
        if (!loc) return;
        loc.community = [];
        await this.db.putLocation(loc);
    }
}
