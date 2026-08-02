// 🐶 PAW MAP v0.9.50-secure-beta

import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { WorldTrackerDB, redactSecretFields } from './db.js';
import { LocationManager } from './location-manager.js';
import { LocationDetector } from './detector.js';
import { PromptInjector } from './prompt-injector.js';
import { UIManager } from './ui-manager.js';
import { callLLM, parseLLMJson, getRecentChatContext } from './llm-helper.js';
import { searchPlaces } from './geo-service.js';
import { DetectionCandidateManager, suspiciousLocationReason } from './detection-candidates.js';
import { stripNonNarrativeMetadata } from './rp-text-filter.js';
import {
    commitDetectedSubLocation,
    findContextualExactLocation,
    moveToDetectedLocation,
    resolveTopLevelParent,
} from './place-hierarchy.js';

export const EXTENSION_NAME = 'rp-world-tracker';
export const PROMPT_KEY = 'rp-world-tracker-prompt';
let _autoDetectPauseCount = 0;

export async function runWithoutAutoDetect(task, cooldownMs = 1500) {
    _autoDetectPauseCount++;
    try {
        return await task();
    } finally {
        setTimeout(() => {
            _autoDetectPauseCount = Math.max(0, _autoDetectPauseCount - 1);
        }, cooldownMs);
    }
}

function isAutoDetectPaused() {
    return _autoDetectPauseCount > 0;
}
if (typeof window !== 'undefined') window._wtIsPaused = isAutoDetectPaused;

// ========== v0.9.2: ST 데이터 호출 충돌 방어 ==========
//   1) ST가 응답 생성 중일 때(_stBusy) 확장의 자동 LLM 호출/쓰기를 피해서 호출 경쟁 방지
//   2) 비동기 작업(LLM 요약/지오코딩/DB쓰기) 도중 채팅이 바뀌면 결과를 폐기 → 엉뚱한 채팅 오염 방지
let _stBusy = false;
let _stBusySince = 0;
function _setStBusy(v) { _stBusy = !!v; if (v) _stBusySince = Date.now(); }
// 생성이 비정상 종료돼 플래그가 안 풀리는 경우 대비 — 45초 지나면 자동 해제
export function isStBusy() {
    if (_stBusy && Date.now() - _stBusySince > 45000) _stBusy = false;
    return _stBusy;
}
// 작업 시작 시점의 chatId를 스냅샷 → 작업 후 still() 호출로 같은 채팅인지 확인 (true=안전)
export function makeChatGuard() {
    let snap = null;
    try { snap = lm?.currentChatId ?? lm?.getChatId?.() ?? null; } catch(_) {}
    return () => {
        let now = null;
        try { now = lm?.currentChatId ?? lm?.getChatId?.() ?? null; } catch(_) {}
        return snap != null && snap === now;
    };
}

// ========== 확장 경로 자동 감지 (폴더명 불일치 방지) ==========
export const EXTENSION_PATH = new URL('.', import.meta.url).pathname;

// ========== 🐶/🐺 모드 아이콘 ==========
export function wtMascot() { return extension_settings[EXTENSION_NAME]?.fantasyTheme ? '🐺' : '🐶'; }
export function wtTreat() { return extension_settings[EXTENSION_NAME]?.fantasyTheme ? '🍖' : '🦴'; }

// ========== 커스텀 알림 (번역기 스타일) ==========
let _notiEl = null, _notiTimer = null, _notiQueue = [];
export function wtNotify(msg, type = 'move', duration = 3000) {
    if (!_notiEl) {
        _notiEl = document.createElement('div');
        _notiEl.className = 'wt-notification';
        document.body.appendChild(_notiEl);
    }
    // ★ 현재 표시 중이면 큐에 넣기
    if (_notiEl.style.display === 'block' && _notiEl.style.top === '12px') {
        _notiQueue.push({ msg, type, duration });
        if (_notiQueue.length > 3) _notiQueue.shift(); // 최대 3개 대기
        return;
    }
    _showNoti(msg, type, duration);
}
function _showNoti(msg, type, duration) {
    clearTimeout(_notiTimer);
    _notiEl.className = `wt-notification wt-noti-${type}`;
    _notiEl.textContent = msg;
    _notiEl.style.display = 'block';
    _notiEl.style.top = '12px';
    _notiTimer = setTimeout(() => {
        _notiEl.style.top = '-100px';
        // ★ transition 끝난 후 완전 숨김 + 큐 처리
        setTimeout(() => {
            _notiEl.style.display = 'none';
            if (_notiQueue.length > 0) {
                const next = _notiQueue.shift();
                _showNoti(next.msg, next.type, next.duration);
            }
        }, 450);
    }, duration);
}
export function toastWarn(msg) { wtNotify(msg, 'warn', 3000); }
export function toastSuccess(msg) { wtNotify(msg, 'move', 2000); }

function plainText(value, maxLength = 1000) {
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

function firstGrapheme(value, fallback = '👤') {
    const text = plainText(value, 12);
    if (!text) return fallback;
    try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)][0]?.segment || fallback; }
    catch (_) { return Array.from(text)[0] || fallback; }
}

const defaults = {
    // v0.9.51: Yun 확정 정책
    //   - 자동 감지 기본 OFF (후보함 시스템은 유지 — 켜면 후보함으로 격리됨)
    //   - aiInjection 기본 ON (장소 컨텍스트 주입 = 확장의 핵심 기능)
    //   - dragEvent 기본 ON (유일하게 유지하는 자동 입력 수단)
    //   - llmMode: 'profile'(기본, ST 연결 프로필) | 'direct'(API 키 직접 입력)
    enabled:true, autoDetect:false, detectMode:'off', autoEvent:false, autoSchedule:false, showDetectToast:true,
    aiInjection:true, memoryMode:'natural', memorySummaryDays:7, panelOpacity:100,
    debugMode:false, mapMode:'leaflet', fantasyTheme:false,
    eventLang:'auto', // auto=RP언어, ko=한국어, en=English
    worldContinuity:false, // 세계관 이어가기 (캐릭터 기반 저장)
    dragEvent:true, // 드래그 → 이벤트 저장 (기본 ON)
    // v0.9.46 security defaults: every potentially billable/private external action is opt-in.
    externalAiEnabled:false,
    shareRpData:false,
    allowAutoGeocoding:false,
    showGoogleLinks:false, // 구글 지도 바로가기 버튼 (설정 옵션) — Street View는 이 옵션과 무관하게 항상 표시
    mapSearchLanguage:'ko',
    openMapStyle:'liberty',
    llmMode:'profile', // v0.9.51: 'profile' | 'direct'
    llmProvider:'google', llmModel:'gemini-2.5-flash', llmApiKey:'', vertexSaJson:'', vertexRegion:'',
    locationEnrichment:'off', // off | overpass | grounding(direct+google 전용)
};

let db, lm, det, pi, ui, detectionCandidates;
let _userContext = ''; // 유저 입력 컨텍스트 (이벤트 추출용)

// ========== 채팅 화면 활성 여부 (캐릭터 설정/선택 화면 방지) ==========
function isChatActive() {
    // offsetParent는 position:fixed에서 null 반환 → getBoundingClientRect 사용
    const sendBtn = document.querySelector('#send_but');
    if (!sendBtn) return false;
    const rect = sendBtn.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

export async function loadLeaflet() {
    if (window.maplibregl?.Map) return true;
    try {
        if (!document.querySelector('link[data-wt-maplibre]')) {
            const link = document.createElement('link'); link.rel = 'stylesheet';
            link.dataset.wtMaplibre = '1';
            link.href = new URL('./vendor/maplibre/maplibre-gl.css', import.meta.url).href;
            document.head.appendChild(link);
        }
        const moduleUrl = new URL('./vendor/maplibre/maplibre-gl.mjs', import.meta.url).href;
        const module = await import(moduleUrl);
        if (!module?.Map) return false;
        window.maplibregl = module;
        return true;
    } catch (_) { return false; }
}

function dbg(msg) {
    const s = extension_settings[EXTENSION_NAME];
    if (s?.debugMode) wtNotify(`🔧 ${msg}`, 'info', 3000);
}

let _autoPlaceCommitChain = Promise.resolve();
const _autoPlaceCommitPending = new Set();
const isStandaloneInternalLabel = name =>
    suspiciousLocationReason({ name, parentId: '' }) === '상위 장소 없이 등록된 내부 장소';

async function commitDetectedPlace(candidate) {
    if (!candidate || !lm?.currentChatId) return null;
    if (candidate.chatKey && candidate.chatKey !== lm.currentChatId) return null;
    const source = ['character', 'schedule'].includes(candidate.source) ? candidate.source : 'detected';

    // Final guard: a bare indoor label must never become a world-map place.
    // When a real current parent exists, preserve automatic sub-place creation.
    if (isStandaloneInternalLabel(candidate.name) || candidate.kind === 'sub') {
        const parent = resolveTopLevelParent(lm, candidate.name, candidate.parentId, LocationManager.PLACE_DICT);
        if (!parent) return null;
        candidate = { ...candidate, kind: 'sub', parentId: parent.id };
    }

    if (candidate.kind === 'sub') {
        return commitDetectedSubLocation(lm, candidate.parentId, candidate.name, candidate.rpDate, LocationManager.PLACE_DICT);
    }

    let location = candidate.existingId
        ? lm.locations.find(item => item.id === candidate.existingId)
        : lm.findByNameExact(candidate.name);
    let created = false;
    if (!location) {
        location = await lm.addLocation(candidate.name, '', [], { source });
        created = Boolean(location);
    }
    if (!location) return null;

    if (candidate.kind === 'planned') {
        await lm.updateLocation(location.id, {
            tags: [...new Set([...(location.tags || []), 'wantToGo'])],
            _tempAddress: location._approximateCoordinates === true || !location.address,
        });
    } else if (candidate.kind === 'current' || candidate.kind === 'relative') {
        await lm.moveTo(location.id, candidate.rpDate);
    }

    // 사용자가 따로 켠 경우에만 감지 장소명을 Photon에 보내 추정 핀을 실제 좌표로 교체한다.
    if (created && extension_settings[EXTENSION_NAME]?.allowAutoGeocoding === true && !location.parentId && !lm.isSubLocation(location.name)) {
        const current = lm.locations.find(item => item.id === lm.currentLocationId && item.lat != null && item.lng != null && !item.parentId);
        const geocoded = await _geocodeQuiet(location.name, false, current ? { lat: current.lat, lng: current.lng } : null);
        if (geocoded) {
            location = await lm.updateLocation(location.id, {
                lat: geocoded.lat, lng: geocoded.lng, address: geocoded.addr,
                _approximateCoordinates: false, _approximateAnchorId: null,
                _tempAddress: false, _geoFixed: true, _geocodeSuppressed: false,
            });
        }
    }

    pi?.inject();
    if (ui?.panelVisible) ui.refresh();
    if (extension_settings[EXTENSION_NAME]?.showDetectToast) {
        wtNotify(`${wtMascot()} 📍 ${location.name}${location._approximateCoordinates ? ' · 추정 핀' : ''}`, 'move', 2600);
    }
    return location;
}

function queueDetectedPlace(name, options = {}) {
    if (!detectionCandidates) return { queued: false };
    const prepared = { ...options };
    // Normalize every internal-place source before it reaches the queue. This
    // includes detector, metadata, promise and legacy callers.
    if (prepared.kind === 'sub' || isStandaloneInternalLabel(name)) {
        const parent = resolveTopLevelParent(lm, name, prepared.parentId, LocationManager.PLACE_DICT);
        prepared.kind = 'sub';
        prepared.parentId = parent?.id || '';
        if (!parent) {
            prepared.autoCommit = false;
            prepared.confidence = Math.min(0.5, Number(prepared.confidence) || 0.5);
            prepared.reason = '내부 장소이지만 연결할 상위 장소가 아직 없음';
        }
    }
    const result = detectionCandidates.add(name, prepared);
    const mode = extension_settings[EXTENSION_NAME]?.detectMode || (extension_settings[EXTENSION_NAME]?.autoDetect ? 'auto' : 'off');
    const candidate = result.candidate;
    const shouldTryAutoCommit = result.queued && candidate && mode === 'auto' && prepared.autoCommit !== false &&
        (!result.duplicate || result.parentContextUpdated === true) && !_autoPlaceCommitPending.has(candidate.id);
    if (shouldTryAutoCommit) {
        _autoPlaceCommitPending.add(candidate.id);
        _autoPlaceCommitChain = _autoPlaceCommitChain
            .then(async () => {
                if (!detectionCandidates.list().some(item => item.id === candidate.id)) return null;
                const committed = await commitDetectedPlace(candidate);
                if (committed) detectionCandidates.dismiss(candidate.id);
                return committed;
            })
            .catch(() => null)
            .finally(() => _autoPlaceCommitPending.delete(candidate.id));
        return { ...result, autoCommitted: true, commitPromise: _autoPlaceCommitChain };
    }
    if (result.queued && !result.duplicate && extension_settings[EXTENSION_NAME]?.showDetectToast) {
        wtNotify(`🪧 장소 후보: ${result.candidate.name}`, 'info', 2600);
    }
    if (result.rejected) dbg(`🚫 장소 후보 격리 필터: ${result.reason}`);
    return result;
}

// ========== 메시지 스캔 (USER/AI 감도 분리) ==========
// v0.9.41: detectMode 도입으로 자동 감지 재활성화 — 실제 로직(_legacyScanMessage) 연결.
//   detectMode='off'이면 _legacyScanMessage 내부에서 즉시 return한다.
async function scanMessage(text, source = 'USER') {
    return await _legacyScanMessage(text, source);
}

// v0.9.0 비활성: 이전 자동 감지 로직 (참고용으로 유지, 호출되지 않음)
async function _legacyScanMessage(text, source = 'USER') {
    try {
        // ★ 리뷰 생성 중이면 감지 차단 (피드백 루프 방지)
        if (ui?._isGeneratingReview) {
            dbg('🔄 리뷰 생성 중 — 감지 건너뜀');
            return false;
        }
        if (isAutoDetectPaused()) {
            dbg('⏸️ auto-detect paused');
            return false;
        }
        const s = extension_settings[EXTENSION_NAME];
        // v0.9.23: detectMode 우선, 없으면 레거시 autoDetect로 환산
        const _dm = s?.detectMode || (s?.autoDetect ? 'auto' : 'off');
        if (!s?.enabled || _dm === 'off' || !text?.trim()) return false;
        window._wtDetectMode = _dm; // 새 장소 등록 분기에서 사용
        if (!lm.currentChatId) await lm.loadChat();
        if (!lm.currentChatId) return false;

        const mode = source === 'AI' ? 'ai' : 'user';
        const rpDate = _extractRpDate(text);

        // ★ 약속 장소 감지 — 메타 Location 처리와 독립적으로 항상 실행
        if (lm.currentLocationId) {
            try {
                const promisePlace = det.detectPromisePlace(text);
                if (promisePlace && !lm.findByNameExact(promisePlace)) {
                    queueDetectedPlace(promisePlace, {
                        source: 'promise', kind: 'planned', confidence: 0.56,
                        reason: '미래 약속 문맥에서 찾음 — 약속 문구 자체일 수 있어 확인 필요',
                        snippet: text, rpDate,
                    });
                }
            } catch(e) { dbg('⚠️ Promise detect error:', e.message); }
        }

        // ★ 메타데이터에서 Location 직접 추출 (memo/yaml 블록)
        // HTML 태그 제거 후 다양한 포맷 매칭
        const cleanForMeta = text.replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ');
        const locPatterns = [
            /[-*•]\s*Location\s*[:：]\s*([^\r\n]{1,120})/i,
            /Location\s*[:：]\s*([^\r\n]{1,120})/i,
            /📍\s*Location\s*[:：]\s*([^\r\n]{1,120})/i,
            /[-*•]\s*장소\s*[:：]\s*([^\r\n]{1,120})/,
            /[-*•]\s*위치\s*[:：]\s*([^\r\n]{1,120})/,
            /[-*•]\s*Place\s*[:：]\s*([^\r\n]{1,120})/i,
            /[-*•]\s*Scene\s*[:：]\s*([^\r\n]{1,120})/i,
            /[-*•]\s*Current\s+Location\s*[:：]\s*([^\r\n]{1,120})/i,
        ];
        let locMatch = null;
        for (const pat of locPatterns) {
            const m = cleanForMeta.match(pat);
            if (m) { locMatch = m; break; }
        }
        // 원본 텍스트에서도 시도 (HTML 태그 안에 있을 수 있음)
        if (!locMatch) {
            const m2 = text.match(/[-*•]\s*Location\s*[:：]\s*([^\r\n]{1,120})/i);
            if (m2) locMatch = m2;
        }
        if (locMatch) {
            let metaLoc = locMatch[1].trim()
                .replace(/[`*_]/g, '')           // 마크다운 제거
                .replace(/<[^>]*>/g, '')          // 잔여 HTML 제거
                .replace(/\s+/g, ' ')             // 공백 정리
                .replace(/[\r\n]+/g, '')          // 줄바꿈 제거
                .split(/[-–—]\s*(?:Time|Date|Characters|Outfit|Items|Condition|시간|캐릭터|복장)/i)[0]  // 다음 필드 시작 전까지만
                .trim();
            if (metaLoc.length >= 2 && metaLoc.length <= 80) {
                // ★ 영어만 2글자 이하 → 스킵 (th, am, pm 등 오탐 방지)
                if (/^[a-zA-Z\s]+$/.test(metaLoc) && metaLoc.trim().length <= 2) {
                    dbg(`⏭️ Meta location too short (EN): "${metaLoc}"`);
                    return false;
                }
                dbg(`📌 Meta location raw: "${metaLoc}"`);

                // ★ 한국어 문장 필터: 용언 어미가 포함된 건 장소가 아니라 문장
                if (/[가-힣]/.test(metaLoc) && /(?:했[다어]|됐[다어]|났[다어]|있[다어]|없[다어]|갔[다어]|왔[다어]|봤[다어]|먹[었]|잤[다어]|[가-힣]네요?|[가-힣]구나|[가-힣]잖아|[가-힣]더라|[가-힣]거든|습니다|ㅂ니다|세요|에요|해요|하고|하며|하면|인데|지만|에서|으로|부터|까지|처럼|만큼|라고|다고)/.test(metaLoc)) {
                    dbg(`🚫 Meta loc is Korean sentence: "${metaLoc}" → skip`);
                    if (lm.currentLocationId) { await _tryEvent(text, lm.currentLocationId, source); return true; }
                    return false;
                }
                // ★ v0.6.0: 영어 단일 단어 오탐 필터 (facility/scattered/blood 등)
                const metaLow = metaLoc.toLowerCase().trim();
                const singleWordBlacklist = new Set([
                    'facility','facilities','scattered','blood','bloody','flesh','torn','broken','damaged','destroyed','ruined','burning','burnt','frozen','shattered','wounded','injured','dead','dying','silent','empty','crowded','abandoned','deserted','forgotten','hidden','secret','mysterious','unknown','familiar','strange','weird','normal','usual','regular','sudden','random','various','several','countless','numerous','endless','infinite','massive','huge','tiny','small','big','giant','enormous','distant','nearby','inside','outside','above','below','beyond','within','across','through','around','beside','behind','ahead',
                    'attack','defense','retreat','advance','fight','battle','war','peace','escape','rescue','mission','operation','briefing','debrief','training','exercise','practice','drill','patrol','watch','guard','duty','shift',
                    'anger','rage','fury','fear','terror','panic','shock','horror','pain','agony','sorrow','grief','joy','happiness','love','hate','calm','peace','chaos','silence','noise','darkness','brightness','warmth','coldness',
                    'somewhere','anywhere','nowhere','everywhere','place','area','zone','spot','location','position','scene','setting',
                ]);
                if (/^[a-zA-Z\s]+$/.test(metaLow) && singleWordBlacklist.has(metaLow)) {
                    dbg(`🚫 Meta loc is common English word (blacklist): "${metaLoc}" → skip`);
                    if (lm.currentLocationId) { await _tryEvent(text, lm.currentLocationId, source); return true; }
                    return false;
                }

                // ★ 영어 욕설/감탄사 접두 제거 — "Damn barracks" → "barracks"
                metaLoc = metaLoc.replace(/^(?:damn|fucking|fuckin|freaking|goddamn|bloody|stupid|shit|holy)\s+/i, '').trim();
                // ★ 이동 중/차량/탈것 내부 → 장소 등록 건너뛰기
                const transitSkip = /이동\s*중|향으로\s*이동|밴\s*내부|차량\s*내부|차\s*안|버스\s*안|택시\s*안|SUV|뒷좌석|앞좌석|조수석|운전석|트렁크|차\s*안|차\s*속|차\s*밖|차량|자동차|승합차|지프|트럭|밴|탱크|헬기|헬리콥터|비행기|기차|열차|지하철|전철|보트|배\s*위|선박|en\s*route|in\s*transit|on\s+the\s+way|driving|riding|heading\s+to|moving\s+to|backseat|front\s*seat|passenger|driver.*seat|trunk|SUV|van|truck|jeep|car\s+interior|vehicle|helicopter|chopper|aircraft|humvee|convoy/i;
                if (transitSkip.test(metaLoc)) {
                    dbg(`🚗 Transit location skipped: "${metaLoc}"`);
                    await _tryEvent(text, lm.currentLocationId, source);
                    return true;
                }

                // ★★★ 핵심 방어: 30자 초과 서술형 Location → 현재 장소 유지 (별칭 등록 안 함!)
                if (metaLoc.length > 30 && lm.currentLocationId) {
                    dbg(`🔀 Long meta loc (${metaLoc.length}c) "${metaLoc}" → staying at current (no alias)`);
                    await _tryEvent(text, lm.currentLocationId, source);
                    return true;
                }

                // ★ 콤마 구분자 정리: "영국 헤리퍼드, NCO Barracks 1층" → 마지막 파트만 사용
                if (metaLoc.includes(',')) {
                    const parts = metaLoc.split(',').map(p => p.trim()).filter(p => p.length >= 2);
                    if (parts.length >= 2) {
                        // 마지막 파트가 장소명일 가능성 높음
                        const lastPart = parts[parts.length - 1];
                        dbg(`📌 Comma split: "${metaLoc}" → last part: "${lastPart}"`);
                        metaLoc = lastPart;
                    }
                }

                // ★★★ 별칭 키워드 매칭 (서브 분리 전에 먼저!) — 현재 부모의
                // 동일 이름 child를 우선하며, 다른 부모의 Room은 빌려오지 않는다.
                const aliasHit = findContextualExactLocation(lm, metaLoc);
                if (aliasHit) {
                    // 구버전이 최상위에 만든 bare Room은 보존하되 다시 현재 위치로
                    // 사용하지 않는다. 유효한 현재 부모가 있으면 그 아래 child로 생성한다.
                    if (!aliasHit.parentId && isStandaloneInternalLabel(aliasHit.name)) {
                        const parent = resolveTopLevelParent(lm, aliasHit.name, '', LocationManager.PLACE_DICT);
                        queueDetectedPlace(aliasHit.name, {
                            source: 'meta', kind: 'sub', parentId: parent?.id || '', confidence: 0.64,
                            reason: parent ? `“${parent.name}” 내부 장소로 다시 연결` : '상위 장소 없이 등록된 내부 장소 — 부모 선택 필요',
                            snippet: text, rpDate, autoCommit: false,
                        });
                        if (_dm === 'auto' && parent?.id) await _tryEvent(text, parent.id, source);
                        return true;
                    }
                    if (_dm !== 'auto') {
                        queueDetectedPlace(aliasHit.name, {
                            source: 'meta', kind: aliasHit.parentId ? 'sub' : 'current', parentId: aliasHit.parentId || '', confidence: 0.94,
                            reason: '상태창 이름이 기존 장소/별칭과 정확히 일치', snippet: text, rpDate,
                        });
                    } else {
                        await moveToDetectedLocation(lm, aliasHit, rpDate);
                        if (s.showDetectToast) wtNotify(`${wtMascot()} ${wtTreat()} ${aliasHit.name}`, 'move');
                        pi.inject(); if (ui.panelVisible) ui.refresh();
                    }
                    dbg(`🔗 Alias keyword hit: "${metaLoc}" → "${aliasHit.name}"`);
                    if (_dm === 'auto') await _tryEvent(text, aliasHit.id, source);
                    return true;
                }

                // ★ "Parent - Sub" 또는 "Parent — Sub" 형태 분리
                let metaParent = null, metaSub = null;
                const origMetaLoc = metaLoc; // ★ 원본 보존 (서브 분리 실패 시 복원용)
                const subKw = /kitchen|living\s*room|bed\s*room|bath\s*room|room|거실|부엌|주방|침실|화장실|방|마당|차고|서재|발코니|테라스|현관|복도|다락|지하|옥상|lobby|hall|office|studio|garage|balcony|terrace|rooftop|basement|armory|무기고|식당|mess\s*hall/i;

                // 방법1: 대시 구분자
                const sepMatch = metaLoc.match(/^(.+?)\s*[-–—]\s*([\uAC00-\uD7A3A-Za-z].+)$/);
                if (sepMatch) {
                    const part1 = sepMatch[1].trim();
                    const part2 = sepMatch[2].trim();
                    if (subKw.test(part2)) {
                        metaParent = part1;
                        metaSub = part2;
                        dbg(`📌 Dash split: parent="${metaParent}", sub="${metaSub}"`);
                    }
                }

                // 방법2: 공백 기반 — "NCO Barracks Kitchen" → parent="NCO Barracks", sub="Kitchen"
                if (!metaParent && !metaSub) {
                    const subMatch = metaLoc.match(new RegExp('(.+?)\\s+(' + subKw.source + '(?:\\s+\\S+)?)$', 'i'));
                    if (subMatch) {
                        const candidateParent = subMatch[1].trim();
                        const candidateSub = subMatch[2].trim();
                        // 부모 후보가 기존 장소와 매칭되는지 확인
                        const parentCheck = lm.locations.find(l => {
                            if (l.parentId) return false;
                            const n = l.name.toLowerCase();
                            const cp = candidateParent.toLowerCase();
                            return n === cp || n.includes(cp) || cp.includes(n) ||
                                (l.aliases || []).some(a => a.toLowerCase().includes(cp) || cp.includes(a.toLowerCase()));
                        });
                        if (parentCheck) {
                            metaParent = candidateParent;
                            metaSub = candidateSub;
                            dbg(`📌 Space split: parent="${metaParent}", sub="${metaSub}"`);
                        }
                    }
                }

                // 방법3: 숫자층 분리 — "Base 1층 주방" → parent="Base", sub="1층 주방"
                if (!metaParent && !metaSub) {
                    const floorMatch = metaLoc.match(/^(.+?)\s+(\d+층.*)$/);
                    if (floorMatch) {
                        const candidateParent = floorMatch[1].trim();
                        const parentCheck = lm.locations.find(l => {
                            if (l.parentId) return false;
                            const n = l.name.toLowerCase();
                            const cp = candidateParent.toLowerCase();
                            return n === cp || n.includes(cp) || cp.includes(n) ||
                                (l.aliases || []).some(a => a.toLowerCase().includes(cp) || cp.includes(a.toLowerCase()));
                        });
                        if (parentCheck) {
                            metaParent = candidateParent;
                            metaSub = floorMatch[2].trim();
                            dbg(`📌 Floor split: parent="${metaParent}", sub="${metaSub}"`);
                        }
                    }
                }

                // 분리된 경우: 부모 장소 매칭 → 서브 등록
                if (metaParent && metaSub) {
                    const parentLoc = lm.locations.find(l => !l.parentId && (
                        l.name.toLowerCase() === metaParent.toLowerCase() ||
                        metaParent.toLowerCase().includes(l.name.toLowerCase()) ||
                        l.name.toLowerCase().includes(metaParent.toLowerCase()) ||
                        (l.aliases || []).some(a => metaParent.toLowerCase().includes(a.toLowerCase()))
                    ));
                    if (parentLoc) {
                        // 서브장소 "&"로 나뉜 경우 첫번째만 사용 ("Kitchen & Living Room" → "Kitchen")
                        const subName = metaSub.split(/\s*[&,+]\s*/)[0].trim();
                        const existingSub = lm.getSubLocations(parentLoc.id).find(sub =>
                            sub.name.toLowerCase() === subName.toLowerCase() ||
                            (sub.aliases || []).some(alias => alias.toLowerCase() === subName.toLowerCase())
                        );
                        if (existingSub) {
                            if (_dm === 'auto') {
                                if (lm.currentLocationId !== parentLoc.id) await lm.moveTo(parentLoc.id, rpDate);
                                await lm.moveToSub(existingSub.id);
                                pi.inject(); if (ui.panelVisible) ui.refresh();
                                await _tryEvent(text, existingSub.id, source);
                            } else {
                                queueDetectedPlace(existingSub.name, {
                                    source: 'meta', kind: 'sub', confidence: 0.92,
                                    reason: `기존 “${parentLoc.name}” 내부 장소와 정확히 일치`, parentId: parentLoc.id,
                                    snippet: text, rpDate,
                                });
                            }
                        } else {
                            queueDetectedPlace(subName, {
                                source: 'meta', kind: 'sub', confidence: 0.78,
                                reason: `“${parentLoc.name}” 내부 장소 후보`, parentId: parentLoc.id,
                                snippet: text, rpDate,
                            });
                        }
                        return true;
                    }
                    // 부모 못 찾으면 원본 복원 (무기고 등 핵심 키워드 유지!)
                    metaLoc = origMetaLoc;
                }

                dbg(`📌 Meta location: "${metaLoc}"`);

                // ★ 괄호 내용 제거 후 정리 ("집 (22nd's old NCO Barracks) 주방" → "집 주방")
                const metaClean = metaLoc.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

                // ★ 서브로케이션 체크 (거실, 부엌 등 → 현재 장소의 하위)
                // 부모 장소가 아직 없으면 독립 장소로 만들거나 전 세계 지오코딩을
                // 하지 않고, 부모를 고를 수 있는 메모리 후보로만 보류한다.
                const currentParent = resolveTopLevelParent(lm, metaClean, '', LocationManager.PLACE_DICT);
                if (lm.isSubLocation(metaClean) && !currentParent) {
                    queueDetectedPlace(metaClean, {
                        source: 'meta', kind: 'sub', confidence: 0.5,
                        reason: '내부 장소이지만 연결할 상위 장소가 아직 없음',
                        snippet: text, rpDate, autoCommit: false,
                    });
                    return true;
                }
                if (lm.isSubLocation(metaClean) && currentParent) {
                    const curLoc = currentParent;
                    const existingSub = lm.getSubLocations(currentParent.id).find(sub =>
                        sub.name.toLowerCase() === metaClean.toLowerCase() ||
                        (sub.aliases || []).some(alias => alias.toLowerCase() === metaClean.toLowerCase())
                    );
                    if (existingSub) {
                        if (_dm === 'auto') {
                                if (lm.currentLocationId !== currentParent.id) await lm.moveTo(currentParent.id, rpDate);
                                await lm.moveToSub(existingSub.id);
                            pi.inject();
                            await _tryEvent(text, existingSub.id, source);
                        } else {
                            queueDetectedPlace(existingSub.name, {
                                source: 'meta', kind: 'sub', confidence: 0.92,
                                reason: `기존 “${curLoc?.name || '현재 장소'}” 내부 장소와 정확히 일치`, parentId: currentParent.id,
                                snippet: text, rpDate,
                            });
                        }
                    } else {
                        queueDetectedPlace(metaClean, {
                            source: 'meta', kind: 'sub', confidence: 0.76,
                            reason: `“${curLoc?.name || '현재 장소'}” 내부 장소 후보`, parentId: currentParent.id,
                            snippet: text, rpDate,
                        });
                    }
                    return true;
                }

                // v0.9.47: automatic movement only accepts exact normalized names/aliases.
                // Partial-word and word-overlap matches are suggestions, not proof.
                const existing = findContextualExactLocation(lm, metaLoc) || findContextualExactLocation(lm, metaClean);
                if (existing) {
                    if (!existing.parentId && isStandaloneInternalLabel(existing.name)) {
                        const parent = resolveTopLevelParent(lm, existing.name, '', LocationManager.PLACE_DICT);
                        queueDetectedPlace(existing.name, {
                            source: 'meta', kind: 'sub', parentId: parent?.id || '', confidence: 0.64,
                            reason: '구버전 최상위 내부 장소 — 부모 확인 필요', snippet: text, rpDate, autoCommit: false,
                        });
                        if (_dm === 'auto' && parent?.id) await _tryEvent(text, parent.id, source);
                        return true;
                    }
                    if (_dm !== 'auto') {
                        queueDetectedPlace(existing.name, {
                            source: 'meta', kind: existing.parentId ? 'sub' : 'current', parentId: existing.parentId || '', confidence: 0.94,
                            reason: '상태창 이름이 기존 장소/별칭과 정확히 일치', snippet: text, rpDate,
                        });
                    } else {
                        await moveToDetectedLocation(lm, existing, rpDate);
                        if (s.showDetectToast) wtNotify(`${wtMascot()} ${wtTreat()} ${existing.name}`, 'move');
                        pi.inject(); if (ui.panelVisible) ui.refresh();
                    }
                    if (_dm === 'auto') await _tryEvent(text, existing.id, source);
                    return true;
                } else {
                    const queued = queueDetectedPlace(metaLoc, {
                        source: 'meta', kind: 'current', confidence: 0.86,
                        reason: 'Location/장소 메타 필드에서 찾음',
                        snippet: text, rpDate,
                    });
                    const committed = queued.commitPromise ? await queued.commitPromise : null;
                    const eventLocId = committed?.id || lm.currentLocationId;
                    if (eventLocId) await _tryEvent(text, eventLocId, source);
                    return true;
                }
            }
        }

        dbg(`🔍 ${source} (${text.length}c) mode=${mode}${rpDate ? ' rpDate=' + rpDate : ''}`);

        // 이미 등록된 장소 감지 (USER/AI 동일)
        const result = det.detect(text);
        if (result) {
            const { type, confidence } = result;
            const contextual = findContextualExactLocation(lm, result.location.name);
            let location = contextual || result.location;

            // A child found under another parent is not proof that the RP moved
            // to that parent. Hold it for review under the current context.
            if (!contextual && result.location.parentId && isStandaloneInternalLabel(result.location.name)) {
                const parent = resolveTopLevelParent(lm, result.location.name, '', LocationManager.PLACE_DICT);
                queueDetectedPlace(result.location.name, {
                    source: mode, kind: 'sub', parentId: parent?.id || '', confidence,
                    reason: '다른 부모의 동일 내부 장소 — 현재 부모 연결 확인 필요',
                    snippet: text, rpDate, autoCommit: false,
                });
                return true;
            }

            // Never reuse a legacy world-map Room as a current top-level place.
            if (!location.parentId && isStandaloneInternalLabel(location.name)) {
                const parent = resolveTopLevelParent(lm, location.name, '', LocationManager.PLACE_DICT);
                queueDetectedPlace(location.name, {
                    source: mode, kind: 'sub', parentId: parent?.id || '', confidence: Math.min(confidence, 0.64),
                    reason: '구버전 최상위 내부 장소 — 부모 확인 필요',
                    snippet: text, rpDate, autoCommit: false,
                });
                return true;
            }

            dbg(`✅ "${location.name}" (${type} c=${confidence})`);
            // Only a strong name-adjacent movement expression may mutate current state.
            if (_dm === 'auto' && confidence >= 0.9) {
                await moveToDetectedLocation(lm, location, rpDate);
                if (s.showDetectToast) wtNotify(`${wtMascot()} ${wtTreat()} ${location.name}`, 'move');
                pi.inject(); if (ui.panelVisible) ui.refresh();
            } else if (_dm !== 'auto' || confidence < 0.9) {
                queueDetectedPlace(location.name, {
                    source: mode, kind: location.parentId ? 'sub' : 'current', parentId: location.parentId || '', confidence,
                    reason: '기존 장소명이 언급됐지만 이동 표현이 이름 바로 옆에서 확실하지 않음',
                    snippet: text, rpDate, autoCommit: false,
                });
                return true;
            }
            // 이벤트 추출 (AI=전체, USER=강한 키워드만)
            await _tryEvent(text, location.id, source);
            return true;
        }

        // 새 장소 발견 (mode 전달 → AI는 엄격)
        const np = det.detectNewPlace(text, mode);
        if (np) {
            dbg(`🆕 "${np}" (${source})`);
            const isInternal = lm.isSubLocation(np);
            const parent = isInternal ? resolveTopLevelParent(lm, np, '', LocationManager.PLACE_DICT) : null;
            const queued = queueDetectedPlace(np, {
                source: mode,
                kind: isInternal ? 'sub' : 'current', parentId: parent?.id || '',
                confidence: mode === 'user' ? 0.76 : 0.68,
                reason: isInternal
                    ? (parent ? `“${parent.name}” 내부 장소로 감지` : '내부 장소로 보이지만 부모 장소를 확인해야 함')
                    : '이동 문맥에서 미등록 장소명을 찾음',
                snippet: text, rpDate, autoCommit: isInternal ? Boolean(parent) : undefined,
            });
            const committed = queued.commitPromise ? await queued.commitPromise : null;
            const eventLocId = committed?.id || lm.currentLocationId;
            if (eventLocId) await _tryEvent(text, eventLocId, source);
            return true;
        }

        // 장소 감지 실패해도, 현재 위치가 있으면 이벤트만 추출
        if (lm.currentLocationId) await _tryEvent(text, lm.currentLocationId, source);

        // ★ AI 응답에서 NPC/동물 자동 감지 (터줏대감)
        if (source === 'AI' && lm.currentLocationId) {
            try {
                const ctx = getContext();
                const npcs = det.detectNPCs(text, ctx.name1, ctx.name2);
                for (const npc of npcs) {
                    await lm.addNpcToLocation(lm.currentLocationId, npc);
                }
                if (npcs.length) { pi.inject(); if (ui?.panelVisible) ui.refresh(); }
            } catch(e) { dbg('⚠️ NPC detect error:', e.message); }
        }

        // (약속 장소 감지는 메타 Location 처리 전에 이미 실행됨)

        return false;
    } catch (_) { return false; }
}

async function init() {
    if (!extension_settings[EXTENSION_NAME]) extension_settings[EXTENSION_NAME] = { ...defaults };
    for (const [k,v] of Object.entries(defaults)) {
        if (extension_settings[EXTENSION_NAME][k] === undefined) extension_settings[EXTENSION_NAME][k] = v;
    }
    // Rebuild the extension settings as a plain redacted object so secrets nested in an
    // old or imported settings blob cannot survive merely because they are not top-level.
    extension_settings[EXTENSION_NAME] = redactSecretFields(extension_settings[EXTENSION_NAME]) || { ...defaults };
    // v0.9.46: credentials must never live in persistent extension settings.
    // Remove legacy secrets on every startup, even if an old backup reintroduced them.
    const secretSettingPattern = /^(?:api[_-]?key|private[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|vertexSaJson|llmApiKey)$/i;
    for (const key of Object.keys(extension_settings[EXTENSION_NAME])) {
        if (secretSettingPattern.test(key)) delete extension_settings[EXTENSION_NAME][key];
    }
    delete extension_settings[EXTENSION_NAME].useVertex;
    if (!extension_settings[EXTENSION_NAME]._securityMigration0946) {
        extension_settings[EXTENSION_NAME].externalAiEnabled = false;
        extension_settings[EXTENSION_NAME].shareRpData = false;
        extension_settings[EXTENSION_NAME].allowAutoGeocoding = false;
        extension_settings[EXTENSION_NAME].autoEvent = false;
        extension_settings[EXTENSION_NAME].autoSchedule = false;
        extension_settings[EXTENSION_NAME].dragEvent = false;
        extension_settings[EXTENSION_NAME].aiInjection = false;
        extension_settings[EXTENSION_NAME]._securityMigration0946 = true;
    }
    // v0.9.47 changes the detection/storage boundary. Reset every sensitive opt-in once
    // so an older installation cannot silently carry paid or data-sharing behavior forward.
    if (!extension_settings[EXTENSION_NAME]._securityMigration0947) {
        extension_settings[EXTENSION_NAME].externalAiEnabled = false;
        extension_settings[EXTENSION_NAME].shareRpData = false;
        extension_settings[EXTENSION_NAME].allowAutoGeocoding = false;
        extension_settings[EXTENSION_NAME].autoEvent = false;
        extension_settings[EXTENSION_NAME].autoSchedule = false;
        extension_settings[EXTENSION_NAME].dragEvent = false;
        extension_settings[EXTENSION_NAME].aiInjection = false;
        extension_settings[EXTENSION_NAME].locationEnrichment = 'off';
        extension_settings[EXTENSION_NAME].detectMode = 'off';
        extension_settings[EXTENSION_NAME].autoDetect = false;
        extension_settings[EXTENSION_NAME]._securityMigration0947 = true;
    }
    // v0.9.49: v0.9.47에서 잘못 강제 해제한 핵심 자동 등록 동작을 한 번 복구한다.
    // 이 기능은 로컬 규칙 감지이며 외부 AI·Photon 동의 설정은 건드리지 않는다.
    if (!extension_settings[EXTENSION_NAME]._restoreCoreDetection0949) {
        extension_settings[EXTENSION_NAME].detectMode = 'auto';
        extension_settings[EXTENSION_NAME].autoDetect = true;
        extension_settings[EXTENSION_NAME]._restoreCoreDetection0949 = true;
    }
    // v0.9.51: Yun 확정 정책 마이그레이션 (1회)
    //   자동 감지 기본 OFF(후보함은 유지) / aiInjection·dragEvent 기본 ON 복원 / llmMode 기본 profile
    if (!extension_settings[EXTENSION_NAME]._policyMigration0951) {
        extension_settings[EXTENSION_NAME].detectMode = 'off';
        extension_settings[EXTENSION_NAME].autoDetect = false;
        extension_settings[EXTENSION_NAME].aiInjection = true;
        extension_settings[EXTENSION_NAME].dragEvent = true;
        if (!extension_settings[EXTENSION_NAME].llmMode) extension_settings[EXTENSION_NAME].llmMode = 'profile';
        extension_settings[EXTENSION_NAME]._policyMigration0951 = true;
    }
    // Treat privacy- and billing-sensitive settings as strict booleans on every load.
    // Corrupt/legacy string values such as "true" must never become implicit opt-ins.
    for (const key of ['externalAiEnabled', 'shareRpData', 'allowAutoGeocoding', 'showGoogleLinks', 'autoEvent', 'autoSchedule', 'dragEvent', 'aiInjection']) {
        extension_settings[EXTENSION_NAME][key] = extension_settings[EXTENSION_NAME][key] === true;
    }
    if (!['off', 'confirm', 'auto'].includes(extension_settings[EXTENSION_NAME].detectMode)) {
        extension_settings[EXTENSION_NAME].detectMode = 'off';
        extension_settings[EXTENSION_NAME].autoDetect = false;
    }
    // v0.9.51: grounding은 direct 모드 + google 프로바이더에서만 유효 (아니면 off로 강등)
    if (!['off', 'overpass', 'grounding'].includes(extension_settings[EXTENSION_NAME].locationEnrichment)) {
        extension_settings[EXTENSION_NAME].locationEnrichment = 'off';
    }
    if (extension_settings[EXTENSION_NAME].locationEnrichment === 'grounding'
        && (extension_settings[EXTENSION_NAME].llmMode !== 'direct' || extension_settings[EXTENSION_NAME].llmProvider !== 'google')) {
        extension_settings[EXTENSION_NAME].locationEnrichment = 'off';
    }
    if (!['profile', 'direct'].includes(extension_settings[EXTENSION_NAME].llmMode)) {
        extension_settings[EXTENSION_NAME].llmMode = 'profile';
    }
    if (!['liberty', 'bright', 'dark'].includes(extension_settings[EXTENSION_NAME].openMapStyle)) {
        extension_settings[EXTENSION_NAME].openMapStyle = 'liberty';
    }
    extension_settings[EXTENSION_NAME].mapSearchLanguage = extension_settings[EXTENSION_NAME].mapSearchLanguage === 'en' ? 'en' : 'ko';
    extension_settings[EXTENSION_NAME].debugMode = false;
    // 구버전 마이그레이션 표식은 유지하되 v0.9.49 복구값을 다시 덮지 않는다.
    if (!extension_settings[EXTENSION_NAME]._migrated_v090) {
        extension_settings[EXTENSION_NAME]._migrated_v090 = true;
    }
    // ★ v0.6.0 마이그레이션: 기존 'node' 유저 → 'leaflet' 강제 전환 (한 번만)
    if (!extension_settings[EXTENSION_NAME]._migrated_v06) {
        if (extension_settings[EXTENSION_NAME].mapMode === 'node') {
            extension_settings[EXTENSION_NAME].mapMode = 'leaflet';
        }
        extension_settings[EXTENSION_NAME]._migrated_v06 = true;
    }
    saveSettingsDebounced();

    db = new WorldTrackerDB(); await db.open();
    lm = new LocationManager(db);
    det = new LocationDetector(lm);
    pi = new PromptInjector(lm);
    ui = new UIManager(lm, pi);
    detectionCandidates = new DetectionCandidateManager(lm);
    ui.setDetectionCandidates(detectionCandidates);
    ui.createSettingsPanel(); ui.createSidePanel(); ui.registerWandButton();

    let lastId = null;
    let _handleCount = 0;
    async function handle(idx) {
        try {
            if (isAutoDetectPaused()) {
                return;
            }
            _handleCount++;
            if (!isChatActive()) return;
            const ctx = getContext(); if (!ctx?.chat?.length) return;

            // 메시지 가져오기 (idx가 숫자면 해당 인덱스, 아니면 마지막 메시지)
            let aiMsg = null, aiIdx = -1;
            if (typeof idx === 'number' && idx >= 0 && idx < ctx.chat.length) {
                aiMsg = ctx.chat[idx]; aiIdx = idx;
            } else {
                // 마지막 AI 메시지 찾기 (뒤에서부터)
                for (let i = ctx.chat.length - 1; i >= Math.max(0, ctx.chat.length - 3); i--) {
                    if (ctx.chat[i] && !ctx.chat[i].is_user) { aiMsg = ctx.chat[i]; aiIdx = i; break; }
                }
            }
            if (!aiMsg || aiMsg.is_user) return;

            const mid = `${aiIdx}_${(aiMsg.mes||'').length}`;
            if (mid === lastId) return; lastId = mid;

            // 직전 유저 메시지 찾기
            let userMsg = null;
            for (let i = aiIdx - 1; i >= Math.max(0, aiIdx - 3); i--) {
                if (ctx.chat[i]?.is_user) { userMsg = ctx.chat[i]; break; }
            }

            dbg(`📨 AI:${(aiMsg.mes||'').length}c User:${(userMsg?.mes||'').length}c`);
            // USER 먼저 (장소 감지)
            if (userMsg?.mes?.trim()) await scanMessage(userMsg.mes, 'USER');
            // AI (장소+이벤트) — 유저 컨텍스트도 전달
            _userContext = userMsg?.mes?.trim() || '';
            if (aiMsg.mes?.trim()) await scanMessage(aiMsg.mes, 'AI');
            // v0.9.25: 예정 일정 — 인풋(유저)+아웃풋(AI) 둘 다 읽음 (약속은 유저가 먼저 꺼내는 경우 많음)
            const _schedText = [userMsg?.mes, aiMsg?.mes].filter(t => t && t.trim()).join('\n---\n');
            if (_schedText.trim()) await scanSchedule(_schedText, 'BOTH');
            _userContext = '';
        } catch (_) {}
    }

    // ★ 이벤트 등록 (여러 이벤트에 걸어서 확실하게)
    const msgEvents = ['MESSAGE_RECEIVED', 'MESSAGE_RENDERED', 'GENERATION_ENDED', 'GENERATION_STOPPED'];
    for (const evName of msgEvents) {
        if (event_types[evName]) {
            eventSource.on(event_types[evName], handle);
        }
    }

    // ★ v0.9.2: ST 생성 상태 추적 — 충돌 방어용 (확장의 자동 LLM 호출이 ST 생성과 겹치지 않게)
    for (const evName of ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS']) {
        if (event_types[evName]) eventSource.on(event_types[evName], () => _setStBusy(true));
    }
    for (const evName of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        if (event_types[evName]) eventSource.on(event_types[evName], () => _setStBusy(false));
    }

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        pi.clear(); lastId = null;
        // 타이밍: SillyTavern이 chatId 갱신할 때까지 대기
        await new Promise(r => setTimeout(r, 300));
        const newId = lm.getChatId();
        dbg(`🔄 CHAT_CHANGED → ${newId}`);
        await lm.loadChat();
        detectionCandidates.clear();
        await _ensureTempPinned(); // 좌표 없는 임시/예정 장소 핀 보정
        pi.inject();
        ui.resetMap();
        if (ui.panelVisible) ui.refresh();
        // scanContext: 첫 시도 실패 시 1초 후 재시도
        if (!await scanContext()) {
            setTimeout(() => scanContext(), 1000);
        }
        // ★ 위치 기반 자동 확장
        const _expGuard = makeChatGuard();
        setTimeout(async () => {
            if (!_expGuard()) { dbg('⏭️ 자동 거리/지오코딩 — 채팅이 바뀜, 스킵'); return; } // v0.9.2: 채팅전환 방어
            try { await lm.autoCalcDistances(); } catch(_){}
            try { await lm.autoReverseGeocode(); } catch(_){}
            if (_expGuard() && ui.panelVisible) ui.refresh();
        }, 3000);

        // ★ 캐릭터시트에서 1차 주소/지역 자동 추출 (GPS 앵커 없을 때)
        // v0.9.2: 비활성화 — autoDetect 마스터 스위치 뒤로 가둠 (기본 OFF).
        //   이전엔 이 블록이 autoDetect를 무시하고 돌아서 "감지 껐는데도 장소 생성"의 원인이었음.
        //   코드는 참고용으로 남기고, autoDetect를 켜야만 동작하게 게이팅. + ST 생성중/채팅전환 방어.
        const _csGuard = makeChatGuard();
        setTimeout(async () => {
            try {
                if (!extension_settings[EXTENSION_NAME]?.autoDetect) { dbg('⏭️ 캐릭터시트 자동추출 비활성 (autoDetect OFF)'); return; }
                if (isStBusy()) { dbg('⏭️ 캐릭터시트 자동추출 — ST 생성 중이라 스킵'); return; }
                if (!_csGuard()) { dbg('⏭️ 캐릭터시트 자동추출 — 채팅이 바뀜, 스킵'); return; }
                // GPS 좌표 있는 장소가 하나라도 있으면 스킵 (이미 앵커 있음)
                const hasAnchor = lm.locations.some(l => l.lat && l.lng);
                if (hasAnchor) return;

                const ctx = getContext();
                const desc = ctx.characters?.[ctx.characterId]?.description || '';
                const scenario = ctx.characters?.[ctx.characterId]?.scenario || '';
                const persona = ctx.characters?.[ctx.characterId]?.personality || '';
                const combined = [desc, scenario, persona].join(' ');
                if (combined.length < 10) return;

                // 주소/지역 패턴 추출 (폭넓은 매칭)
                const patterns = [
                    // 영어: "lives in X", "based in X", "set in X"
                    /(?:lives?\s+in|based\s+in|located\s+in|set\s+in|takes?\s+place\s+in|stationed\s+in|deployed\s+to)\s+([A-Z][a-zA-Z\s,]+?)(?:[.\n;]|$)/i,
                    // 한국어: "~에 사는", "배경: ~"
                    /(?:사는\s*곳|거주지|배경|위치|거점|활동지)[:\s은는이가]*([^\n,.]{2,15})/,
                    // 도시명 직접 매칭 (영어)
                    /(New\s+Orleans|Los\s+Angeles|New\s+York|San\s+Francisco|Las\s+Vegas|Hong\s+Kong|Rio\s+de\s+Janeiro|Buenos\s+Aires|Kuala\s+Lumpur|Tel\s+Aviv|Abu\s+Dhabi|London|Tokyo|Paris|Seoul|Berlin|Moscow|Beijing|Shanghai|Chicago|Toronto|Sydney|Melbourne|Singapore|Mumbai|Bangkok|Dubai|Rome|Madrid|Amsterdam|Prague|Vienna|Istanbul|Cairo|Nairobi|Jakarta|Manila|Taipei|Osaka|Kyoto|Busan|Hanoi|Saigon|Havana|Lima|Bogota|Mexico\s+City)/i,
                    // 도시명 직접 매칭 (한국어 외래어)
                    /(뉴올리언스|로스앤젤레스|뉴욕|샌프란시스코|라스베이거스|홍콩|런던|도쿄|파리|베를린|모스크바|베이징|상하이|시카고|토론토|시드니|멜버른|싱가포르|뭄바이|방콕|두바이|로마|마드리드|암스테르담|프라하|비엔나|이스탄불|카이로|자카르타|마닐라|타이베이|오사카|교토|부산|하노이|하바나|리마|멕시코시티)/,
                    // 한국 도시
                    /(서울|부산|대구|인천|광주|대전|울산|세종|제주|수원|성남|고양|용인|창원|청주|전주|포항|천안|김해|평택)/,
                    // 군사/기지
                    /(?:기지|base|camp|fort|headquarters|HQ|barracks|막사|본부|사령부|주둔지)\s*(?:in\s+|:?\s*)([A-Za-z\uAC00-\uD7A3\s]{2,20})/i,
                ];

                for (const pat of patterns) {
                    const m = combined.match(pat);
                    if (m) {
                        const place = (m[1] || m[0]).replace(/[,.\s]+$/g, '').trim().substring(0, 25);
                        if (place.length >= 2) {
                            dbg(`🏠 Character sheet region detected: "${place}"`);
                            // 이미 같은 이름의 장소 있으면 스킵
                            if (lm.findByNameExact(place)) {
                                dbg(`🏠 "${place}" already exists, skipping`);
                                break;
                            }
                            queueDetectedPlace(place, {
                                source: 'character', kind: 'mentioned', confidence: 0.66,
                                reason: '캐릭터 설명/시나리오에서 지역 후보를 찾음',
                            });
                            break;
                        }
                    }
                }
            } catch(e) { dbg('⚠️ CharSheet addr error:', e.message); }
        }, 2000);
    });

    if (event_types.MESSAGE_SENDING) {
        eventSource.on(event_types.MESSAGE_SENDING, () => {
            if (extension_settings[EXTENSION_NAME]?.enabled && extension_settings[EXTENSION_NAME]?.aiInjection === true) pi.inject();
        });
    }


    // 초기 데이터 로드 + 렌더링
    await lm.loadChat();
    ui.refresh();
    // ★ 위치 기반 자동 확장 (비동기, 로딩 안 막음)
    setTimeout(async () => {
        try { await lm.autoCalcDistances(); } catch(_){}
        try { await lm.autoReverseGeocode(); } catch(_){}
        ui.refresh();
    }, 2000);
}

async function scanContext() {
    try {
        const s = extension_settings[EXTENSION_NAME];
        if (!s?.enabled || !s?.autoDetect || !lm.currentChatId) return true; // 설정 비활성 = 정상
        const ctx = getContext();
        if (!ctx?.characterId) return true;

        // Bug I: 채팅 화면 활성 체크
        if (!isChatActive()) return false; // false = 재시도 필요

        // Task 2: 장소가 1개라도 있으면 재스캔 스킵
        if (lm.locations.length > 0) return;

        // 1차: 기존 채팅 히스토리 전체 스캔 (진행 중인 채팅에 확장 설치 시)
        if (ctx.chat?.length > 1) {
            const found = await scanChatHistory(ctx);
            if (found) return;
        }

        // 2차: 캐릭터 설명/시나리오에서 추출
        const char = ctx.characters?.[ctx.characterId];
        if (!char) return;
        const sources = [];
        if (char.description) sources.push(char.description);
        if (char.scenario) sources.push(char.scenario);
        if (char.first_mes) sources.push(char.first_mes);
        if (char.personality) sources.push(char.personality);
        try { const dp = document.querySelector('#depth_prompt_prompt'); if (dp?.value?.trim()) sources.push(dp.value); } catch(_){}
        try { const meta = ctx.chat_metadata; if (meta?.note_prompt) sources.push(meta.note_prompt); if (meta?.depth_prompt?.prompt) sources.push(meta.depth_prompt.prompt); } catch(_){}
        if (!sources.length) return;

        for (const text of sources) {
            const desc = det.detectFromDescription(text);
            if (desc) {
                dbg(`📋 Desc: "${desc}"`);
                queueDetectedPlace(desc, {
                    source: 'history', kind: 'mentioned', confidence: 0.62,
                    reason: '과거 채팅/캐릭터 설명에서 찾은 초기 장소 후보',
                });
                return;
            }
        }
        for (const text of sources) {
            const result = det.detect(text);
            if (result) {
                dbg(`📋 Context: "${result.location.name}"`);
                queueDetectedPlace(result.location.name, {
                    source: 'character', kind: 'mentioned', confidence: result.confidence,
                    reason: '캐릭터 설명/시나리오에서 기존 장소가 언급됨 — 현재 위치 변경 전 확인', snippet: text,
                });
                return;
            }
            const np = det.detectNewPlace(text, 'user');
            if (np) {
                dbg(`📋 Context new: "${np}"`);
                queueDetectedPlace(np, {
                    source: 'history', kind: 'mentioned', confidence: 0.6,
                    reason: '과거 채팅에서 찾은 초기 장소 후보', snippet: text,
                });
                return;
            }
        }
    } catch (_) {}
}

// ========== 최근 메시지 스캔 (승인 플로우) ==========
async function scanChatHistory(ctx) {
    if (!ctx?.chat?.length) return false;
    const recent = ctx.chat.slice(-4); // 최근 4개
    dbg(`📜 최근 ${recent.length}개 메시지 스캔`);

    let foundCount = 0;
    for (const msg of recent) {
        if (!msg?.mes?.trim()) continue;
        const text = msg.mes;

        const result = det.detect(text);
        if (result) {
            const queued = queueDetectedPlace(result.location.name, {
                source: 'history', kind: 'mentioned', confidence: result.confidence,
                reason: '최근 채팅에서 기존 장소가 언급됨 — 현재 위치 변경 전 확인', snippet: text,
            });
            if (queued.queued) foundCount++;
            continue;
        }

        const np = det.detectNewPlace(text, 'ai');
        if (np && !lm.findByNameExact(np)) {
            const queued = queueDetectedPlace(np, {
                source: 'history', kind: 'mentioned', confidence: 0.58,
                reason: '최근 채팅에서 찾은 미등록 장소 후보', snippet: text,
            });
            if (queued.queued) foundCount++;
        }
    }

    if (!foundCount) return false;
    dbg(`📜 ${foundCount}개 장소 후보 → 후보함 대기`);
    return true;
}

jQuery(async () => { try { await init(); } catch (_) {} });

// ========== opt-in automatic geocoding (Photon / OpenStreetMap) ==========
// Chat-derived names are never transmitted unless allowAutoGeocoding is explicitly enabled.
async function _geocodeQuiet(query, placeOnly = false, bias = null) {
    const results = await searchPlaces(query, { limit: placeOnly ? 5 : 1, automatic: true, bias: bias || undefined });
    const best = placeOnly
        ? results.find(result => /city|town|village|state|country|district|locality/i.test(`${result.type} ${result.category}`)) || results[0]
        : results[0];
    return best ? { lat: best.lat, lng: best.lng, addr: best.fullName || best.name || String(query) } : null;
}

// ========== RP 날짜 추출 (메타데이터에서) ==========
// v0.9.0: 자동 추출 비활성화 — LLM이 현실 날짜를 상태창에 쓰는 문제로 인해
//         이벤트/장소/타임라인 날짜는 유저가 직접 수기 수정 (이미 UI 제공됨)
// v0.9.11: RP 상태창 날짜 추출 복구 — 방문기록/타임라인이 RP 내 시간을 따르도록
//          (유저가 직접 수정한 rpFirstVisited 등은 덮어쓰지 않음)
function _extractRpDate(text) {
    return _legacyExtractRpDate(text || '');
}

// 최신 메시지(상태창 포함)에서 현재 RP 날짜를 추출 — 가장 최근 것 우선
export function getCurrentRpDate() {
    try {
        const ctx = getContext();
        if (!ctx?.chat?.length) return '';
        for (let i = ctx.chat.length - 1, n = 0; i >= 0 && n < 5; i--, n++) {
            const m = ctx.chat[i];
            if (!m || !m.mes) continue;
            const d = _extractRpDate(m.mes);
            if (d) return d;
        }
    } catch (_) {}
    return '';
}
// location-manager 등 import 없이도 쓸 수 있도록 전역 노출
try { if (typeof window !== 'undefined') window._wtGetRpDate = getCurrentRpDate; } catch (_) {}

function _legacyExtractRpDate(text) {
    // HTML 태그 제거 (렌더된 마크다운 대응) + 이모지 정리
    const clean = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

    // 패턴 1: - Time: 2025/07/12 또는 Date: 2025.07.12
    const m1 = clean.match(/(?:[-*]?\s*)?(?:📅\s*)?(?:Time|Date|날짜|시간)[:\s]+(?:\w+,?\s+)?(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/i);
    if (m1) return `${m1[1]}/${parseInt(m1[2])}/${parseInt(m1[3])}`;

    // 패턴 1b: 2024/12/19, 09:30 AM (날짜+시간)
    const m1b = clean.match(/(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2}),?\s*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)/);
    if (m1b) return `${m1b[1]}/${parseInt(m1b[2])}/${parseInt(m1b[3])}`;

    // 패턴 2: "📅 Date: Thu, 19 Dec" 또는 "Date: Thu, 19 Dec 2024" (Celia/P&C 형식)
    const mCelia = clean.match(/(?:📅\s*)?Date[:\s]+(?:\w{3},?\s+)?(\d{1,2})\s+(\w{3,9})(?:\s+(\d{4}))?/i);
    if (mCelia && months[mCelia[2].substring(0,3).toLowerCase()]) {
        const mon = months[mCelia[2].substring(0,3).toLowerCase()];
        const day = parseInt(mCelia[1]);
        const yr = mCelia[3] ? parseInt(mCelia[3]) : new Date().getFullYear();
        return `${yr}/${mon}/${day}`;
    }

    // 패턴 2b: "December 19, 2024" 또는 "19 December 2024"
    const m2 = clean.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (m2 && months[m2[1].substring(0,3).toLowerCase()]) return `${m2[3]}/${months[m2[1].substring(0,3).toLowerCase()]}/${parseInt(m2[2])}`;
    const m3 = clean.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
    if (m3 && months[m3[2].substring(0,3).toLowerCase()]) return `${m3[3]}/${months[m3[2].substring(0,3).toLowerCase()]}/${parseInt(m3[1])}`;

    // 패턴 3: 7월 12일
    const m4 = clean.match(/(\d{1,2})월\s*(\d{1,2})일/);
    if (m4) {
        const yr = clean.match(/(\d{4})년/);
        return yr ? `${yr[1]}/${parseInt(m4[1])}/${parseInt(m4[2])}` : `${parseInt(m4[1])}/${parseInt(m4[2])}`;
    }
    return '';
}

// ========== RP 날짜 기반 일정 날짜 계산 ==========
function _calcPlanDate(rpDate, whenText) {
    if (!rpDate || !whenText) return '';
    // rpDate 파싱: "2024/12/19" → Date
    const parts = rpDate.split('/').map(Number);
    if (parts.length < 2) return '';
    let base;
    if (parts.length === 3) base = new Date(parts[0], parts[1] - 1, parts[2]);
    else if (parts.length === 2) base = new Date(2024, parts[0] - 1, parts[1]); // 년도 없으면 기본값
    if (!base || isNaN(base.getTime())) return '';

    const lo = whenText.toLowerCase().trim();

    // 한국어 패턴
    if (/^내일$/.test(lo)) { base.setDate(base.getDate() + 1); }
    else if (/^모레$/.test(lo)) { base.setDate(base.getDate() + 2); }
    else if (/^글피$/.test(lo)) { base.setDate(base.getDate() + 3); }
    else if (/일주일\s*(?:뒤|후)?/.test(lo)) { base.setDate(base.getDate() + 7); }
    else if (/^다음\s*주/.test(lo) || /^next\s*week/i.test(lo)) { base.setDate(base.getDate() + 7); }
    else if (/^이번\s*주말/.test(lo)) { const dow = base.getDay(); base.setDate(base.getDate() + (6 - dow)); }
    else if (/^다음\s*달/.test(lo) || /^next\s*month/i.test(lo)) { base.setMonth(base.getMonth() + 1); }
    else if (/보름\s*(?:뒤|후)?/.test(lo)) { base.setDate(base.getDate() + 15); }
    else {
        // "N주 뒤/후" or "N달/개월 뒤/후" or "N일 뒤/후"
        const koNum = lo.match(/(\d+)\s*(?:주)\s*(?:뒤|후)/);
        if (koNum) { base.setDate(base.getDate() + parseInt(koNum[1]) * 7); }
        else {
            const koDay = lo.match(/(\d+)\s*(?:일)\s*(?:뒤|후)/);
            if (koDay) { base.setDate(base.getDate() + parseInt(koDay[1])); }
            else {
                const koMonth = lo.match(/(\d+)\s*(?:달|개월)\s*(?:뒤|후)/);
                if (koMonth) { base.setMonth(base.getMonth() + parseInt(koMonth[1])); }
                else {
                    // 영어: "in N days/weeks/months", "N days later", "tomorrow"
                    // ★ 영어 단어 숫자 변환
                    const wordNums = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
                    let loNum = lo;
                    for (const [word, num] of Object.entries(wordNums)) {
                        loNum = loNum.replace(new RegExp('\\b' + word + '\\b', 'gi'), num);
                    }
                    if (/^tomorrow/i.test(lo)) { base.setDate(base.getDate() + 1); }
                    else if (/(?:in\s+)?(?:two|2)\s+weeks/i.test(lo)) { base.setDate(base.getDate() + 14); }
                    else if (/(?:in\s+)?(?:three|3)\s+weeks/i.test(lo)) { base.setDate(base.getDate() + 21); }
                    else if (/(?:in\s+)?(?:a|one|1)\s+week/i.test(lo)) { base.setDate(base.getDate() + 7); }
                    else if (/(?:in\s+)?(?:a|one|1)\s+month/i.test(lo)) { base.setMonth(base.getMonth() + 1); }
                    else {
                        const enNum = loNum.match(/(\d+)\s*(?:days?)/i);
                        if (enNum) { base.setDate(base.getDate() + parseInt(enNum[1])); }
                        else {
                            const enWeek = lo.match(/(\d+)\s*(?:weeks?)/i);
                            if (enWeek) { base.setDate(base.getDate() + parseInt(enWeek[1]) * 7); }
                            else {
                                const enMonth = lo.match(/(\d+)\s*(?:months?)/i);
                                if (enMonth) { base.setMonth(base.getMonth() + parseInt(enMonth[1])); }
                                else {
                                    // "T+14 DAYS" 패턴
                                    const tPlus = lo.match(/t\+(\d+)\s*(?:days?)/i);
                                    if (tPlus) { base.setDate(base.getDate() + parseInt(tPlus[1])); }
                                    else {
                                        // N월 N일
                                        const koDate = lo.match(/(\d{1,2})월\s*(\d{1,2})일/);
                                        if (koDate) return `${base.getFullYear()}/${parseInt(koDate[1])}/${parseInt(koDate[2])}`;
                                        // next + 요일
                                        const days = { monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,sunday:0,월요일:1,화요일:2,수요일:3,목요일:4,금요일:5,토요일:6,일요일:0 };
                                        for (const [name, dow] of Object.entries(days)) {
                                            if (lo.includes(name)) {
                                                let diff = dow - base.getDay();
                                                if (diff <= 0) diff += 7;
                                                base.setDate(base.getDate() + diff);
                                                break;
                                            }
                                        }
                                        // 매칭 안 되면 빈 값
                                        if (base.getTime() === new Date(parts[0], parts[1] - 1, parts[2] || 1).getTime()) return '';
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return `${base.getFullYear()}/${base.getMonth() + 1}/${base.getDate()}`;
}

// ========== 이벤트 추출 + 저장 헬퍼 ==========
const _strongKw = /키스|kiss|고백|confess|사랑|love|싸[우웠]|fight|죽|kill|배신|betray|도망|escape|약속|promise|결혼|marry|이별|breakup|broke up|훔[쳤치]|stole|steal|snuck|sneak|침입|broke in|farewell|작별|맹세|swear|vow|재회|reunion|잃어버|잃[은었을]|lost|missing/i;
let _lastEventTime = 0;
let _lastEventLocId = null; // 마지막 이벤트 저장 장소

// 전체 패턴 (AI용 — 가벼운 트리거)
const _triggerKw = /키스|kiss|포옹|hug|사랑|love|고백|confess|속삭|whisper|입술|lip|심장|heart|두근|떨[리렸]|tremble|끌어안|embrace|울[었다]|눈물|cry|tear|싸[우웠움]|fight|배신|betray|도망|escape|발견|discover|비밀|secret|부상|injur|약속|promise|내일|tomorrow|선물|gift|devour|cupped|passion|intimate|desire|breathless|gasp|moan|shudder|groan|tongue|stole|steal|stolen|snuck|sneak|훔[쳤치]|침입|threat|경고|죽|kill|death|총|gun|칼|sword|knife|피[가를]|blood|curse|저주|분노|rage|복수|revenge|떠나|이별|작별|farewell|goodbye|depart|leave.*behind|결심|맹세|선언|다짐|decide|swear|vow|declare|귀환|재회|돌아[왔오]|return|reunion|위험|위협|위기|danger|warn|peril|잃어버|잃[은었을]|분실|사라[졌진]|lost|lose|missing|vanish|disappear|계획|작전|일정|schedule|operation|mission|trip|run|shopping|장보기|나들이|쇼핑|appointment|check[- ]?up|검진|재검|진료|예약|clinic|hospital|병원|산부인과|two\s+weeks|next\s+week|next\s+month|다음\s*주|다음\s*달|주\s*뒤|주\s*후|every\s+(?:week|month|time)|영화|cinema|movie|데이트|date|일주일|마트|mart|tesco|가자|가기로|만나자|오기로|ticket|티켓|초대|invite|여행|travel|vacation|휴가|놀러|이사|짐.*싸|옮기|transfer|pack|moving\s+(?:in|out|to)|wheels\s+up|gear\s+up|새\s*집|new\s+(?:place|house|room|gaff|building)/i;

// v0.9.24: 예정 일정(약속) 자동 기록 — RP에서 미래 계획 감지 → 장소 + 예상 일시 + 내용
let _lastSchedTime = 0;
function _hasScheduleSignal(text) {
    return /(내일|모레|글피|다음\s*주|담주|이따|좀\s*있다|나중에|저녁에|아침에|점심에|밤에|\d+\s*시|\d+일\s*후|다음\s*달|주말|약속|예약|예매|만나(?:자|기로|요)|보자|가기로|갈\s*예정|갈\s*거|할\s*예정|하기로|계획|tomorrow|tonight|later|next\s+(?:week|day|month)|appointment|reserv|booked|plan\s+to|let'?s\s+meet|meet\s+(?:at|up))/i.test(text);
}
// v0.9.33: 좌표 없는 임시/예정 장소(wantToGo·_tempAddress)에 핀 좌표 보정 — 채팅 열 때 무조건 보이게
// v0.9.37: 이름에 도시가 있으면 그 도시로 재지오코딩 (집 근처 오배치 교정). _geoFixed로 1회만.
async function _ensureTempPinned() {
    try {
        if (!lm.currentChatId || extension_settings[EXTENSION_NAME]?.allowAutoGeocoding !== true) return;
        let changed = 0;
        for (const l of lm.locations) {
            if (l.parentId || l._geoFixed || l._geocodeSuppressed) continue;
            const isTemp = (Array.isArray(l.tags) && l.tags.includes('wantToGo')) || l._tempAddress;
            if (!isTemp) continue;
            const cityNm = det.cityInName(l.name);
            if (cityNm) {
                // 이름에 도시/국가 → 그 위치로 지오코딩 (집 근처 오배치 교정)
                const g = await _geocodeQuiet(det.cityGeoQuery(cityNm), true);
                if (g) {
                    await lm.updateLocation(l.id, { lat: g.lat, lng: g.lng, address: g.addr, _geoFixed: true, _approximateCoordinates: false, _approximateAnchorId: null, _tempAddress: false });
                    changed++;
                    await new Promise(r => setTimeout(r, 1100)); // rate-limit 완화
                    continue;
                }
                // 지오코딩 실패 → _geoFixed 안 박음 (다음 로드에 재시도)
            }
            // No fabricated fallback coordinate. Unresolved places stay off the real map.
        }
        if (changed) { dbg(`📍 임시 장소 핀 보정: ${changed}곳`); if (ui.panelVisible) ui.refresh(); }
    } catch (_) {}
}

async function scanSchedule(text, source) {
    try {
        const s = extension_settings[EXTENSION_NAME];
        if (!s?.enabled || s?.autoSchedule !== true || !text?.trim()) return;
        const narrativeText = stripNonNarrativeMetadata(text);
        if (!narrativeText) return;
        if (isAutoDetectPaused()) return;
        if (!_hasScheduleSignal(narrativeText)) return;
        if (Date.now() - _lastSchedTime < 30000) return; // 반복 과금/중복 방지
        if (!lm.currentChatId) await lm.loadChat();
        if (!lm.currentChatId) return;
        let rpDate = ''; try { rpDate = window._wtGetRpDate?.() || ''; } catch (_) {}
        const _curL = lm.locations.find(l => l.id === lm.currentLocationId);
        const _curHint = _curL ? `\n참고: 캐릭터의 현재 위치는 "${_curL.name}"${_curL.address ? ` (${_curL.address})` : ''} 근처야. geo에는 이 지역 맥락을 반영해 실제 지명을 넣어줘 (예: 현재 멕시코 카보면 "만타 레스토랑, 카보 산 루카스").` : '';
        const prompt = `다음 RP 텍스트에서 "앞으로 예정된 일정/약속"만 추출해. 이미 일어난 일이 아니라 미래 계획만.
JSON만 출력 (마크다운/설명 금지): {"hasPlan":true 또는 false,"place":"구체적인 장소·시설·도시 이름만 (예: '후쿠오카 공항', '강남 신세계백화점', '도쿄'). 형용사·사물·동작 파편(예: '두꺼운', '작전 지도')은 장소가 아니므로 빈 문자열. 명확한 장소명이 없으면 빈 문자열","geo":"지도 검색용 실제 위치 — 다른 도시·국가면 그 지명까지 포함 (예: '도쿄 디즈니랜드, 일본', '신세계백화점 강남, 서울'). 가상이거나 불명확하면 빈 문자열","when":"예상 일시 (예: 내일 저녁 7시, 3일 후, 다음 주 토요일)","what":"무엇을 할지 짧게"}
구체적인 미래 계획이 없으면 {"hasPlan":false} 만 출력.${_curHint}

텍스트:
"""${narrativeText.slice(0, 1500)}"""`;
        const result = await callLLM(prompt, { maxTokens: 256 });
        const p = result ? parseLLMJson(result) : null;
        if (!p || !p.hasPlan) return;
        p.place = plainText(p.place, 80);
        p.geo = plainText(p.geo, 160);
        p.what = plainText(p.what || '예정된 일정', 300);
        p.when = plainText(p.when, 80);
        // v0.9.43: 동사/형용사 활용형 파편 거르기 ("들어"=들어온다, "두꺼운" 등 — 도시도 아니고 짧은 활용형이면 장소 아님)
        if (p.place && typeof p.place === 'string') {
            const _pp = p.place.trim();
            if (_pp && !det.cityInName(_pp) && _pp.length <= 3 && /[어아운은는던]$/.test(_pp)) {
                dbg(`🚫 일정 장소 파편 무시: "${_pp}" → 현재 위치 사용`);
                p.place = '';
            }
        }
        _lastSchedTime = Date.now();
        // 장소: place 있으면 find/create, 없으면 현재 위치
        let locId = lm.currentLocationId;
        if (p.place && String(p.place).trim()) {
            const nm = String(p.place).trim();
            const existing = lm.findByNameExact(nm);
            if (existing) locId = existing.id;
            else {
                queueDetectedPlace(nm, {
                    source: 'schedule', kind: 'planned', confidence: 0.72,
                    reason: '사용자가 켠 AI 일정 추출 결과 — 등록 전 이름·대상 확인 필요',
                    snippet: [p.when, p.what].filter(Boolean).join(' · '), rpDate,
                });
            }
        }
        if (!locId) return;
        const loc = lm.locations.find(l => l.id === locId);
        if (!loc) return;

        if (!loc.events) loc.events = [];
        const what = p.what || '예정된 일정';
        if (loc.events.some(e => e.isPlan && e.text === what)) return; // 중복 방지
        loc.events.push({
            text: what,
            title: what.substring(0, 20),
            mood: '🗓️',
            isPlan: true,
            planWhen: p.when || '',
            planDate: _calcPlanDate(rpDate, p.when || ''),
            timestamp: Date.now(),
            rpDate,
            source: 'schedule'
        });
        await lm.updateLocation(loc.id, { events: loc.events });
        if (s.showDetectToast) wtNotify(`🗓️ 예정: ${loc.name} — ${[p.when, what].filter(Boolean).join(' ')}`, 'new', 4000);
        pi.inject(); if (ui.panelVisible) ui.refresh();
        dbg(`🗓️ 일정 기록: ${loc.name} | ${p.when} | ${what}`);
    } catch (e) { dbg('⚠️ scanSchedule error:', e.message); }
}

async function _tryEvent(text, locId, source) {
    const _s = extension_settings[EXTENSION_NAME];
    if (_s?.autoEvent !== true) { dbg('⏭️ autoEvent OFF — 이벤트 자동 기록 생략'); return; }
    const narrativeText = stripNonNarrativeMetadata(text);
    dbg(`📋 _tryEvent (${source}) len=${narrativeText.length}`);
    if (narrativeText.length < 25) { dbg('⏭️ Narrative text too short'); return; }
    // 같은 장소 5초 내 중복 방지 (다른 장소는 OK!)
    if (Date.now() - _lastEventTime < 5000 && _lastEventLocId === locId) { dbg('⏭️ Event cooldown (same loc)'); return; }
    // USER는 강한 키워드만, AI는 전체 트리거
    if (source === 'USER' && !_strongKw.test(narrativeText)) { dbg('⏭️ USER no strong keyword'); return; }
    if (source === 'AI' && !_triggerKw.test(narrativeText)) { dbg('⏭️ AI no trigger keyword'); return; }
    dbg(`🎯 Event trigger! (${source}) locId=${locId}`);

    const loc = lm.locations.find(l => l.id === locId);
    if (!loc) return;

    // 중복 방지 (최근 30초 내)
    if (loc.events?.length) {
        const last = loc.events[loc.events.length - 1];
        if (Date.now() - last.timestamp < 30000) return;
    }

    let evText = null, evTitle = null, evMood = '💕';

    // ★ RP 날짜 추출 (먼저! plans에서도 사용)
    const rpDate = _extractRpDate(text);

    // ★ Phase 2: 사용자가 선택한 연결 프로필로 요약 시도
    try {
        const ctx = getContext();
        // HTML 제거 + 메타데이터 제거
        const clean = narrativeText.replace(/<[^>]*>/g, '').replace(/```[\s\S]*?```/g, '').replace(/<memo>[\s\S]*?<\/memo>/g, '').trim();
        if (clean.length < 30) return;

        const trimmed = clean.length > 2000 ? clean.substring(0, 2000) : clean;
        const cleanUserContext = stripNonNarrativeMetadata(_userContext).replace(/<[^>]*>/g, '').substring(0, 300);
        const userCtx = cleanUserContext ? `\n\n[User's action]: ${cleanUserContext}` : '';
        const userName = ctx.name1 || 'User';
        const charName = ctx.name2 || 'Character';
        // ★ 캐릭터 맥락 (이벤트 요약 품질 향상)
        const charDesc = (ctx.characters?.[ctx.characterId]?.description || '').substring(0, 200);
        const charPersonality = (ctx.characters?.[ctx.characterId]?.personality || '').substring(0, 100);
        const charContext = [charDesc, charPersonality].filter(Boolean).join(' | ').substring(0, 300);
        const eLang = extension_settings[EXTENSION_NAME]?.eventLang || 'auto';
        const langInst = eLang === 'ko' ? 'Write the summary in Korean (한국어).'
                       : eLang === 'en' ? 'Write the summary in English.'
                       : 'Write in the SAME LANGUAGE as the input text.';
        const recentChat = getRecentChatContext(1500);

        const prompt = `You are a narrative memory keeper for an RP story. Read the scene and write a rich, detailed 2-sentence memory summary.

Character info: The user/protagonist is named "${userName}". The main character is "${charName}".
${charContext ? `Character context: ${charContext}` : ''}

SPEAKER IDENTIFICATION (CRITICAL — read carefully):
- In this RP, the scene text mostly describes "${charName}"'s actions and dialogue in third-person or first-person.
- "${userName}"'s actions/dialogue appear SEPARATELY (often after a delimiter or in a different style).
- When you see dialogue like "I love you" or actions like *she smiled*, identify WHO is performing that action by looking at the surrounding context and narrative voice.
- NEVER swap speakers. If "${charName}" said something, attribute it to "${charName}". If "${userName}" did something, attribute it to "${userName}".
- ALWAYS write "${userName}" as the SUBJECT of the summary: "${userName}이/가..."

Rules:
- ${langInst}
- ALWAYS include character names as subjects (WHO did what with WHOM).
- When quoting dialogue, ALWAYS verify the correct speaker by checking the sentences IMMEDIATELY before the quote.
- Sentence 1: Describe WHERE it happened (place + atmosphere), WHAT ${userName} was doing, and the KEY EVENT that occurred. Be specific with details from the scene (objects, smells, actions). Include a key dialogue quote with the CORRECT speaker's name.
- Sentence 2: Describe the emotional consequence, tension shift, or what this event foreshadows for the future. Be vivid and narrative.
- Each sentence should be detailed and descriptive (60~120 characters each). Do NOT be too brief.
- Write like a novel's diary entry — immersive, specific, atmospheric.

If no significant event (just walking, sitting, daily routine): {"mood":null,"summary":null,"future_plan":{"has_plan":false}}

Pay SPECIAL ATTENTION to any future promises, appointments, or plans mentioned in the dialogue (e.g., "Let's go to X tomorrow", "Come back in two weeks", "내일 마트 가자", "2주 뒤에 재검").

Respond with ONLY a JSON object, no markdown, no explanation:
{"mood":"💕","title":"ultra-short hook max 15chars","summary":"detailed 2-sentence summary","promisePlace":"named location characters plan to visit (or null)","future_plan":{"has_plan":true,"what":"what they plan to do","where":"destination name or null","when":"time expression as-is: 2주 뒤, tomorrow, 오늘 저녁, next week, 1월 3일, every month, etc."},"npc_interactions":[{"name":"NPC name","delta":0.5,"reason":"short reason"}],"community_updates":[{"name":"NPC or animal name","avatar":"emoji","type":"npc|animal","mood":"excited|chill|tense|romantic|sleepy","moodLabel":"🔥 신남","text":"Twitter-style 1-2 sentence post with @mentions, #hashtags, *actions*"}]}

Mood types: 💕=romantic/emotional 📅=promise/future ⚡=conflict/danger
title: Write like 'OO한 곳' or 'OO이 시작된 곳'. Capture emotional significance, not literal dialogue.
promisePlace: ANY named store/city/building characters discuss visiting. Be AGGRESSIVE. Write ONLY the place name, or null.
future_plan: ALWAYS check for this. If ANY character mentions going somewhere, doing something later, making an appointment, scheduling a visit, or promising to return — set has_plan: true and fill what/where/when.
npc_interactions: Track how NPCs/animals interact with ${userName}. delta: +0.5 friendly/kind, +1 life-saving/deeply bonding, -0.5 rude/hostile, -1 betrayal/attack. Only include NPCs who ACTIVELY interact in this scene. Omit if no NPC interactions.
community_updates: Twitter-style real-time Korean posts capturing what NPCs/animals are doing RIGHT NOW in this scene. Generate 1-3 posts (only for NPCs who are visibly active). Write like real Korean Twitter/X: no *asterisked actions*, just natural Korean sentences showing their current state/feeling. Match each character's voice/personality. Use @mentions, #hashtags. NEVER use Korean male-forum slang (ㅇㅇ/ㄴㄴ/팩트/ㅇㄱㄹㅇ/~노/~근/킹받네/디시체 등 금지). Omit if no NPCs are active.

Examples:
{"mood":"⚡","title":"고구마와 뒷담화의 현장","summary":"군견 Dex의 막사에서 ${userName}가 몰래 군고구마를 나눠먹으며 Ghost에 대한 불만을 털어놓던 중, 이를 엿들은 Ghost에게 현장을 들키고 만다.","promisePlace":null,"future_plan":{"has_plan":false},"npc_interactions":[{"name":"Dex","delta":0.5,"reason":"간식 나눠먹음"},{"name":"Ghost","delta":-0.5,"reason":"뒷담화 들킴"}]}
{"mood":"💕","title":"첫 심장소리를 들은 곳","summary":"${userName}와 TF141이 산부인과 진찰실을 점거하고 초음파 검사를 받았다. 모니터에 작은 심장 박동이 울리자 König의 손이 떨리기 시작했다.","promisePlace":"산부인과","future_plan":{"has_plan":true,"what":"2차 검진 및 초음파","where":"산부인과","when":"2주 뒤"},"npc_interactions":[{"name":"König","delta":1,"reason":"함께 초음파 감동"}]}
{"mood":"📅","title":"비밀 약속을 나눈 곳","summary":"노을이 물드는 옥상에서 Alejandro가 ${userName}의 손을 잡으며 '내일, 여기서'라고 속삭였다.","promisePlace":null,"future_plan":{"has_plan":true,"what":"비밀 만남","where":"옥상","when":"내일"},"npc_interactions":[{"name":"Alejandro","delta":1,"reason":"로맨틱 약속"}]}
${recentChat ? `\n[Recent conversation for tone & context]:\n${recentChat}\n` : ''}
[Current scene to summarize]:
${trimmed}${userCtx}`;

        const result = await callLLM(prompt, { maxTokens: 2048 });
        if (result) {
            const parsed = parseLLMJson(result);
            if (parsed?.mood && parsed?.summary) {
                evText = plainText(parsed.summary, 1500);
                evTitle = plainText(parsed.title || evText.substring(0, 15) + '...', 50);
                evMood = firstGrapheme(parsed.mood, '📝');
                const promisePlace = plainText(parsed.promisePlace, 60);
                parsed.promisePlace = promisePlace || null;
                dbg(`🤖 LLM Event: "${evTitle}" | "${evText}" (${evMood})`);
                dbg(`🗓️ LLM future_plan: ${JSON.stringify(parsed.future_plan || 'not present')}, promisePlace: ${parsed.promisePlace || 'null'}`);
                // ★ 약속 장소 자동 등록 (LLM이 이벤트에서 장소 추출 — 모든 무드)
                if (promisePlace && promisePlace.toLowerCase() !== 'null') {
                    try {
                        const pPlace = promisePlace;
                        if (pPlace.length >= 2 && pPlace.length <= 25 && !lm.findByNameExact(pPlace)) {
                            queueDetectedPlace(pPlace, {
                                source: 'event-ai', kind: 'planned', confidence: 0.7,
                                reason: '사용자가 켠 AI 이벤트 추출의 약속 장소 — 모델 출력 확인 필요',
                                snippet: evTitle, rpDate,
                            });
                        }
                    } catch(e) { dbg('⚠️ Promise place from LLM error:', e.message); }
                }
                // ★ 예정 일정 자동 등록 (future_plan 객체 — 분리된 구조)
                const fp = parsed.future_plan;
                if (fp?.has_plan && fp.what) {
                    // ★ where가 null이면 promisePlace를 대신 사용!
                    const safeWhat = plainText(fp.what, 300);
                    const safeWhere = plainText(fp.where, 60);
                    const safeWhen = plainText(fp.when, 80);
                    const rawWhere = safeWhere && safeWhere.toLowerCase() !== 'null' ? safeWhere : null;
                    const pp = promisePlace && promisePlace.toLowerCase() !== 'null' ? promisePlace : null;
                    const planWhere = rawWhere || pp;
                    const planWhen = safeWhen && safeWhen.toLowerCase() !== 'null' ? safeWhen : '';
                    if (!safeWhat) return;
                    let targetLocId = locId;
                    if (planWhere) {
                        let targetLoc = lm.findByNameExact(planWhere);
                        if (!targetLoc && planWhere.length >= 2 && planWhere.length <= 25) {
                            queueDetectedPlace(planWhere, {
                                source: 'event-ai', kind: 'planned', confidence: 0.7,
                                reason: 'AI가 일정 목적지로 제안 — 등록 전 확인 필요',
                                snippet: [planWhen, safeWhat].filter(Boolean).join(' · '), rpDate,
                            });
                        }
                        if (targetLoc) targetLocId = targetLoc.id;
                    }
                    const tLoc = lm.locations.find(l => l.id === targetLocId);
                    if (tLoc) {
                        if (!tLoc.events) tLoc.events = [];
                        const isDup = tLoc.events.some(e => e.isPlan && e.text === safeWhat);
                        if (!isDup) {
                            const planDate = _calcPlanDate(rpDate, planWhen);
                            tLoc.events.push({
                                text: safeWhat, title: safeWhat.substring(0, 20),
                                mood: '🗓️', isPlan: true, planWhen: planWhen, planDate,
                                timestamp: Date.now(), rpDate, source: 'auto'
                            });
                            await lm.updateLocation(targetLocId, { events: tLoc.events });
                            dbg(`🗓️ Future plan saved`)
                        }
                    }
                    pi.inject(); if (ui?.panelVisible) ui.refresh();
                }
                // ★ fallback: plans 배열도 호환 (기존 응답 지원)
                else if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
                    for (const plan of parsed.plans) {
                        if (!plan.what) continue;
                        const planWhat = plainText(plan.what, 300);
                        const rawPlanWhen = plainText(plan.when, 80);
                        const planWhen = rawPlanWhen && rawPlanWhen.toLowerCase() !== 'null' ? rawPlanWhen : '';
                        if (!planWhat) continue;
                        const tLoc = lm.locations.find(l => l.id === locId);
                        if (tLoc) {
                            if (!tLoc.events) tLoc.events = [];
                            const isDup = tLoc.events.some(e => e.isPlan && e.text === planWhat);
                            if (!isDup) {
                                const planDate = _calcPlanDate(rpDate, planWhen);
                                tLoc.events.push({
                                    text: planWhat, title: planWhat.substring(0, 20),
                                    mood: '🗓️', isPlan: true, planWhen: planWhen, planDate,
                                    timestamp: Date.now(), rpDate, source: 'auto'
                                });
                                await lm.updateLocation(locId, { events: tLoc.events });
                                dbg(`🗓️ Plan (legacy): "${plan.what}" when="${planWhen}"`)
                            }
                        }
                    }
                    pi.inject(); if (ui?.panelVisible) ui.refresh();
                }
                // ★ promisePlace 잡혔는데 plans 비어있으면 → 자동 plan 생성
                if (parsed.promisePlace && parsed.promisePlace !== 'null' && parsed.promisePlace.toLowerCase() !== 'null') {
                    const pp = promisePlace;
                    const hasPlansForPlace = Array.isArray(parsed.plans) && parsed.plans.some(p => plainText(p?.where, 60).toLowerCase() === pp.toLowerCase());
                    if (!hasPlansForPlace) {
                        const ppLoc = lm.findByNameExact(pp);
                        if (ppLoc) {
                            if (!ppLoc.events) ppLoc.events = [];
                            const isDup = ppLoc.events.some(e => e.isPlan && e.text?.includes(pp));
                            if (!isDup) {
                                ppLoc.events.push({
                                    text: `${pp} 방문 예정`, title: `${pp} 방문`,
                                    mood: '🗓️', isPlan: true, planWhen: '', planWhere: null,
                                    timestamp: Date.now(), rpDate, source: 'auto'
                                });
                                await lm.updateLocation(ppLoc.id, { events: ppLoc.events });
                                dbg(`🗓️ Auto-plan from promisePlace: "${pp}"`);
                            }
                        }
                    }
                }
                // ★ NPC 호감도 자동 업데이트 (npc_interactions)
                if (Array.isArray(parsed.npc_interactions)) {
                    for (const ni of parsed.npc_interactions) {
                        if (!ni?.name || typeof ni.delta !== 'number') continue;
                        const npcName = plainText(ni.name, 60);
                        if (!npcName) continue;
                        const delta = Math.max(-1, Math.min(1, ni.delta));
                        await lm.updateNpcAffinity(locId, npcName, delta);
                    }
                    if (ui?.panelVisible) ui.refresh();
                }
                // ★ 💬 커뮤니티 실시간 피드 자동 업데이트 (v0.6.0 NEW — 양방향 연동!)
                if (Array.isArray(parsed.community_updates) && parsed.community_updates.length) {
                    for (const cu of parsed.community_updates.slice(0, 3)) {
                        if (!cu?.name || !cu?.text) continue;
                        const safeName = plainText(cu.name, 60);
                        const safeText = plainText(cu.text, 800);
                        if (!safeName || !safeText) continue;
                        // 멘션/해시태그 추출
                        const mentions = (safeText.match(/@([A-Za-z가-힣0-9_]+)/g) || []).map(m => m.substring(1));
                        const hashtags = (safeText.match(/#([A-Za-z가-힣0-9_]+)/g) || []).map(h => h.substring(1));
                        await lm.addCommunityPost(locId, {
                            name: safeName,
                            avatar: firstGrapheme(cu.avatar, '👤'),
                            type: ['npc', 'animal'].includes(cu.type) ? cu.type : 'npc',
                            mood: plainText(cu.mood, 30),
                            moodLabel: plainText(cu.moodLabel, 40),
                            text: safeText,
                            mentions,
                            hashtags,
                            likes: 0,
                            rpDate,
                        });
                    }
                    if (ui?.panelVisible) ui.refresh();
                }
            }
        }
    } catch (e) {
        dbg(`⚠️ LLM event extraction failed, falling back to regex: ${e.message}`);
    }

    // ★ 폴백: LLM 실패 시 regex 추출
    if (!evText) {
        const ev = _extractEventSummary(narrativeText, '');
        if (!ev) return;
        evText = ev.text;
        evTitle = ev.text.length > 15 ? ev.text.substring(0, 15) + '...' : ev.text;
        evMood = ev.mood;
        dbg(`📝 Regex Event: "${evTitle}" | "${evText}" (${evMood})`);
        // ★ LLM 실패 시 엄격한 regex로 plans 추출 (시간표현 + 행동동사 동시 필요)
        const planSentences = narrativeText.replace(/<[^>]*>/g, '').replace(/<memo>[\s\S]*?<\/memo>/g, '').split(/[.!?。]+/).filter(s => s.trim().length > 10);
        const timeRx = /(?:내일|모레|일주일|보름|다음\s*주|다음\s*달|(\d+)\s*(?:주|달|개월|일)\s*(?:뒤|후)|이번\s*주말|tomorrow|next\s+(?:week|month)|in\s+(?:two|three|\d+)\s+(?:weeks?|months?|days?)|come\s+back|T\+\d+|at\s+\d{4}\b|by\s+\d{4}\b|\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)|오전|오후|저녁|아침)/i;
        const actionRx = /(?:가자|가기로|오자|만나|검진|재검|진료|예약|방문|장보기|이사|옮기|go\s+(?:to|back)|visit|return|come\s+back|check[- ]?up|appointment|see\s+(?:you|the\s+doctor)|move\s+(?:the|our|to)|transfer|pack|wheels\s+up|gear\s+up|이동|출발|떠나)/i;
        let regexPlanAdded = false;
        for (const sent of planSentences) {
            if (regexPlanAdded) break; // 최대 1건만
            const hasTime = timeRx.exec(sent);
            const hasAction = actionRx.test(sent);
            if (hasTime && hasAction) {
                const when = hasTime[0].trim();
                const tLoc = lm.locations.find(l => l.id === locId);
                if (tLoc) {
                    if (!tLoc.events) tLoc.events = [];
                    const isDup = tLoc.events.some(e => e.isPlan && e.planWhen === when);
                    if (!isDup) {
                        const planDate = _calcPlanDate(rpDate, when);
                        tLoc.events.push({
                            text: `예정된 방문`, title: '예정된 방문',
                            mood: '🗓️', isPlan: true, planWhen: when, planDate,
                            timestamp: Date.now(), rpDate, source: 'regex'
                        });
                        await lm.updateLocation(locId, { events: tLoc.events });
                        dbg(`🗓️ Strict Regex Plan: when="${when}" date="${planDate}"`);
                        regexPlanAdded = true;
                    }
                }
            }
        }
    }

    evText = plainText(evText, 1500);
    evTitle = plainText(evTitle || evText.substring(0, 30), 60);
    evMood = firstGrapheme(evMood, '📝');
    if (!evText) return;

    if (!loc.events) loc.events = [];

    // ★ 재생성/스와이프 중복 방지 — 최근 3분 이내 유사 이벤트면 교체
    const now = Date.now();
    let replaced = false;
    if (loc.events.length > 0) {
        const last = loc.events[loc.events.length - 1];
        const timeDiff = now - (last.timestamp || 0);
        if (timeDiff < 180000) { // 3분 이내
            // 단어 유사도 체크
            const wordsA = new Set((last.text || '').split(/\s+/).filter(w => w.length > 1));
            const wordsB = new Set((evText || '').split(/\s+/).filter(w => w.length > 1));
            if (wordsA.size > 0 && wordsB.size > 0) {
                let overlap = 0;
                for (const w of wordsB) { if (wordsA.has(w)) overlap++; }
                const sim = overlap / Math.max(wordsA.size, wordsB.size);
                if (sim > 0.35) {
                    // 교체! (재생성/스와이프로 인한 중복)
                    dbg(`🔄 Event dedup: ${(sim*100).toFixed(0)}% similar, replacing last event`);
                    loc.events[loc.events.length - 1] = { text: evText, title: evTitle, mood: evMood, timestamp: now, rpDate, source };
                    replaced = true;
                }
            }
        }
    }
    if (!replaced) {
        loc.events.push({ text: evText, title: evTitle, mood: evMood, timestamp: now, rpDate, source });
    }
    if (loc.events.length > 20) loc.events = loc.events.slice(-20);
    await lm.updateLocation(locId, { events: loc.events });
    _lastEventTime = now;
    _lastEventLocId = locId;
    // 알림 (오버레이 → 읽기 전용)
    try {
        ui.showEventNotify(loc.name, { text: evText, tag: evMood }, locId);
    } catch(e) {
        dbg(`⚠️ Notify failed: ${e.message}`);
    }
    // ★ 팝오버 열려있으면 이벤트 목록 자동 갱신
    try {
        const openId = $('#wt-popover').attr('data-id');
        if (openId === locId && $('#wt-popover').is(':visible')) {
            ui._updEventsList(locId);
        }
    } catch(e) {}
    dbg(`${evMood} Event: "${evText}" @ ${loc.name} (${source})`);
}

// ========== 예정 일정 regex 추출 (LLM 없이도 작동) ==========
function _extractPlansRegex(text) {
    const clean = text.replace(/<[^>]*>/g, '').replace(/```[\s\S]*?```/g, '').replace(/<memo>[\s\S]*?<\/memo>/g, '').trim();
    const plans = [];

    // 한국어 패턴
    const koPats = [
        // "2주 뒤에 산부인과" / "다음달에 검진"
        /(?:(\d+)\s*(?:주|달|개월|일)\s*(?:뒤|후|뒤에|후에))\s*(?:에?\s*)?(.{1,15}?)(?:에서|에|으로|로)?\s*(?:가자|가기|오자|오기|만나|검진|진료|방문|재검|예약)/g,
        // "내일/모레/다음주에 ~"
        /(?:내일|모레|다음\s*주|다음\s*달|이번\s*주말)\s*(?:에?\s*)?(.{1,15}?)(?:에서|에|으로|로)?\s*(?:가자|가기|오자|만나|검진|방문|약속|예약|장보기|쇼핑)/g,
        // "~월 ~일에 클리닉"
        /(\d{1,2}월\s*\d{1,2}일)\s*(?:에?\s*)?(.{1,15}?)(?:에서|에)?\s*(?:가자|오자|만나|예약|방문|검진)/g,
    ];

    // 영어 패턴
    const enPats = [
        // "in two weeks" / "in 14 days" / "in a month"
        /(?:come\s+back|return|visit|go\s+back|be\s+back|see\s+you|check[- ]?up)\s+(?:in|after)\s+([\w\s]{2,20}?)(?:[.,!?]|$)/gi,
        // "every month" / "every two weeks" / "every appointment" / "every single time"
        /(every\s+(?:\w+\s+)?(?:week|month|day|year|appointment|time|visit|check[- ]?up)s?)\b/gi,
        // "next Tuesday" / "next month" / "next week"
        /(next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year))\b/gi,
        // "on January 3rd" / "on the 3rd"
        /(?:on\s+(?:the\s+)?)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/gi,
        // "T+14 DAYS" / "14 days from now"
        /(?:T\+)?(\d+)\s*(?:days?|weeks?|months?)\s*(?:from\s+now|later|after)?/gi,
        // ★ 단독 시간 표현: "Two weeks." / "In two weeks" (대화 문맥에서)
        /(?:in\s+)?(two|three|four|five|six|seven|eight|nine|ten)\s+(weeks?|months?|days?)\b/gi,
    ];

    // 한국어 패턴 실행
    for (const pat of koPats) {
        let m;
        pat.lastIndex = 0;
        while ((m = pat.exec(clean)) !== null) {
            const groups = m.slice(1).filter(Boolean);
            if (groups.length >= 2) {
                const when = groups[0].trim();
                const where = groups[1].trim();
                if (where.length >= 2 && where.length <= 15) {
                    plans.push({ what: `${where} 방문 예정`, where, when });
                }
            } else if (groups.length === 1) {
                plans.push({ what: `예정된 일정`, where: null, when: groups[0].trim() });
            }
        }
    }

    // 영어 패턴 실행
    for (const pat of enPats) {
        let m;
        pat.lastIndex = 0;
        while ((m = pat.exec(clean)) !== null) {
            const when = m[1]?.trim();
            if (when && when.length >= 2 && when.length <= 30) {
                // 숫자+기간이면 "N days/weeks" 형태
                const numMatch = when.match(/^(\d+)\s*(days?|weeks?|months?)/i);
                const whenText = numMatch ? `${numMatch[1]} ${numMatch[2]} later` : when;
                plans.push({ what: `Scheduled appointment`, where: null, when: whenText });
            }
        }
    }

    // 중복 제거
    const unique = [];
    const seen = new Set();
    for (const p of plans) {
        const key = `${p.when}|${p.where || ''}`;
        if (!seen.has(key)) { seen.add(key); unique.push(p); }
    }
    return unique;
}

// ========== 이벤트 요약 추출 (감정/사건 키워드 + 타입 분류) ==========
function _extractEventSummary(text, locName) {
    // HTML만 제거 (대사는 유지! RP 감정은 대사 안에 있음)
    const clean = stripNonNarrativeMetadata(text).replace(/<[^>]*>/g, '').trim();
    if (clean.length < 20) return null;

    // 메타데이터/시스템 텍스트 필터 (이벤트 아님)
    const metaFilter = /^[-*]\s*(Time|Date|Location|Characters|Outfit|Items|Scene|Status|DATE CHANGE|날짜|시간|장소|의상|아이템)[\s:]/i;

    const patterns = [
        // 💕 감정/관계/로맨스 (memory)
        { rx: /키스|kiss|포옹|hug|안[았겼]|품[에었]|사랑|love|고백|confess|첫만남|first met/i, type: 'memory', mood: '💕' },
        { rx: /속삭|whisper|윙크|wink|숨결|breath|두근|심장.*뛰|heart.*beat|heart.*pound|떨[리렸]|tremble|shiver/i, type: 'memory', mood: '💕' },
        { rx: /볼.*빨개|얼굴.*달아|blush|손[을를].*잡|hold.*hand|눈[을를].*맞|eye.*meet|이마.*닿|forehead/i, type: 'memory', mood: '💕' },
        { rx: /끌어안|embrace|기대[어었]|lean|쓰다듬|caress|어루만|stroke|입술|lip|볼[에].*입|cheek/i, type: 'memory', mood: '💕' },
        { rx: /손가락.*깍지|finger.*interlock|머리.*쓸어|귓[가속]|ear|향기|scent|체온|온기|warmth/i, type: 'memory', mood: '💕' },
        // 💕 영어 로맨스 확장 (AI가 자주 쓰는 묘사)
        { rx: /mouth.*devour|devour.*mouth|cupped.*face|traced.*jaw|passion|intimate|desire|sensual|breathless|panting/i, type: 'memory', mood: '💕' },
        { rx: /pressed.*against|pulled.*close|leaned.*in|neck.*kiss|collarbone|nuzzle|nibble|tongue|lick/i, type: 'memory', mood: '💕' },
        { rx: /moaned|gasped|arched|shudder|pulse.*rac|heart.*rac|chest.*tight|stomach.*flutter/i, type: 'memory', mood: '💕' },
        { rx: /intertwine|entangle|straddle|pin.*down|beneath|above.*hover|grind|groan/i, type: 'memory', mood: '💕' },
        // 😢 슬픔
        { rx: /울[었다]|눈물|cry|tears|슬[퍼펐]|sad|위로|comfort|그리[워웠]|miss/i, type: 'memory', mood: '😢' },
        // 😊 기쁨 (강한 것만)
        { rx: /행복|happy|환희|기[뻐쁨]|joy|축하|celebrat/i, type: 'memory', mood: '😊' },
        // ⚡ 사건 (incident)
        { rx: /싸[우웠움]|fight|충돌|clash|화[가났]|anger|분노|rage|배신|betray/i, type: 'incident', mood: '⚡' },
        { rx: /발견|discover|비밀|secret|숨[겼긴]|hide|도망|escape|추[격적]|chase/i, type: 'incident', mood: '🔍' },
        { rx: /부상|injur|사고|accident|피[가를]|blood|쓰러[졌진]|collapse|치료|heal/i, type: 'incident', mood: '🩹' },
        { rx: /결투|duel|전투|battle|공격|attack|방어|defend|훈련|train/i, type: 'incident', mood: '⚔️' },
        { rx: /비명|scream|절규|shriek|공포|terror|두려[움운]|fear|confrontation/i, type: 'incident', mood: '⚡' },
        // 📅 약속/미래 (promise)
        { rx: /약속|promise|다음[에번]|next time|만나[자기]|내일|tomorrow|기다[려릴]|같이.*가|데이트|date/i, type: 'promise', mood: '📅' },
        // 🎁 특별 이벤트
        { rx: /선물|gift|편지|letter|파티|party|축하|celebrat|생일|birthday|기념/i, type: 'memory', mood: '🎁' },
        { rx: /전화|call|연락|contact|메시지|message/i, type: 'memory', mood: '📞' },
    ];

    const sentences = clean.split(/[.!?。！？\n]+/).filter(s => s.trim().length > 8);

    for (const s of sentences) {
        const trimmed = s.trim();
        // 메타데이터 문장 스킵
        if (metaFilter.test(trimmed)) continue;
        for (const p of patterns) {
            if (p.rx.test(trimmed)) {
                let summary = trimmed;
                if (summary.length > 500) summary = summary.substring(0, 500) + '...';
                return { text: summary, type: p.type, mood: p.mood };
            }
        }
    }

    // 키워드 없으면 null (일상 = 기록 안 함!)
    return null;
}
