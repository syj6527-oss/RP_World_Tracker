// PAW MAP v0.9.47 — quarantined place detection candidates.
// Candidates intentionally stay in memory. Chat excerpts are never persisted.

const HARD_REJECT = new Set([
    'look', 'see', 'you', 'authority', 'say thank you', 'scanned room',
    'i', 'me', 'my', 'mine', 'he', 'him', 'his', 'she', 'her', 'hers',
    'we', 'us', 'our', 'ours', 'they', 'them', 'their', 'theirs', 'it', 'its',
    'this', 'that', 'these', 'those', 'someone', 'somebody', 'everyone', 'nobody',
    'go', 'went', 'come', 'came', 'walk', 'run', 'say', 'tell', 'ask', 'reply',
    'place conventionally han', 'place, conventionally han',
    'location', 'current location', 'place', 'scene', 'setting', 'area', 'spot',
    '약속 장소', '예정 장소', '현재 장소', '장소', '위치', '씬', '배경',
    '여기', '거기', '저기', '이곳', '그곳', '저곳', '어딘가', '당신', '그녀', '우리', '누군가', '모두',
    '풍경', '감탄', '표정', '시선', '생각', '마음', '기분', '분위기', '목소리', '권한',
]);

const GENERIC_PLACE = new Set([
    'bar', 'club', 'diner', 'cafe', 'restaurant', 'office', 'room', 'home',
    'shop', 'store', 'park', 'hotel', 'hospital', 'school', 'station',
    '술집', '클럽', '식당', '카페', '사무실', '방', '집', '가게', '공원',
    '호텔', '병원', '학교', '역',
]);
const STANDALONE_SUBPLACE = new Set([
    'room', 'bedroom', 'bathroom', 'kitchen', 'living room', 'hall', 'lobby',
    '방', '침실', '화장실', '욕실', '부엌', '주방', '거실', '복도', '로비',
]);

const ACTION_HOME = /^(?:(?:crawl|crawled|crawling|go|going|went|walk|walked|walking|run|ran|running|return|returned|returning|head|headed|heading|come|came|coming|get|got|getting)\s+(?:back\s+)?(?:to\s+)?)home$/i;
const RELATIVE_SUFFIX = /\s*(?:바로\s*)?(앞|뒤|옆|근처|맞은편|입구|안|밖|앞쪽|뒤편)$/;

export function normalizeCandidateKey(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, ' ')
        .trim()
        .slice(0, 160);
}

export function sanitizeCandidateText(value, maxLength = 160) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[<>]/g, ' ')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function normalizeDetectedName(rawName) {
    let name = sanitizeCandidateText(rawName, 100)
        .replace(/^[`*_#'"“”‘’\[\](){}]+|[`*_#'"“”‘’\[\](){}]+$/g, '')
        .replace(/^(?:location|place|scene|장소|위치)\s*[:：]\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (ACTION_HOME.test(name)) name = 'Home';
    return name.slice(0, 80);
}

function looksLikeSentenceFragment(name) {
    if (/[,;:!?。！？]/.test(name)) return true;
    if (name.split(/\s+/).length > 6) return true;
    if (/[가-힣](?:했다|한다|해요|합니다|였다|이다|있다|없다|갔다|왔다|보였다|말했다|라고|다고|지만|는데|으며|면서)$/.test(name)) return true;
    if (/\b(?:is|are|was|were|have|has|had|said|says|look|see|thank)\b/i.test(name) && name.split(/\s+/).length >= 2) return true;
    return false;
}

export function assessPlaceCandidate(rawName, options = {}) {
    const name = normalizeDetectedName(rawName);
    const key = normalizeCandidateKey(name);
    const source = sanitizeCandidateText(options.source || 'unknown', 24).toLowerCase();
    const requestedKind = ['current', 'mentioned', 'planned', 'alias', 'relative', 'sub'].includes(options.kind)
        ? options.kind : 'current';

    if (!name) return { accepted: false, reason: '빈 이름' };
    if (name.length > 80 || key.length > 80) return { accepted: false, reason: '이름이 너무 김' };
    if (HARD_REJECT.has(key)) return { accepted: false, reason: '시스템 문구·대명사·행동 조각' };
    if (looksLikeSentenceFragment(name)) return { accepted: false, reason: '문장 조각으로 보임' };
    if (/^[\p{L}\p{N}]$/u.test(name) && !['집', '방', '역', '산', '강'].includes(name)) {
        return { accepted: false, reason: '한 글자 조각' };
    }
    if (!/[\p{L}\p{N}]/u.test(name)) return { accepted: false, reason: '장소 문자가 없음' };

    let confidence = Number(options.confidence);
    if (!Number.isFinite(confidence)) confidence = source === 'meta' ? 0.82 : source === 'user' ? 0.72 : 0.62;
    confidence = Math.max(0, Math.min(1, confidence));
    let kind = requestedKind;
    let reason = sanitizeCandidateText(options.reason, 140) || '이동 문맥에서 새 장소명 후보를 찾음';
    let existingId = '';
    let inferredParentId = '';

    const exact = requestedKind === 'sub' ? null : options.locationManager?.findByNameExact?.(name);
    if (exact) {
        existingId = exact.id;
        kind = exact.parentId ? 'sub' : requestedKind;
        inferredParentId = exact.parentId || '';
        confidence = Math.max(confidence, 0.94);
        reason = `기존 장소 “${sanitizeCandidateText(exact.name, 80)}”와 정확히 일치`;
    } else {
        const relative = name.match(RELATIVE_SUFFIX);
        if (relative) {
            const baseName = name.slice(0, relative.index).trim();
            const base = options.locationManager?.findByNameExact?.(baseName);
            if (base) {
                existingId = base.id;
                kind = 'relative';
                confidence = Math.min(confidence, 0.78);
                reason = `“${relative[1]}”은 상대 위치 표현 — 기존 “${sanitizeCandidateText(base.name, 80)}”에 연결 권장`;
            }
        }
    }

    if (GENERIC_PLACE.has(key)) {
        confidence = Math.min(confidence, 0.64);
        if (kind !== 'sub') reason = '일반 시설명이라 같은 이름의 다른 장소일 수 있음';
    }

    return { accepted: true, name, key, kind, confidence, reason, existingId, parentId: inferredParentId };
}

export function suspiciousLocationReason(location = {}) {
    const rawName = sanitizeCandidateText(location.name, 100);
    const name = normalizeDetectedName(location.name);
    const key = normalizeCandidateKey(name);
    if (!name) return '빈 이름';
    if (ACTION_HOME.test(rawName) && normalizeCandidateKey(rawName) !== 'home') return '이동 문구 — 기존 Home 연결 검토';
    if (HARD_REJECT.has(key)) return '시스템 문구·대명사·행동 조각';
    if (looksLikeSentenceFragment(name)) return '문장 조각';
    if (/^[\p{L}\p{N}]$/u.test(name) && !['집', '방', '역', '산', '강'].includes(name)) return '한 글자 조각';
    if (RELATIVE_SUFFIX.test(name)) return '상대 위치 표현 — 기존 장소 연결 검토';
    if (!location.parentId && STANDALONE_SUBPLACE.has(key)) return '상위 장소 없이 등록된 내부 장소';
    if (location.verification === 'legacy-auto' || location.source === 'auto') return '이전 자동 감지로 등록';
    return '';
}

export class DetectionCandidateManager {
    constructor(locationManager) {
        this.lm = locationManager;
        this._items = [];
        this._seq = 0;
        this.onChange = null;
    }

    _emit() {
        try { this.onChange?.(this.list()); } catch (_) {}
    }

    list() {
        return this._items.map(item => ({ ...item }));
    }

    count() { return this._items.length; }

    clear() {
        this._items = [];
        this._emit();
    }

    add(rawName, options = {}) {
        const assessment = assessPlaceCandidate(rawName, { ...options, locationManager: this.lm });
        if (!assessment.accepted) return { queued: false, rejected: true, reason: assessment.reason };
        if (this.lm?.isDetectionIgnored?.(assessment.name)) {
            return { queued: false, ignored: true, reason: '사용자가 계속 무시하도록 설정' };
        }

        const chatKey = String(this.lm?.currentChatId || '');
        const requestedParentId = String(assessment.parentId || options.parentId || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 160);
        const validParent = assessment.kind === 'sub'
            ? this.lm?.locations?.find(location => location.id === requestedParentId && !location.parentId &&
                normalizeCandidateKey(location.name) !== assessment.key &&
                !(location.aliases || []).some(alias => normalizeCandidateKey(alias) === assessment.key))
            : null;
        const parentId = validParent?.id || '';
        const baseDedupeKey = `${chatKey}|${assessment.key}|${assessment.kind}`;
        const dedupeKey = assessment.kind === 'sub' && parentId ? `${baseDedupeKey}|${parentId}` : baseDedupeKey;
        let existing = this._items.find(item => item.dedupeKey === dedupeKey);
        let parentContextUpdated = false;
        // A parentless Room held for review may become actionable when a real
        // current parent appears. Upgrade that same card instead of losing it or
        // creating a second copy. Different real parents keep separate cards.
        if (!existing && assessment.kind === 'sub' && parentId) {
            existing = this._items.find(item => item.dedupeKey === baseDedupeKey && !item.parentId);
            if (existing) {
                existing.parentId = parentId;
                existing.dedupeKey = dedupeKey;
                existing.reason = assessment.reason;
                existing.source = sanitizeCandidateText(options.source || existing.source || 'unknown', 24);
                parentContextUpdated = true;
            }
        }
        if (existing) {
            existing.seenCount = Math.min(999, (existing.seenCount || 1) + 1);
            existing.confidence = Math.max(existing.confidence, assessment.confidence);
            existing.lastSeenAt = Date.now();
            if (!existing.snippet && options.snippet) existing.snippet = sanitizeCandidateText(options.snippet, 180);
            this._emit();
            return { queued: true, duplicate: true, parentContextUpdated, candidate: { ...existing } };
        }

        const candidate = {
            id: `cand_${Date.now()}_${++this._seq}`,
            dedupeKey,
            chatKey,
            name: assessment.name,
            key: assessment.key,
            source: sanitizeCandidateText(options.source || 'unknown', 24),
            kind: assessment.kind,
            confidence: assessment.confidence,
            reason: assessment.reason,
            existingId: assessment.existingId || '',
            parentId,
            rpDate: sanitizeCandidateText(options.rpDate, 80),
            // Ephemeral evidence only. It is never written to IndexedDB or backup JSON.
            snippet: sanitizeCandidateText(options.snippet, 180),
            seenCount: 1,
            createdAt: Date.now(),
            lastSeenAt: Date.now(),
        };
        this._items.push(candidate);
        if (this._items.length > 30) this._items.splice(0, this._items.length - 30);
        this._emit();
        return { queued: true, candidate: { ...candidate } };
    }

    dismiss(id) {
        const before = this._items.length;
        this._items = this._items.filter(item => item.id !== id);
        if (before !== this._items.length) this._emit();
    }

    async ignore(id) {
        const item = this._items.find(candidate => candidate.id === id);
        if (!item) return false;
        await this.lm?.ignoreDetectedName?.(item.name);
        this.dismiss(id);
        return true;
    }
}
