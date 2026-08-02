// 🐶 World Tracker — map-renderer.js (v0.3.0-beta hotfix8)
// 목업 v4.1 디자인 이식: Hub 기반 + rect 그리드 + ㄱ/ㄴ/T 건물 + 카메라 분리

export class MapRenderer {
    constructor(container, lm) {
        this.container = container; this.lm = lm;
        this.svg = null; this._wasDrag = false; this._movingNodeId = null;
        this.onLocationClick = null; this.onMoveRequest = null;
        this.vb = { x: 0, y: 0, w: 500, h: 500 };
        this._pinch = null; this._pan = null;
        this._cityBgEl = null;       // Hub별 배경 캐시
        this._cityHubKey = null;     // 현재 생성된 Hub 식별자
        this._regenCounter = 0;       // 재생성 카운터 (매번 다른 맵)
        this._pinPositions = new Map();
        this._init();
    }
    _srand(s){return()=>{s|=0;s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};}
    _hashStr(s){let h=0;for(let i=0;i<s.length;i++){h=((h<<5)-h+s.charCodeAt(i))|0;}return Math.abs(h);}

    // 핀 좌표는 Location DB에도 저장되며, 보조 캐시는 현재 세션 메모리에만 둔다.
    _savePinPos(locId, x, y) { this._pinPositions.set(String(locId), { x, y }); }
    _loadPinPos(locId) { return this._pinPositions.get(String(locId)) || null; }
    _clearPinPos(locId) { this._pinPositions.delete(String(locId)); }

    _init() {
        if (!this.container) return;
        this.container.querySelectorAll('svg.wt-map-svg').forEach(el => el.remove());
        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svg.setAttribute('class', 'wt-map-svg');
        this.svg.setAttribute('width', '100%');
        const h = this.container.offsetHeight || this.container.clientHeight || 320;
        this.svg.setAttribute('height', Math.max(h, 320) + 'px');
        this.svg.style.minHeight = '320px';
        this._applyVB();
        this.container.appendChild(this.svg);
        this.svg.addEventListener('mousedown', e => this._onDown(e));
        this.svg.addEventListener('mousemove', e => this._onMove(e));
        this.svg.addEventListener('mouseup', () => this._onUp());
        this.svg.addEventListener('mouseleave', () => this._onUp());
        this.svg.addEventListener('wheel', e => { e.preventDefault(); this._zoom(e.deltaY > 0 ? 1.1 : 0.9, e); }, { passive: false });
        this.svg.addEventListener('touchstart', e => this._touchStart(e), { passive: false });
        this.svg.addEventListener('touchmove', e => this._touchMove(e), { passive: false });
        this.svg.addEventListener('touchend', e => this._touchEnd(e));
    }
    _applyVB() { this.svg.setAttribute('viewBox', `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`); }

    invalidateCity() { this._cityBgEl = null; this._cityHubKey = null; this._regenCounter = (this._regenCounter || 0) + 1; }

    // 핀 클릭 → ViewBox만 이동 + 팝업 카드
    recenterOn(locId) {
        const loc = this.lm.locations.find(l => l.id === locId);
        if (!loc) return;
        // 같은 핀 → 토글, 다른 핀 → 교체
        this._popupLocId = (this._popupLocId === locId) ? null : locId;
        this.vb.x = loc.x - this.vb.w / 2;
        this.vb.y = loc.y - this.vb.h / 2;
        this._vbManual = true;
        this.render();
    }

    // 팝업 카드 닫기
    closePopup() { this._popupLocId = null; this._removePopup(); }

    // ================================================================
    //  RENDER (B8: debounce 적용)
    // ================================================================
    _renderTimer = null;
    _rendering = false;
    render() {
        if (this._rendering) return;
        if (this._renderTimer) clearTimeout(this._renderTimer);
        this._renderTimer = setTimeout(() => this._doRender(), 16);
    }
    _doRender() {
        this._rendering = true;
        try { this._renderInner(); } finally { this._rendering = false; }
    }
    _renderInner() {
        if (!this.svg) return;
        if (this.container) {
            const h = this.container.offsetHeight || this.container.clientHeight || 320;
            this.svg.setAttribute('height', Math.max(h, 320) + 'px');
        }
        if (this.fantasyMode) { this._renderFantasy(); return; }

        this.svg.innerHTML = `<defs>
            <filter id="wt-sh"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000" flood-opacity="0.08"/></filter>
            <filter id="wt-shp"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity="0.22"/></filter>
            <filter id="wt-bs"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000" flood-opacity="0.06"/></filter>
        </defs>`;

        const { locations, movements, currentLocationId } = this.lm;

        // Hub 핀 분류 (level ≤ 6 = 같은 동네, B4: 필터 강화)
        const curLoc = locations.find(l => l.id === currentLocationId) || locations[0];
        const dists = (this.lm.distances || []).filter(distance => distance._manual === true);
        const hubPins = curLoc ? locations.filter(l => {
            if (l.parentId) return false; // ★ 서브 장소는 약도에서 숨김
            if (l.id === curLoc.id) return true;
            const d = dists.find(dd =>
                (dd.fromId === curLoc.id && dd.toId === l.id) ||
                (dd.toId === curLoc.id && dd.fromId === l.id) ||
                (dd.fromId === l.id && dd.toId === curLoc.id) ||
                (dd.toId === l.id && dd.fromId === curLoc.id)
            );
            if (!d) return true; // 거리 미설정 → 표시 (신규 장소)
            const lvl = typeof d.level === 'number' ? d.level : 5;
            return lvl <= 6;
        }) : locations;

        // 현재 세션에서 이동한 핀 좌표 우선 적용
        for (const loc of hubPins) {
            const saved = this._loadPinPos(loc.id);
            if (saved) { loc.x = saved.x; loc.y = saved.y; loc._manualXY = true; }
        }

        // 레이아웃 (수동 좌표가 없는 핀만 자동 배치)
        if (hubPins.length >= 2) this._autoLayout(hubPins, curLoc);
        if (curLoc && curLoc.x === 0 && curLoc.y === 0) {
            curLoc.x = 300; curLoc.y = 280;
            this.lm.updateLocation(curLoc.id, { x: curLoc.x, y: curLoc.y });
        }

        // ★ ViewBox 먼저 계산
        const cW = this.container?.offsetWidth || 360;
        const cH = this.container?.offsetHeight || 480;
        const aspect = cW / cH;
        const vbW = 520, vbH = Math.round(vbW / aspect);

        if (this._lastCurLocId !== currentLocationId) {
            this._lastCurLocId = currentLocationId;
            this._vbManual = false;
        }
        if (!this._vbManual) {
            const xs = hubPins.map(l => l.x), ys = hubPins.map(l => l.y);
            const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 300;
            const cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 280;
            this.vb = { x: cx - vbW / 2, y: cy - vbH / 2, w: vbW, h: vbH };
        } else {
            this.vb.w = vbW; this.vb.h = vbH;
        }
        this._applyVB();

        // ★ clipPath (액자 프레임 — 가장자리 깔끔하게)
        const clipId = 'wt-map-clip';
        const defsEl = this.svg.querySelector('defs');
        const cp = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
        cp.setAttribute('id', clipId);
        cp.appendChild(this._el('rect', { x: this.vb.x, y: this.vb.y, width: this.vb.w, height: this.vb.h, rx: 12 }));
        defsEl.appendChild(cp);

        // 모든 콘텐츠를 클리핑 그룹에 넣기
        const clipG = this._el('g', { 'clip-path': `url(#${clipId})` });

        // ★ ViewBox 영역 기반으로 도시 생성
        const hubKey = curLoc ? curLoc.id : 'empty';
        const chatId = this.lm.currentChatId || 'default';
        const seed = this._hashStr(chatId + hubKey + (this._regenCounter || 0)) % 10000 + 1;
        if (!this._cityBgEl || this._cityHubKey !== hubKey) {
            this._buildHubCity(this.vb, seed);
            this._cityHubKey = hubKey;
        }
        if (this._cityBgEl) clipG.appendChild(this._cityBgEl.cloneNode(true));

        this.svg.appendChild(clipG);

        // 핀, 거리선, 나침반 (클리핑 밖 — 항상 보임)
        this._drawDistLines(hubPins, movements);
        this._drawPins(hubPins, currentLocationId);
        this._drawCompass(this.vb);

        // ★ 팝업 카드 (핀 클릭 시)
        if (this._popupLocId) this._drawPopupCard(this._popupLocId, hubPins);

        if (!locations.length) {
            this.svg.appendChild(this._el('text', { x: 300, y: 280, class: 'wt-empty-text' }, 'RP를 시작해보세요! 🐶'));
        }
    }

    // ================================================================
    //  Hub 도시 배경 (목업 v4.1 디자인 — rect 그리드)
    // ================================================================
    _buildHubCity(vb, seed) {
        const rng = this._srand(seed * 31337);
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

        const extra = 80;
        const ox = vb.x - extra, oy = vb.y - extra;
        const W = vb.w + extra * 2, H = vb.h + extra * 2;

        // ===== 레이어 1: 배경 =====
        const bgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        bgLayer.appendChild(this._el('rect', { x: ox - 60, y: oy - 60, width: W + 120, height: H + 120, fill: '#FDFCF8' }));
        g.appendChild(bgLayer);

        // 그리드 계산 (비대칭 열/행)
        const cols = 5, rows = 6;
        const cw = [], rh = [];
        let twc = 0, thr = 0;
        for (let c = 0; c < cols; c++) { cw[c] = 0.5 + rng() * 1.0; twc += cw[c]; }
        for (let r = 0; r < rows; r++) { rh[r] = 0.5 + rng() * 1.0; thr += rh[r]; }
        cw.forEach((_, i) => cw[i] = Math.round((cw[i] / twc) * W));
        rh.forEach((_, i) => rh[i] = Math.round((rh[i] / thr) * H));

        // 대로 vs 골목 — 3번째 경계마다 대로(26px), 나머지 골목(8px)
        const xGap = []; // cols+1개 경계
        for (let c = 0; c <= cols; c++) xGap[c] = (c > 0 && c < cols && c % 3 === 0) ? 13 : 4;
        const yGap = [];
        for (let r = 0; r <= rows; r++) yGap[r] = (r > 0 && r < rows && r % 3 === 0) ? 13 : 4;

        const parkCell = `${1 + (seed % 2)}_${1 + (seed % (cols - 1))}`;
        const riverRow = 2 + (seed % 2);

        const merged = new Set(), plaza = new Set();
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++) {
            if (!merged.has(`${r}_${c}`) && rng() < 0.12 && r !== riverRow) merged.add(`${r}_${c + 1}`);
        }
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            if (!merged.has(`${r}_${c}`) && rng() < 0.06 && `${r}_${c}` !== parkCell && r !== riverRow) plaza.add(`${r}_${c}`);
        }

        // ===== 레이어 2: 강 — 일직선 (±5000, clipPath가 잘라줌) =====
        const riverLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        if (seed % 3 !== 0) {
            let ry = oy;
            for (let r = 0; r <= riverRow; r++) ry += rh[r];
            ry -= rh[riverRow] * 0.5;
            // 본체 (두꺼운 수평 직선)
            riverLayer.appendChild(this._el('line', { x1: -5000, y1: ry, x2: 5000, y2: ry, stroke: '#9CC8E0', 'stroke-width': 42, opacity: '0.50' }));
            // 하이라이트
            riverLayer.appendChild(this._el('line', { x1: -5000, y1: ry, x2: 5000, y2: ry, stroke: '#BDE0F0', 'stroke-width': 16, opacity: '0.40' }));
        }
        g.appendChild(riverLayer);

        // ===== 레이어 2.5: 간선도로 십자가 (가로 오렌지 + 세로 노랑, 딱 2개) =====
        const roadAccent = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        { // 가로 간선도로 1개 (오렌지)
            const mri = 1 + ((seed * 3) % (rows - 2));
            let mry = oy; for (let r = 0; r < mri; r++) mry += rh[r];
            if (mri !== riverRow) {
                roadAccent.appendChild(this._el('line', { x1: -5000, y1: mry, x2: 5000, y2: mry, stroke: '#F8C471', 'stroke-width': 20, opacity: '0.55' }));
            }
        }
        { // 세로 간선도로 1개 (노랑)
            const mci = 1 + ((seed * 7) % (cols - 2));
            let mcx = ox; for (let c = 0; c < mci; c++) mcx += cw[c];
            roadAccent.appendChild(this._el('line', { x1: mcx, y1: -5000, x2: mcx, y2: 5000, stroke: '#F9E79F', 'stroke-width': 18, opacity: '0.50' }));
        }
        g.appendChild(roadAccent);

        // ===== 레이어 3: 블록 (대로/골목 차등 gap) =====
        const blocksLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        let yy = oy;
        for (let r = 0; r < rows; r++) {
            let xx = ox;
            const gT = yGap[r], gB = yGap[r + 1]; // 위/아래 gap
            for (let c = 0; c < cols; c++) {
                const gL = xGap[c], gR = xGap[c + 1]; // 좌/우 gap
                const ck = `${r}_${c}`;
                if (merged.has(ck)) { xx += cw[c]; continue; }

                // 광장 → 호수(둥근 네모) 또는 미니 공원
                if (plaza.has(ck)) {
                    const px = xx + gL, py = yy + gT;
                    const pw = cw[c] - gL - gR, ph = rh[r] - gT - gB;
                    if (pw > 20 && ph > 16) {
                        if (rng() < 0.5) blocksLayer.appendChild(this._el('rect', { x: px, y: py, width: pw, height: ph, rx: 10, fill: '#B8D8EC', opacity: '0.40' }));
                        else this._drawPark(blocksLayer, px, py, pw, ph, rng);
                    }
                    xx += cw[c]; continue;
                }

                const isMg = merged.has(`${r}_${c + 1}`);
                const gR2 = isMg ? xGap[c + 2] || gR : gR; // 병합 시 오른쪽 gap
                const bx = xx + gL, by = yy + gT;
                const bw = (isMg ? cw[c] + cw[c + 1] : cw[c]) - gL - gR2;
                const bh = rh[r] - gT - gB;
                if (bw < 20 || bh < 16) { xx += cw[c]; continue; }

                // 강 행 → 분할
                if (seed % 3 !== 0 && r === riverRow) {
                    const ry2 = yy + rh[r] * 0.5;
                    const aH = (ry2 - 25) - by, bY = ry2 + 25, bH2 = (by + bh) - bY;
                    if (aH > 12) this._drawBlock(blocksLayer, bx, by, bw, aH, rng);
                    if (bH2 > 12) this._drawBlock(blocksLayer, bx, bY, bw, bH2, rng);
                    xx += cw[c]; continue;
                }

                if (ck === parkCell) this._drawPark(blocksLayer, bx, by, bw, bh, rng);
                else this._drawBlock(blocksLayer, bx, by, bw, bh, rng);
                xx += cw[c];
            }
            yy += rh[r];
        }
        g.appendChild(blocksLayer);

        // 구역 이름 (최상단)
        const zn = ['DOWNTOWN','WEST SIDE','CENTRAL','RIVERSIDE','PARK AREA','HILLSIDE','HARBOR','OLD TOWN'];
        g.appendChild(this._el('text', { x: ox + W * 0.3, y: oy + H * 0.48, fill: '#B8B0A0', 'font-size': '11', 'font-weight': '600', 'letter-spacing': '3', opacity: '0.30' }, zn[seed % zn.length]));

        this._cityBgEl = g;
    }

    // ========== 블록 (rect + rx + 건물) ==========
    _drawBlock(parent, x, y, w, h, rng) {
        parent.appendChild(this._el('rect', { x, y, width: w, height: h, rx: 6, fill: '#E4E0D6', filter: 'url(#wt-bs)' }));
        if (w > 35 && h > 28) this._drawBuildings(parent, x, y, w, h, rng);
    }

    // ========== 건물 (1~3개 작은 rect 흩뿌리기) ==========
    _drawBuildings(parent, bx, by, bw, bh, rng) {
        const m = 5; // 블록 안쪽 여백
        const count = 1 + Math.floor(rng() * 3); // 1~3개
        const tones = ['#D0CBC0', '#C8C3B8', '#D5D0C6', '#CCC7BC'];
        const placed = [];

        for (let i = 0; i < count * 6; i++) {
            if (placed.length >= count) break;
            const wr = 0.25 + rng() * 0.25; // 블록 대비 25~50%
            const hr = 0.25 + rng() * 0.25;
            const w = bw * wr, h = bh * hr;
            const x = bx + m + rng() * Math.max(0, bw - m * 2 - w);
            const y = by + m + rng() * Math.max(0, bh - m * 2 - h);
            // 겹침 방지
            if (placed.some(p => x < p.x + p.w + 4 && x + w + 4 > p.x && y < p.y + p.h + 4 && y + h + 4 > p.y)) continue;
            placed.push({ x, y, w, h });
            parent.appendChild(this._el('rect', {
                x, y, width: w, height: h, rx: 1.5,
                fill: tones[Math.floor(rng() * tones.length)],
                opacity: 0.40 + rng() * 0.12,
            }));
        }
    }

    // ========== 공원 (ellipse blob) ==========
    _drawPark(parent, x, y, w, h, rng) {
        parent.appendChild(this._el('rect', { x, y, width: w, height: h, rx: 6, fill: '#C5E0A8', filter: 'url(#wt-bs)' }));
        // 연못
        if (rng() < 0.6 && w > 60) {
            parent.appendChild(this._el('ellipse', {
                cx: x + w * (0.35 + rng() * 0.3), cy: y + h * (0.35 + rng() * 0.3),
                rx: Math.min(w, h) * 0.14, ry: Math.min(w, h) * 0.09,
                fill: '#9CC5E0', opacity: '0.45',
            }));
        }
        // 나무
        const tc = 3 + Math.floor(rng() * 4);
        for (let i = 0; i < tc; i++) {
            parent.appendChild(this._el('circle', {
                cx: x + w * (0.1 + rng() * 0.8), cy: y + h * (0.1 + rng() * 0.8),
                r: 2.5 + rng() * 3, fill: '#98CC88', opacity: 0.25 + rng() * 0.12,
            }));
        }
    }

    // ================================================================
    //  실제 이동 간선만 표시. 거리 all-pairs는 약도에 그리지 않는다.
    // ================================================================
    _drawDistLines(hubPins, movements) {
        const hubIds = new Set(hubPins.map(l => l.id));
        const drawn = new Set();

        for (const m of movements) {
            if (!hubIds.has(m.fromId) || !hubIds.has(m.toId)) continue;
            const f = hubPins.find(l => l.id === m.fromId), t = hubPins.find(l => l.id === m.toId);
            if (!f || !t) continue;
            const k = [m.fromId, m.toId].sort().join('-');
            if (drawn.has(k)) continue; drawn.add(k);
            this.svg.appendChild(this._el('line', { x1: f.x, y1: f.y, x2: t.x, y2: t.y, stroke: '#A09888', 'stroke-width': 1.5, 'stroke-dasharray': '6 4', 'stroke-linecap': 'round', opacity: 0.35 }));
        }
    }

    // ================================================================
    //  핀 (Hub 핀만 — 목업 그대로)
    // ================================================================
    _drawPins(hubPins, currentLocationId) {
        for (const loc of hubPins) {
            const cur = loc.id === currentLocationId;
            const ps = this._pinStyle(loc.name);
            const g = this._el('g', { class: 'wt-location-node', 'data-id': loc.id, transform: `translate(${loc.x},${loc.y})` });

            if (cur) {
                const pulse = this._el('circle', { r: 22, fill: 'none', stroke: ps.color, 'stroke-width': 2, opacity: '0.15' });
                const aR = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
                aR.setAttribute('attributeName', 'r'); aR.setAttribute('from', '18'); aR.setAttribute('to', '36');
                aR.setAttribute('dur', '2s'); aR.setAttribute('repeatCount', 'indefinite'); pulse.appendChild(aR);
                const aO = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
                aO.setAttribute('attributeName', 'opacity'); aO.setAttribute('from', '0.3'); aO.setAttribute('to', '0');
                aO.setAttribute('dur', '2s'); aO.setAttribute('repeatCount', 'indefinite'); pulse.appendChild(aO);
                g.appendChild(pulse);
            }
            const sz = cur ? 19 : 13, ph = cur ? 26 : 18;
            const pin = this._el('g', { transform: `translate(0,${-ph})`, filter: 'url(#wt-shp)' });
            pin.appendChild(this._el('path', { d: `M0,${ph}C0,${ph},${-sz},${ph * 0.35},${-sz},${-sz * 0.15}A${sz},${sz},0,1,1,${sz},${-sz * 0.15}C${sz},${ph * 0.35},0,${ph},0,${ph}Z`, fill: ps.color, stroke: cur ? '#fff' : ps.border, 'stroke-width': cur ? 1.5 : 0.8 }));
            pin.appendChild(this._el('text', { x: 0, y: -sz * 0.1 + 5, 'text-anchor': 'middle', 'font-size': cur ? '14' : '11', style: 'pointer-events:none' }, ps.emoji));
            g.appendChild(pin);
            if (loc.visitCount > 0) { const bx2 = sz * 0.5, by2 = -(ph + sz * 0.3); const bdg = this._el('g', { transform: `translate(${bx2},${by2})` }); bdg.appendChild(this._el('circle', { r: 8, fill: '#fff', stroke: ps.color, 'stroke-width': 1.5 })); bdg.appendChild(this._el('text', { 'text-anchor': 'middle', y: 3.5, 'font-size': '8.5', 'font-weight': '700', fill: ps.color }, loc.visitCount)); g.appendChild(bdg); }
            const nl = loc.name.length * 6.5 + 12;
            const lg = this._el('g', { transform: 'translate(0,6)' });
            lg.appendChild(this._el('rect', { x: -nl / 2, y: -8, width: nl, height: 16, rx: 8, fill: '#fff', stroke: '#E8E4D8', 'stroke-width': 0.7, filter: 'url(#wt-sh)' }));
            lg.appendChild(this._el('text', { class: 'wt-location-label', y: 3, 'font-size': '9', 'font-weight': '600' }, loc.name));
            g.appendChild(lg);
            if (cur) { const paw = this._el('text', { 'text-anchor': 'middle', y: -(ph + sz + 5), 'font-size': '15' }, '🐾'); const pa = document.createElementNS('http://www.w3.org/2000/svg', 'animateTransform'); pa.setAttribute('attributeName', 'transform'); pa.setAttribute('type', 'translate'); pa.setAttribute('values', '0 0;0 -4;0 0'); pa.setAttribute('dur', '1.2s'); pa.setAttribute('repeatCount', 'indefinite'); paw.appendChild(pa); g.appendChild(paw); }
            this.svg.appendChild(g);
        }
    }

    // ========== 나침반 ==========
    _drawCompass(vb) {
        const ccx = vb.x + 22, ccy = vb.y + vb.h - 22, s = 12;
        const cg = this._el('g', { transform: `translate(${ccx},${ccy})`, opacity: '0.4' });
        cg.appendChild(this._el('circle', { r: s, fill: 'rgba(242,238,228,0.75)', stroke: '#B0A090', 'stroke-width': 0.7 }));
        cg.appendChild(this._el('polygon', { points: `0,${-s + 3} -2.5,${-s * 0.35} 2.5,${-s * 0.35}`, fill: '#E07060', opacity: 0.75 }));
        cg.appendChild(this._el('polygon', { points: `0,${s - 3} -2.5,${s * 0.35} 2.5,${s * 0.35}`, fill: '#D0C8B8', opacity: 0.5 }));
        cg.appendChild(this._el('text', { y: -s - 2, 'text-anchor': 'middle', fill: '#E07060', 'font-size': '5', 'font-weight': '700' }, 'N'));
        this.svg.appendChild(cg);
    }

    // ================================================================
    //  팝업 카드 (말풍선 — 핀 위에 표시)
    // ================================================================
    _removePopup() { this.svg?.querySelector('#wt-popup-card')?.remove(); }

    _drawPopupCard(locId, hubPins) {
        this._removePopup();
        const loc = (hubPins || this.lm.locations).find(l => l.id === locId);
        if (!loc) return;

        const ps = this._pinStyle(loc.name);
        const g = this._el('g', { id: 'wt-popup-card', transform: `translate(${loc.x},${loc.y})` });

        // 데이터
        const visits = loc.visitCount || 0;
        const visitText = visits === 0 ? 'New' : visits === 1 ? '1st' : `${visits}th`;

        // 가까운 장소
        let nearName = '';
        let nearLevel = 99;
        for (const d of (this.lm.distances || []).filter(distance => distance._manual === true)) {
            const otherId = d.fromId === locId ? d.toId : d.toId === locId ? d.fromId : null;
            if (!otherId) continue;
            if ((d.level || 5) < nearLevel) {
                nearLevel = d.level || 5;
                const other = this.lm.locations.find(l => l.id === otherId);
                if (other) nearName = other.name;
            }
        }

        // 메모/이벤트 (팝업 카드 = title 우선, 짧은 훅)
        let memoText = '';
        if (loc.events?.length) {
            const latest = loc.events[loc.events.length - 1];
            memoText = latest.title || latest.text || '';
        } else if (loc.memo) {
            memoText = loc.memo;
        }
        if (memoText.length > 18) memoText = memoText.substring(0, 18) + '...';
        const hasMemo = memoText.length > 0;

        // 카드 사이즈
        const cardW = 190;
        const cardH = 78;
        const cardY = -148;

        const card = this._el('g', { transform: `translate(0,${cardY})`, filter: 'url(#wt-shp)' });

        // 꼬리
        card.appendChild(this._el('path', { d: `M-5,${cardH} L0,${cardH + 9} L5,${cardH}`, fill: '#fff' }));
        // 카드 배경
        card.appendChild(this._el('rect', { x: -cardW / 2, y: 0, width: cardW, height: cardH, rx: 12, fill: '#fff' }));

        const lx = -cardW / 2 + 14; // 왼쪽 시작
        const rx = cardW / 2 - 14;  // 오른쪽 끝

        // 1행: 이름 (굵게) + 방문횟수 (오른쪽, 작고 회색)
        card.appendChild(this._el('text', {
            x: lx, y: 22,
            fill: '#2D2418', 'font-size': '14', 'font-weight': '800',
            'font-family': "'Noto Sans KR',sans-serif",
        }, loc.name));
        card.appendChild(this._el('text', {
            x: rx, y: 22, 'text-anchor': 'end',
            fill: '#B5AD9E', 'font-size': '9', 'font-weight': '500',
            'font-family': "Inter,'Noto Sans KR',sans-serif",
        }, visitText));

        // 2행: 근처 장소 (작고 회색)
        card.appendChild(this._el('text', {
            x: lx, y: 38,
            fill: '#A8A090', 'font-size': '9', 'font-weight': '400',
            'font-family': "'Noto Sans KR',sans-serif",
        }, nearName ? `Near ${nearName}` : ''));

        // 점선 구분 (항상 표시)
        card.appendChild(this._el('line', {
            x1: lx, y1: 46, x2: rx, y2: 46,
            stroke: '#EAE6DC', 'stroke-width': 1, 'stroke-dasharray': '4 3',
        }));

        // 메모 or placeholder
        if (hasMemo) {
            card.appendChild(this._el('text', {
                x: lx, y: 62,
                fill: '#8B9A78', 'font-size': '9.5', 'font-weight': '400',
                'font-style': 'italic', 'letter-spacing': '0.2',
                'font-family': "'Noto Sans KR',sans-serif",
            }, `"${memoText}"`));
        } else {
            card.appendChild(this._el('text', {
                x: lx, y: 62,
                fill: '#C5BFB5', 'font-size': '9', 'font-weight': '400',
                'font-family': "'Noto Sans KR',sans-serif",
            }, '📝 아직 기록이 없습니다'));
        }

        g.appendChild(card);

        // ★ 카드 클릭 영역 (투명 rect + 커서)
        const hitArea = this._el('rect', {
            x: -cardW / 2, y: cardY, width: cardW, height: cardH + 12,
            fill: 'transparent', style: 'cursor:pointer',
        });
        g.appendChild(hitArea);

        // 카드 터치/클릭 → 팝오버 열기
        const self = this;
        const cardLocId = locId;
        // mousedown/mouseup 전파 차단 (팝업 닫힘 방지)
        g.addEventListener('mousedown', (e) => { e.stopPropagation(); });
        g.addEventListener('mouseup', (e) => { e.stopPropagation(); });
        g.addEventListener('click', (e) => {
            e.stopPropagation();
            if (self.onPopupCardClick) self.onPopupCardClick(cardLocId);
        });
        g.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
        g.addEventListener('touchend', (e) => {
            if (self._wasDrag) return;
            e.stopPropagation();
            if (self.onPopupCardClick) self.onPopupCardClick(cardLocId);
        });

        this.svg.appendChild(g);
    }

    // ================================================================
    //  AUTO LAYOUT (Hub 핀만, centerX 강제 없음)
    // ================================================================
    _autoLayout(hubPins, curLoc) {
        if (this._skipLayout) { this._skipLayout = false; return; }
        const needsInit = hubPins.some(l => !l._manualXY && l.x === 0 && l.y === 0);
        if (!needsInit && !this._layoutDirty) return;
        this._layoutDirty = false;

        // ★ _manualXY 핀 좌표 백업 (무슨 일이 있어도 복원)
        const manualBackup = new Map();
        for (const loc of hubPins) {
            if (loc._manualXY) manualBackup.set(loc.id, { x: loc.x, y: loc.y });
        }

        const dists = (this.lm.distances || []).filter(distance => distance._manual === true);
        const geoLocs = hubPins.filter(l => l.lat != null && l.lng != null);

        if (geoLocs.length >= 2) {
            this._geoAwareLayout(hubPins, geoLocs, curLoc);
        } else {
            this._circularLayout(hubPins, dists, curLoc);
        }

        // 겹침 방지 (_manualXY 핀은 절대 안 움직임)
        for (let iter = 0; iter < 3; iter++) {
            for (let i = 0; i < hubPins.length; i++) for (let j = i + 1; j < hubPins.length; j++) {
                const a = hubPins[i], b = hubPins[j];
                if (a._manualXY && b._manualXY) continue;
                const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy);
                if (d < 70) {
                    const push = (70 - d) / 2, nx = dx / (d || 1), ny = dy / (d || 1);
                    if (!a._manualXY && a.id !== curLoc.id) { a.x -= Math.round(push * nx); a.y -= Math.round(push * ny); }
                    if (!b._manualXY && b.id !== curLoc.id) { b.x += Math.round(push * nx); b.y += Math.round(push * ny); }
                }
            }
        }

        // ★ _manualXY 핀 좌표 강제 복원
        for (const [id, pos] of manualBackup) {
            const loc = hubPins.find(l => l.id === id);
            if (loc) { loc.x = pos.x; loc.y = pos.y; }
        }

        // 비수동 핀만 DB 저장
        for (const loc of hubPins) {
            if (!loc._manualXY) this.lm.updateLocation(loc.id, { x: loc.x, y: loc.y });
        }
    }

    _geoAwareLayout(locs, geoLocs, curLoc) {
        let baseLat, baseLng;
        if (curLoc.lat != null && curLoc.lng != null) { baseLat = curLoc.lat; baseLng = curLoc.lng; }
        else { baseLat = geoLocs.reduce((s, l) => s + l.lat, 0) / geoLocs.length; baseLng = geoLocs.reduce((s, l) => s + l.lng, 0) / geoLocs.length; }
        const toM = (lat, lng) => ({ mx: (lng - baseLng) * 111320 * Math.cos(baseLat * Math.PI / 180), my: -(lat - baseLat) * 111320 });
        let maxR = 1;
        for (const l of geoLocs) { const { mx, my } = toM(l.lat, l.lng); maxR = Math.max(maxR, Math.abs(mx), Math.abs(my)); }
        const scale = 180 / maxR;
        // curLoc 좌표가 0이면 초기 배치
        if (curLoc.x === 0 && curLoc.y === 0) { curLoc.x = 300; curLoc.y = 280; }
        const cx = curLoc.x, cy = curLoc.y;
        for (const loc of locs) {
            if (loc.id === curLoc.id || loc._manualXY) continue;
            if (loc.x !== 0 || loc.y !== 0) continue; // 이미 배치된 건 스킵
            if (loc.lat != null && loc.lng != null) {
                const { mx, my } = toM(loc.lat, loc.lng);
                loc.x = Math.round(cx + mx * scale); loc.y = Math.round(cy + my * scale);
            } else {
                const dist = (this.lm.distances || []).find(d => d._manual === true && ((d.fromId === curLoc.id && d.toId === loc.id) || (d.toId === curLoc.id && d.fromId === loc.id)));
                const level = dist?.level || 5;
                const px = level * 28 + 40;
                const angle = ((loc.id.charCodeAt(4) || 0) * 37 + 11) % 360 * Math.PI / 180;
                loc.x = Math.round(cx + px * Math.cos(angle)); loc.y = Math.round(cy + px * Math.sin(angle));
            }
        }
    }

    _circularLayout(hubPins, dists, curLoc) {
        if (curLoc.x === 0 && curLoc.y === 0) { curLoc.x = 300; curLoc.y = 280; }
        const cx = curLoc.x, cy = curLoc.y;
        const others = hubPins.filter(l => l.id !== curLoc.id && !l._manualXY && l.x === 0 && l.y === 0);
        const angleStep = (2 * Math.PI) / Math.max(others.length, 1);
        let angle = ((hubPins.length * 37 + 11) % 360) * Math.PI / 180;
        for (const loc of others) {
            const dist = dists.find(d => (d.fromId === curLoc.id && d.toId === loc.id) || (d.toId === curLoc.id && d.fromId === loc.id));
            const level = dist?.level || 5;
            const px = level * 28 + 40 + (Math.random() - 0.5) * 20;
            angle += (Math.random() - 0.5) * 0.5; // 각도 흔들기
            loc.x = Math.round(cx + px * Math.cos(angle)); loc.y = Math.round(cy + px * Math.sin(angle));
            angle += angleStep;
        }
    }

    _pinStyle(name) { const lo = name.toLowerCase(); if (/카페|cafe|coffee|커피/i.test(lo)) return { color: '#E74C3C', emoji: '🐱', border: '#C0392B' }; if (/서점|book|도서|library|서재/i.test(lo)) return { color: '#3498DB', emoji: '📚', border: '#2980B9' }; if (/집|home|house|숙소|기숙|방/i.test(lo)) return { color: '#27AE60', emoji: '🏠', border: '#1E8449' }; if (/공원|park|정원|garden|광장/i.test(lo)) return { color: '#2ECC71', emoji: '🌳', border: '#27AE60' }; if (/편의|convenience|마트|mart|가게|shop|store|문구|supermarket|grocery/i.test(lo)) return { color: '#F39C12', emoji: '🏪', border: '#D68910' }; if (/식당|restaurant|음식|레스토랑/i.test(lo)) return { color: '#E67E22', emoji: '🍽️', border: '#CA6F1E' }; if (/학교|school|학원|academy/i.test(lo)) return { color: '#9B59B6', emoji: '🎓', border: '#7D3C98' }; if (/병원|hospital|의원|clinic/i.test(lo)) return { color: '#1ABC9C', emoji: '🏥', border: '#17A589' }; if (/역|station|지하철|subway|버스|bus/i.test(lo)) return { color: '#34495E', emoji: '🚉', border: '#2C3E50' }; if (/술집|bar|pub|tavern|주점|주막/i.test(lo)) return { color: '#8E44AD', emoji: '🍺', border: '#6C3483' }; if (/체육|gym|운동|fitness|arena/i.test(lo)) return { color: '#E74C3C', emoji: '💪', border: '#C0392B' }; if (/성|castle|궁|palace|요새/i.test(lo)) return { color: '#7F8C8D', emoji: '🏰', border: '#616A6B' }; if (/숲|forest|산|mountain/i.test(lo)) return { color: '#1E8449', emoji: '🌲', border: '#145A32' }; if (/해변|beach|바다|sea|강|river|호수|lake/i.test(lo)) return { color: '#2980B9', emoji: '🌊', border: '#1F618D' }; if (/동굴|cave|dungeon|던전|지하/i.test(lo)) return { color: '#5D6D7E', emoji: '🕳️', border: '#4A5568' }; if (/항구|port|harbor|dock|부두/i.test(lo)) return { color: '#2471A3', emoji: '⚓', border: '#1A5276' }; return { color: '#F6A93A', emoji: '📍', border: '#D68910' }; }

    // ================================================================
    //  🏰 FANTASY (기존 유지)
    // ================================================================
    _renderFantasy() { const{locations,movements,currentLocationId}=this.lm;if(locations.length>=2)this._autoLayout(locations,locations.find(l=>l.id===currentLocationId)||locations[0]);const cW=Math.max(this.container?.offsetWidth||600,300),cH=Math.max(this.container?.offsetHeight||400,300),aspect=cW/cH;if(locations.length){const pad=100,xs=locations.map(l=>l.x),ys=locations.map(l=>l.y),minX=Math.min(...xs)-pad,maxX=Math.max(...xs)+pad,minY=Math.min(...ys)-pad,maxY=Math.max(...ys)+pad,w=Math.max(400,maxX-minX),h=Math.max(300,maxY-minY,w/aspect);this.vb={x:minX,y:minY,w,h};}else{this.vb={x:0,y:0,w:600,h:Math.max(400,Math.round(600/aspect))};}this._applyVB();const vb=this.vb;let svg=`<defs><filter id="wt-glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;const drawn=new Set();for(const m of movements){const f=locations.find(l=>l.id===m.fromId),t=locations.find(l=>l.id===m.toId);if(!f||!t)continue;const k=[m.fromId,m.toId].sort().join('-');if(drawn.has(k))continue;drawn.add(k);svg+=`<path d="M${f.x},${f.y} Q${(f.x+t.x)/2+((k.charCodeAt(0)%16)-8)},${(f.y+t.y)/2+((k.charCodeAt(1%k.length)%16)-8)} ${t.x},${t.y}" fill="none" stroke="#6B3A2A" stroke-width="2" stroke-dasharray="8 5" opacity="0.35" stroke-linecap="round"/>`;}for(const loc of locations){const cur=loc.id===currentLocationId,type=this._getLocType(loc.name);if(cur)svg+=`<circle cx="${loc.x}" cy="${loc.y}" r="28" fill="#CD853F" opacity="0.15" filter="url(#wt-glow)"/>`;svg+=this._fantasyIcon(loc.x,loc.y,type,cur,loc.visitCount||0,loc.id);svg+=`<text x="${loc.x}" y="${loc.y+24}" text-anchor="middle" fill="#3E2723" font-size="${cur?13:11}" font-weight="${cur?'700':'600'}" font-family="'Georgia',serif">${loc.name}</text>`;if(cur)svg+=`<text x="${loc.x}" y="${loc.y-24}" text-anchor="middle" font-size="14">🐾</text>`;}if(!locations.length)svg+=`<text x="${vb.x+vb.w/2}" y="${vb.y+vb.h/2}" text-anchor="middle" fill="#5D4037" font-size="14" font-family="serif" font-style="italic">모험을 시작해보세요... 🏰</text>`;svg+=this._compassRose(vb.x+32,vb.y+vb.h-32);this.svg.innerHTML=svg;}
    _getLocType(n){const l=n.toLowerCase();if(/성|castle|palace|궁|요새|tower|탑/.test(l))return'castle';if(/산|mountain|peak|봉/.test(l))return'mountain';if(/숲|forest|woods|jungle/.test(l))return'forest';if(/신전|temple|church|성당|교회/.test(l))return'temple';if(/마을|village|town/.test(l))return'village';if(/집|home|house|오두막/.test(l))return'house';if(/가게|shop|market|시장/.test(l))return'shop';if(/술집|tavern|bar|pub|inn|주막/.test(l))return'tavern';if(/동굴|cave|dungeon|지하/.test(l))return'cave';if(/항구|port|harbor|부두/.test(l))return'port';if(/강|river|lake|호수|바다|sea/.test(l))return'water';if(/학교|school|도서관|library/.test(l))return'library';if(/arena|훈련|체육|gym/.test(l))return'arena';return'flag';}
    _fantasyIcon(x,y,type,cur,v,id){const s=cur?1.15:1,em={castle:'🏰',mountain:'⛰️',forest:'🌲',temple:'⛪',village:'🏘️',house:'🏠',shop:'🏪',tavern:'🍺',cave:'🕳️',port:'⚓',water:'💧',library:'📚',arena:'⚔️',flag:'🪧'},e=em[type]||'📍',sz=cur?28:22;let svg=`<g transform="translate(${x},${y}) scale(${s})" class="wt-location-node" data-id="${id}">`;if(cur)svg+=`<circle r="20" fill="#CD853F" opacity="0.2" filter="url(#wt-glow)"/>`;svg+=`<text y="6" text-anchor="middle" font-size="${sz}" style="cursor:pointer;pointer-events:none;user-select:none">${e}</text>`;if(v>0)svg+=`<circle cx="14" cy="-8" r="7" fill="#DAA520" stroke="#5D4037" stroke-width="0.8"/><text x="14" y="-5" text-anchor="middle" fill="#3E2723" font-size="8" font-weight="700">${v}</text>`;svg+='</g>';return svg;}
    _compassRose(cx,cy){const s=22;return`<g transform="translate(${cx},${cy})"><circle r="${s}" fill="rgba(244,228,193,0.6)" stroke="#8B6914" stroke-width="1.2"/><circle r="${s*0.15}" fill="#8B6914"/><polygon points="0,${-s+3} -4,${-s*0.35} 4,${-s*0.35}" fill="#8B0000" stroke="#5D4037" stroke-width="0.5"/><polygon points="0,${s-3} -4,${s*0.35} 4,${s*0.35}" fill="#D4C5A0" stroke="#5D4037" stroke-width="0.5"/><text y="${-s-3}" text-anchor="middle" fill="#8B0000" font-size="8" font-weight="700" font-family="serif">N</text><text y="${s+9}" text-anchor="middle" fill="#5D4037" font-size="7" font-weight="600" font-family="serif">S</text></g>`;}

    // ================================================================
    //  TOUCH / MOUSE
    // ================================================================
    _touchStart(e){if(e.touches.length===2){e.preventDefault();this._pinch=this._pinchDist(e);this._pan=null;this._longPress=null;return;}if(e.touches.length===1){const t=e.touches[0],pt=this._svgPt(t),hitId=this._hitTest(pt);this._touchInfo={x:t.clientX,y:t.clientY,time:Date.now(),nodeId:hitId,pt};this._wasDrag=false;if(hitId&&!this._movingNodeId){e.preventDefault();this._longPress=setTimeout(()=>{this._movingNodeId=hitId;const loc=this.lm.locations.find(l=>l.id===hitId);if(loc&&this.onMoveRequest)this.onMoveRequest(hitId,loc.name);this._longPress=null;},500);}else if(this._movingNodeId){e.preventDefault();const loc=this.lm.locations.find(l=>l.id===this._movingNodeId);if(loc){loc.x=Math.round(pt.x);loc.y=Math.round(pt.y);loc._manualXY=true;this.lm.updateLocation(loc.id,{x:loc.x,y:loc.y,_manualXY:true});this._savePinPos(loc.id,loc.x,loc.y);this._vbManual=true;this._skipLayout=true;this.render();}this._movingNodeId=null;}else{/* 팬 비활성화 */}}}
    _touchMove(e){if(e.touches.length===2&&this._pinch){e.preventDefault();const d=this._pinchDist(e),s=this._pinch/d;const cxv=this.vb.x+this.vb.w/2,cyv=this.vb.y+this.vb.h/2;const nw=Math.max(200,Math.min(2000,this.vb.w*s));const nh=nw*(this.vb.h/this.vb.w);this.vb={x:cxv-nw/2,y:cyv-nh/2,w:nw,h:nh};this._applyVB();this._pinch=d;return;}if(e.touches.length===1){const t=e.touches[0];if(this._longPress&&this._touchInfo){if(Math.abs(t.clientX-this._touchInfo.x)>10||Math.abs(t.clientY-this._touchInfo.y)>10){clearTimeout(this._longPress);this._longPress=null;}}if(this._pan){e.preventDefault();const dx=(t.clientX-this._pan.sx)*(this.vb.w/this.svg.getBoundingClientRect().width);const dy=(t.clientY-this._pan.sy)*(this.vb.h/this.svg.getBoundingClientRect().height);this.vb.x=this._pan.vx-dx;this.vb.y=this._pan.vy-dy;this._applyVB();this._wasDrag=true;}}}
    _touchEnd(){clearTimeout(this._longPress);this._longPress=null;const wasPinch=!!this._pinch;if(this._touchInfo&&!this._wasDrag&&!wasPinch&&this._touchInfo.nodeId&&!this._movingNodeId){if(Date.now()-this._touchInfo.time<400)this.onLocationClick?.(this._touchInfo.nodeId);}else if(this._touchInfo&&!this._wasDrag&&!wasPinch&&!this._touchInfo.nodeId&&this._popupLocId){this._popupLocId=null;this._removePopup();}this._pinch=null;this._pan=null;this._touchInfo=null;}
    _onDown(e){const pt=this._svgPt(e),hitId=this._hitTest(pt);this._wasDrag=false;if(this._movingNodeId){e.preventDefault();const loc=this.lm.locations.find(l=>l.id===this._movingNodeId);if(loc){loc.x=Math.round(pt.x);loc.y=Math.round(pt.y);loc._manualXY=true;this.lm.updateLocation(loc.id,{x:loc.x,y:loc.y,_manualXY:true});this._savePinPos(loc.id,loc.x,loc.y);this._vbManual=true;this._skipLayout=true;this.render();}this._movingNodeId=null;return;}if(hitId){e.preventDefault();this._mouseClickId=hitId;}/* 팬 비활성화 */}
    _onMove(e){if(this._pan){const dx=(e.clientX-this._pan.sx)*(this.vb.w/this.svg.getBoundingClientRect().width);const dy=(e.clientY-this._pan.sy)*(this.vb.h/this.svg.getBoundingClientRect().height);this.vb.x=this._pan.vx-dx;this.vb.y=this._pan.vy-dy;this._applyVB();this._wasDrag=true;this._mouseClickId=null;}}
    _onUp(){this._pan=null;if(this._mouseClickId&&!this._wasDrag){this.onLocationClick?.(this._mouseClickId);}else if(!this._wasDrag&&this._popupLocId){this._popupLocId=null;this._removePopup();}this._mouseClickId=null;}
    _zoom(f,e){const r=this.svg.getBoundingClientRect();const mx=(e.clientX-r.left)/r.width,my=(e.clientY-r.top)/r.height;const nw=Math.max(200,Math.min(2000,this.vb.w*f));const nh=nw*(this.vb.h/this.vb.w);this.vb.x+=(this.vb.w-nw)*mx;this.vb.y+=(this.vb.h-nh)*my;this.vb.w=nw;this.vb.h=nh;this._applyVB();}
    _el(tag,attrs,text){const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs||{}))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;return el;}
    _svgPt(e){const r=this.svg.getBoundingClientRect();return{x:this.vb.x+(e.clientX-r.left)/r.width*this.vb.w,y:this.vb.y+(e.clientY-r.top)/r.height*this.vb.h};}
    _hitTest(pt){for(const l of this.lm.locations){if(l.parentId)continue;const dx=pt.x-l.x,dy=pt.y-l.y;if(Math.sqrt(dx*dx+dy*dy)<30)return l.id;}return null;}
    _pinchDist(e){const a=e.touches[0],b=e.touches[1];return Math.sqrt((a.clientX-b.clientX)**2+(a.clientY-b.clientY)**2);}
}
