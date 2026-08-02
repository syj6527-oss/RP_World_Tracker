// 🐶 World Tracker — prompt-injector.js (v0.3.0 Enhanced)

import { extension_settings, getContext } from '../../../extensions.js';
import { setExtensionPrompt } from '../../../../script.js';
import { EXTENSION_NAME, PROMPT_KEY } from './index.js';
import { redactOutboundSecrets } from './secret-redaction.js';

const MAX_INJECTION_CHARS = 12000;

function getFn() {
    try {
        // 방법 1: script.js에서 직접 import (최신 SillyTavern)
        if (typeof setExtensionPrompt === 'function') return setExtensionPrompt;
        // 방법 2: getContext()
        const ctx = getContext();
        if (typeof ctx?.setExtensionPrompt === 'function') return ctx.setExtensionPrompt;
        // 방법 3: window 전역 (구버전)
        if (typeof window.setExtensionPrompt === 'function') return window.setExtensionPrompt;
    } catch (_) {}
    return null;
}

// 장소 타입 자동 감지
function _detectLocType(name) {
    const lo = (name || '').toLowerCase();
    if (/마트|mart|편의|convenience|가게|shop|store|grocery|supermarket/i.test(lo)) return 'shop/mart';
    if (/카페|cafe|coffee|커피/i.test(lo)) return 'cafe';
    if (/집|home|house|숙소|기숙|dorm|quarters/i.test(lo)) return 'home/quarters';
    if (/학교|school|학원|academy/i.test(lo)) return 'school';
    if (/체육|gym|운동|fitness|arena|훈련|사격|range|training/i.test(lo)) return 'training facility';
    if (/공원|park|정원|garden|광장/i.test(lo)) return 'park/outdoor';
    if (/술집|bar|pub|tavern|주점/i.test(lo)) return 'bar/pub';
    if (/식당|restaurant|음식|레스토랑/i.test(lo)) return 'restaurant';
    if (/병원|hospital|의원|clinic|medical/i.test(lo)) return 'medical';
    if (/도서|library|서점|서재/i.test(lo)) return 'library';
    if (/역|station|지하철|버스|bus/i.test(lo)) return 'transit';
    if (/성|castle|궁|palace|요새|fortress|base|막사|barracks/i.test(lo)) return 'military/base';
    if (/숲|forest|산|mountain/i.test(lo)) return 'nature';
    if (/해변|beach|바다|sea|강|river|호수|lake/i.test(lo)) return 'waterfront';
    if (/사무|office|본부|hq|headquarter/i.test(lo)) return 'office/HQ';
    if (/골목|거리|길|street|alley|road/i.test(lo)) return 'street';
    return null;
}

export class PromptInjector {
    constructor(lm) { this.lm = lm; }

    // v0.9.3: 장소 RP 반영 모드 (off/director/character)
    //   명시값 없으면: 방문한 적 있으면 character(캐릭터가 앎), 없으면 off(내 메모)
    _mode(l) {
        if (l && (l.injectMode === 'off' || l.injectMode === 'director' || l.injectMode === 'character')) return l.injectMode;
        return ((l?.visitCount || 0) > 0) ? 'character' : 'off';
    }

    inject() {
        const t = this.generate(); const fn = getFn();
        try {
            if (fn) {
                fn(PROMPT_KEY, t||'', 1, 0);
            }
        }
        catch (_) {}
    }
    clear() { const fn=getFn(); try{if(fn)fn(PROMPT_KEY,'',1,0)}catch(_){} }

    generate() {
        const s = extension_settings[EXTENSION_NAME];
        if (s?.aiInjection !== true || !this.lm.locations.length) return '';
        const cur = this.lm.locations.find(l => l.id === this.lm.currentLocationId);
        if (!cur) return '';

        const L = ['[🐾 Paw Map]'];
        L.push('⚙️ Use this location data to maintain spatial consistency and reference past events naturally in your narration.');

        // 1. 장소 이름 (+ 서브로케이션)
        const subLocId = this.lm.currentSubLocationId;
        const subLoc = subLocId ? this.lm.locations.find(l => l.id === subLocId) : null;
        L.push(`📍 Scene: ${cur.name}${subLoc ? ' > ' + subLoc.name : ''}`);

        // 2. 주소
        if (cur.address) L.push(`📍 Address: ${cur.address}`);

        // 3. 장소 타입
        const locType = _detectLocType(cur.name);
        if (locType) L.push(`🏷️ Type: ${locType}`);

        // 4. 방문 통계 + 첫 방문일
        if (cur.visitCount > 0) {
            let visitStr = cur.visitCount === 1 ? 'First visit' : `Visit #${cur.visitCount}`;
            if (cur.rpFirstVisited) visitStr += ` (since ${cur.rpFirstVisited})`;
            else if (cur.firstVisited) {
                const d = new Date(cur.firstVisited);
                visitStr += ` (since ${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()})`;
            }
            L.push(`📊 ${visitStr}`);
        }

        // 5. 상태
        if (cur.status) L.push(`🌤️ Status: ${cur.status}`);

        // 6~7. v0.9.5: 💭 메모=항상 비공개(주입 안 함) / 🎬 반영 노트(aiNotes)=모드 따라 주입
        const curMode = this._mode(cur);
        if (curMode !== 'off' && cur.aiNotes) {
            L.push(curMode === 'director'
                ? `🎬 [OOC director note — the character is NOT aware of this]: ${cur.aiNotes}`
                : `📋 Notes (character knows): ${cur.aiNotes}`);
        }

        // 8. 이벤트 — 서브 장소 있으면 서브 이벤트 우선
        const evTarget = subLoc || cur;
        const evs = this._events(evTarget);
        if (evs) L.push(`📝 Memories${subLoc ? ' (' + subLoc.name + ')' : ''}:\n${evs}`);

        // 8.5. 서브 장소 목록 (있으면)
        const subs = this.lm.getSubLocations(cur.id);
        if (subs.length) {
            const subList = subs.map(s => `${s.name}(${s.visitCount||0})`).join(', ');
            L.push(`🏠 Rooms: ${subList}`);
        }

        // 8.6. 터줏대감 — v0.9.5: 실재 엔티티로 등장 주입 (사람/동물 분리), 🔒 장소는 제외
        if (curMode !== 'off' && cur.npcs?.length) {
            const fmt = (n) => {
                const role = n.role ? `(${n.role})` : '';
                const aff = n.affinity ? ` ❤️${n.affinity}/5` : '';
                const bio = n.bio ? ` — ${n.bio}` : '';
                const rel = n.relationship ? ` [${n.relationship}]` : '';
                return `${n.name}${role}${aff}${bio}${rel}`;
            };
            const animals = cur.npcs.filter(n => n.type === 'animal');
            const people = cur.npcs.filter(n => n.type !== 'animal');
            if (people.length) L.push(`👥 Resident regulars of this place (terjutdaegam — fixtures here): ${people.map(fmt).join(' | ')}\n  → These are part of this place's texture. Feature one ONLY when it fits the CURRENT scene naturally — right area, plausible for indoors/outdoors, time of day. If the scene is indoors (a room, villa, hotel interior) or the creature wouldn't realistically be there, keep them as distant ambient background or leave them out entirely. NEVER force an outdoor animal into an indoor scene — immersion comes first.`);
            if (animals.length) L.push(`🐾 Resident animal(s) of this place (they live/hang around here): ${animals.map(fmt).join(' | ')}\n  → When a scene is here, this animal physically shows up in it — approaches, lingers, reacts to the characters. Make it tangibly present.`);
        }

        // 8.7. 💬 실시간 커뮤니티 — v0.9.5: 이 장소 소문/분위기 (🔒 장소 제외)
        //   v0.9.19: 현재 장소에 "반영(핀)"한 커뮤니티가 있으면 자동 buzz 생략 → 유저가 고른 것만 반영
        const _commPins = (cur._pins || []).filter(p => p.kind === 'community');
        if (curMode !== 'off' && cur.community?.length && !_commPins.length) {
            const recent = cur.community.slice(0, 4);
            const liveStatus = recent.map(p => {
                // 텍스트에서 액션/감정 추출
                const actions = (p.text.match(/\*([^*]+)\*/g) || []).map(s => s.replace(/\*/g, ''));
                const cleanText = p.text.replace(/\*[^*]+\*/g, '').replace(/#\S+/g, '').replace(/\s+/g, ' ').trim().substring(0, 60);
                const action = actions[0] ? ` (${actions[0]})` : '';
                return `${p.name}${action}: "${cleanText}"`;
            }).join('\n  ');
            L.push(`🗣️ Local buzz about this place (recent rumors/atmosphere — weave into the scene's background, not as something the character literally read):\n  ${liveStatus}`);
        }

        // 9. 마지막 이동
        const last = this._last(); if (last) L.push(`🚶 Last move: ${last}`);

        // 10. 주변 장소 (주소 포함)
        const near = this._near(cur);
        if (near) L.push(`📌 Nearby:\n${near}`);

        // 11. 세계관 지역 요약
        const totalLocs = this.lm.locations.length;
        if (totalLocs > 1) {
            const region = this._guessRegion();
            if (region) L.push(`🌍 World: ${totalLocs} places around ${region}`);
        }

        // ★ v0.9.3: 현재 장소가 아니어도 "반영" 켠 장소 주입 (이벤트 예정 장소 등)
        //   character → 캐릭터가 존재를 앎 / director → OOC 연출 지시 (캐릭터는 의도 모름)
        const flagKnown = [], flagDir = [];
        for (const l of this.lm.locations) {
            if (l.id === cur.id || l.id === subLocId) continue;
            const m = this._mode(l);
            if (m === 'character') flagKnown.push(l);
            else if (m === 'director') flagDir.push(l);
        }
        if (flagKnown.length) {
            const list = flagKnown.slice(0, 8).map(l => {
                const addr = l.address ? ` (${l.address.split(',').slice(0,2).join(',').trim()})` : '';
                return `${l.name}${l.aiNotes ? ' — ' + l.aiNotes : ''}${addr}`;
            }).join('\n  ');
            L.push(`🗺️ Other known places (the character is aware these exist):\n  ${list}`);
        }
        if (flagDir.length) {
            const list = flagDir.slice(0, 8).map(l => `${l.name}${l.aiNotes ? ' — ' + l.aiNotes : ''}`).join('\n  ');
            L.push(`🎬 [OOC narrative direction — steer the story toward these naturally; the character is NOT consciously aware of the user's intent]:\n  ${list}`);
        }

        // ★ v0.9.4 → v0.9.10: 유저가 핀한 리뷰/커뮤니티 — 현재 장소든 아니든 핀한 건 전부 반영
        const pinLines = [];
        for (const loc of this.lm.locations) {
            if (!loc._pins?.length) continue;
            const here = loc.id === cur.id;
            loc._pins.slice(0, 12).forEach(p => {
                const tag = p.kind === 'review' ? 'review' : 'buzz';
                const t = (p.text || '')
                    .replace(/<br\s*\/?>/gi, ' ')
                    .replace(/<img[^>]*>/gi, '')
                    .replace(/<[^>]+>/g, '')          // 나머지 HTML 태그
                    .replace(/https?:\/\/\S+/g, '')   // 남은 URL
                    .replace(/#[^\s#]+/g, '')          // 해시태그
                    .replace(/\*[^*]+\*/g, '')         // *액션 서술*
                    .replace(/\s+/g, ' ').trim().slice(0, 140);
                pinLines.push(`[${tag}${here ? '' : ' @' + loc.name}] ${p.who || '?'}: "${t}"`);
            });
        }
        if (pinLines.length) {
            L.push(`📌 User-pinned — reflect these in your next response (weave naturally into the scene):\n  ${pinLines.slice(0, 16).join('\n  ')}`);
        }

        L.push('[/Paw Map]');
        // This prompt goes to the normal chat provider rather than callLLM(), so
        // apply the same last-mile secret masking here as well.
        const prompt = redactOutboundSecrets(L.join('\n'));
        if (prompt.length <= MAX_INJECTION_CHARS) return prompt;
        const suffix = '\n[Map context truncated to limit input-token growth]\n[/Paw Map]';
        return prompt.slice(0, MAX_INJECTION_CHARS - suffix.length) + suffix;
    }

    _mem(loc) {
        const s = extension_settings[EXTENSION_NAME]; const m = loc.memo||'';
        if (s.memoryMode==='perfect') return m;
        if (!loc.lastVisited) return m;
        const days = (Date.now()-loc.lastVisited)/86400000;
        if (days <= (s.memorySummaryDays||7)) return m;
        return m.length > 50 ? m.substring(0,50)+'... (faded)' : m+' (faded)';
    }

    _events(loc) {
        const evs = (loc.events || []).filter(e => e.source !== 'move');
        if (!evs.length) return null;
        const s = extension_settings[EXTENSION_NAME];
        const recent = evs.slice(-5);
        return recent.map(ev => {
            const mood = ev.mood || '📝';
            let text = String(ev.text || ev.title || '').slice(0, 600);
            let dateStr = '';
            if (ev.rpDate) {
                dateStr = ` [${ev.rpDate}]`;
            } else if (ev.timestamp) {
                const days = Math.floor((Date.now() - ev.timestamp) / 86400000);
                if (days === 0) dateStr = ' [today]';
                else if (days === 1) dateStr = ' [yesterday]';
                else if (days < 7) dateStr = ` [${days}d ago]`;
                else dateStr = ` [${Math.floor(days/7)}w ago]`;
            }
            if (s.memoryMode !== 'perfect' && ev.timestamp) {
                const days = (Date.now() - ev.timestamp) / 86400000;
                if (days > 30) text = ev.title ? `${ev.title}... (vague memory)` : text.substring(0, 30) + '... (faded)';
                else if (days > 7) text = ev.title ? `${ev.title} — ${text.substring(0, 40)}...` : text.substring(0, 50) + '...';
            }
            return `- ${mood} ${text}${dateStr}`;
        }).join('\n');
    }

    _last() {
        if (!this.lm.movements.length) return null;
        const l = [...this.lm.movements].sort((a,b)=>b.timestamp-a.timestamp)[0];
        const f=this.lm.locations.find(x=>x.id===l.fromId), t=this.lm.locations.find(x=>x.id===l.toId);
        if (!f||!t) return null;
        let r=`${f.name} → ${t.name}`;
        if(l.distance) r+=` (${l.distance})`;
        else {
            const dist = this.lm.getDistanceBetween(f.id, t.id);
            if (dist?.distanceText) r += ` (${dist.distanceText})`;
        }
        return r;
    }

    _near(cur) {
        const n=[];
        for(const d of (this.lm.distances||[]).filter(distance => distance._manual === true)){
            let o=d.fromId===cur.id?d.toId:d.toId===cur.id?d.fromId:null;
            if(!o)continue; const loc=this.lm.locations.find(l=>l.id===o);
            if(!loc) continue;
            if (this._mode(loc) === 'off') continue; // v0.9.3: 반영 끈 장소는 주변 목록에서도 숨김
            let entry = `- ${loc.name} (${d.distanceText || this._levelLabel(d.level)})`;
            if (loc.address) {
                const short = loc.address.split(',').slice(0, 2).join(',').trim();
                entry += ` — ${short}`;
            }
            n.push(entry);
        }
        return n.length ? n.slice(0,5).join('\n') : null;
    }

    _guessRegion() {
        const addressed = this.lm.locations.filter(l => l.address);
        if (!addressed.length) return null;
        const parts = {};
        for (const loc of addressed) {
            const chunks = loc.address.split(',').map(s => s.trim()).filter(s => s.length > 2 && !/^\d+$/.test(s));
            for (const chunk of chunks.slice(-2)) {
                parts[chunk] = (parts[chunk] || 0) + 1;
            }
        }
        const sorted = Object.entries(parts).sort((a, b) => b[1] - a[1]);
        if (sorted.length && sorted[0][1] >= 2) return sorted[0][0];
        if (sorted.length) return sorted[0][0];
        return null;
    }

    _levelLabel(level) {
        const labels = {1:'바로 옆',2:'매우 가까움',3:'가까움',4:'도보 5분',5:'도보권',6:'도보 15분+',7:'대중교통',8:'차량 필요',9:'먼 거리',10:'다른 지역'};
        return labels[level] || '도보권';
    }
}
