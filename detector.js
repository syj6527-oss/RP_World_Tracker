// 🐶 World Tracker — detector.js (All Fixes + City Detection)


export class LocationDetector {
    constructor(lm) {
        this.lm = lm;

        this.suffixPat = [
            /(?:으로|로)\s*(?:향하|가|갔|걸어|이동|달려|뛰어|들어|나서|떠나|돌아|출발)/,
            /에\s*(?:도착|당도|다다|들어서|들어섰|왔다|갔다)/,
        ];
        this.departureSuffix = [
            /에서\s*(?:나와|나왔|나서|나섰|떠나|떠났|벗어나|빠져나)/,
            /(?:을|를)\s*(?:나서|나섰|떠나|떠났|벗어나|빠져나)/,
        ];
        this.presSuffix = [/에\s*(?:서 있|앉아|앉았|기대|서서)/, /에서\s*(?:앉|서|기다|머무)/];

        this.moveKw = [
            '향했','향해','걸어갔','걸어간','걸어가','성큼성큼','도착했','도착한','이동했',
            '들어갔','들어간','들어서','들어섰','나왔','나섰','떠났','돌아왔','돌아간','돌아오',
            '찾아갔','찾아왔','달려갔','뛰어갔','올라갔','내려갔','내려왔','건너갔',
            '문을 열','자리를 떠',
            '놀러갔','놀러가','놀러간','여행갔','여행간','여행을 떠',
            '출발했','출발한','다녀왔','다녀온','구경갔','구경하러',
            '데려갔','데려간','끌고 갔','끌려갔','이사했','이사한',
            'headed to','walked to','went to','arrived at','arrived in','arrived to','entered','moved to',
            'returned to','reached','walked into','headed home','went home','got home','came home',
            'drove to','ran to','rushed to','hurried to','traveled to','travelled to','flew to','flew into','flew in',
            'landed in','landed at','landed','made it to','got to','came to','back in','now in','here in',
            'reach','reaching','stop by','stopped by','stopping by','pull into','pulled into','pulled in','pull in',
            'step into','stepped into','head into','heading into','heading to','heading toward','headed toward','walk to','walking to',
        ];
        this.presKw = ['에서 앉','에서 서 있','에 앉아','에 서서','안에 있','안에서'];
        this.futureKw = ['갈래','갈까','가자','가볼까','어때','가고 싶','가보자','갈 거','갈게','shall we',"let's go",'want to go','how about'];

        // 경유지 (장소로 안 잡음)
        this.transitKo = ['복도','계단','통로','현관','로비','엘리베이터','에스컬레이터','출입구','입구','출구','문','문앞','문간','현관문','골목','길','건널목','횡단보도','주차장','차도'];
        this.transitEn = ['corridor','hallway','staircase','stairs','stairwell','elevator','escalator','passage','passageway','entrance','exit','doorway','door','gate','sidewalk','pathway','driveway'];

        this.skipKo = [
            ...this.transitKo,
            '그곳','여기','저기','거기','이곳','저곳','어디',
            '그녀','그는','그가','나는','우리','너는',
            '자신','상대','서로','모두','누군',
            '이쪽','저쪽','그쪽','앞쪽','뒤쪽','양쪽','한쪽',
            '바닥','천장','벽면','구석','가장','순간','갑자','아까','지금','오늘','내일',
            // 신체/추상 명사 오탐 방지 (이동 동사와 같은 문장에서 조사에 잘못 걸림 — 절대 장소 아님)
            '얼굴','머리','어깨','가슴','손목','손등','손바닥','발목','무릎','허리','입가','입술','눈가','눈빛','이마','어깻',
            '표정','목소리','분위기','마음','기분','감정','생각','시선','고개','자세','걸음','발걸음',
            '마지막','처음','나중','방금','잠시','동안','사이','이내','당신','본인','그들','상대방','우리들',
            // 도로/조각 단어 오탐 방지 (교차로→"교차" 등)
            '교차','교차로','스크램블','한복판','통창','인파','한가운','정중앙','복판',
            '이중문','출입문','철문','나무문','유리문',
            // 부사 오탐 방지
            '제멋대','마음대','맘대','억지','저절','함부','대충대',
            '뜻대','예정대','계획대','순서대','원래대','그대',
            '말대','생각대','소원대','자기대','자기멋대','눈대중',
            '되는대','닥치는대','시키는대','하는대','아무대',
            '엉뚱','느닷없','갑작스','황급','서둘',
            // 의류/소품
            '재킷','코트','외투','점퍼','셔츠','바지','치마','원피스','모자','장갑',
            '신발','구두','운동화','슬리퍼','부츠','가방','핸드백','배낭','지갑','목걸이',
            '귀걸이','반지','팔찌','넥타이','스카프','머플러','안경','선글라스',
            // 신체
            '어깨','허벅지','팔뚝','손목','발목','머리카락','뒷덜미','손가락','발가락',
            '이마','볼','턱','목','허리','가슴','등','배','무릎','팔','다리',
            '심장','입술','혀','뺨','눈썹','콧날','귓불',
            // 추상/일반
            '마음','기분','느낌','감정','표정','눈빛','시선','한숨','말투','목소리',
            '생각','기억','추억','습관','버릇','성격','태도','분위기','인상','냄새',
            '모습','모양','형태','크기','색깔','소리','맛','온기','냉기','향기',
            '체온','정적','숨결','속삭임','윙크','두근','설레임','떨림','긴장','흥분',
            '고요','침묵','적막','여운','감촉','촉감',
            // 가구/가전/생활용품
            '소파','의자','테이블','책상','침대','탁자','선반','서랍','거울','커튼',
            '카펫','러그','쿠션','이불','베개','장롱','옷장','냉장고','세탁기','건조기',
            '전자레인지','오븐','에어컨','히터','선풍기','청소기','다리미','식기','접시','컵',
            '수건','비누','칫솔','샴푸','화장품','휴지','쓰레기통','우산','열쇠','리모컨',
            // 음식/음료
            '커피','맥주','술','와인','주스','우유','빵','밥','국','찌개',
            '라면','피자','치킨','햄버거','케이크','과자','사탕','초콜릿','아이스크림',
            // 자연/일반 명사 오탐 방지
            '공기','물','불','바람','하늘','구름','비','눈','안개','햇빛','달빛','별빛',
            '시간','공간','세계','세상','현실','꿈','미래','과거','역사','사회',
            '사람','인간','동물','식물','나무','꽃','풀','돌','흙','모래',
            '전화','문자','편지','소식','연락','대화','약속','계약','거래','선물',
            '사진','그림','영화','음악','노래','춤','게임','운동','여행','산책',
            '옥정','문장','단어','글자','숫자','이름','제목','내용','의미','뜻',
            // ★ 두 글자 오탐 방지 (위치/방향/상태)
            '옆에','앞에','위에','밑에','속에','안에','밖에','뒤에','곁에','쪽에',
            '편에','사이','중간','근처','주변','건너','맞은','뒤편','앞쪽','뒷쪽',
            '좌측','우측','상단','하단','중앙','내부','외부','측면','정면','후면',
            '자리','위치','장소','지점','구역','영역','방면','방향','경로','통로',
            '입구','출구','모퉁이','코너','끝자락','가장자리',
            // ★ 두 글자 오탐 방지 (동작/상태)
            '정도','하루','이틀','사흘','나흘','며칠','매일','어젯','오늘','내일',
            '모레','항상','가끔','잠시','잠깐','아직','벌써','이미','드디어','겨우',
            '먼저','나중','다시','또다','금방','당장','곧바','즉시','바로','이내',
            '갑자','급히','빨리','천천','살짝','슬쩍','몰래','조용','가만','그냥',
            '혼자','함께','같이','서로','각자','따로','직접','간접',
            // ★ 두 글자 오탐 방지 (관계/호칭)
            '오빠','언니','누나','형아','동생','아빠','엄마','아들','딸','조카',
            '친구','선배','후배','동료','상사','부하','아군','적군','동맹',
            '선생','학생','의사','간호','경찰','군인','장교','병사','대위','중위',
            '소위','대령','중령','소령','대장','중장','소장','원수','병장','상병',
            '일병','이등','하사','중사','상사','소총','저격',
            // ★ 두 글자 오탐 방지 (사물/기타)
            '총알','탄창','칼날','화살','방패','갑옷','헬멧','무전','통신',
            '담배','라이터','시가','성냥','연기','재떨이',
            '열쇠','자물','손잡','문고','창틀','난간','계단','복도','천정',
            '지붕','담장','울타리','철조','바리','장벽','기둥','지하','옥상',
            '대문','뒷문','쪽문','현관','정원','화단','잔디','연못',
            '의식','무의식','직감','본능','반사','경험','감각','인식','판단','결정',
            '기술','능력','실력','경험','자격','권한','의무','책임','규칙','규율',
            // ★ 한국어 형용사/부사 오탐 방지 (~적, ~적인, ~스러운 등)
            '일반적','일반적인','전반적','전반적인','기본적','기본적인','전형적','전형적인',
            '공식적','공식적인','비공식','개인적','개인적인','사회적','국제적','역사적',
            '일시적','일시적인','영구적','임시적','물리적','심리적','정신적','육체적',
            '논리적','감정적','이성적','본능적','직관적','객관적','주관적','상대적','절대적',
            '극적','극적인','비극적','희극적','낭만적','현실적','이상적','합리적','비합리적',
            '효과적','실질적','구체적','추상적','일방적','상호적','전략적','전술적',
            '일반','보통','평범','특별','특수','정상','비정상','자연스','부자연',
            // ★ 성인 RP 오탐 방지 (야한 씬에서 장소로 잡히는 단어들)
            '정액','절정','쾌감','오르가즘','흥분','자극','쾌락','욕정','정욕','욕망',
            '사정','삽입','애무','전희','후희','관계','체위','속도','강도','리듬',
            '신음','숨결','호흡','땀','열기','온기','체온','떨림','경련','수축',
            '엉덩이','골반','허벅지','사타구니','가랑이','겨드랑이','젖꼭지',
            // ★ 조사 붙은 형태 + 캐릭터 한국어명 오탐 방지
            '통을','것을','곳을','때를','말을','날을','밤을','손을','눈을','입을',
            '알레한드','알레한드로','호랑이','프라이스','고스트','솝','쾨니히','쾨니그',
            '맥태비시','가즈','라스웰','셰퍼드','니콜라이','파라','로즈','발레리아',
            '홍진','예린','지훈','민수','서연','하은','수빈','도윤','지우','시우',
        ];
        this.singleKo = ['집','방','숲','강','산','역','관','점','원','장'];

        // 영어 장소 단어 (경유지 제외, mart 추가!)
        this.placeWords = [
            'hall','room','house','home','office','station','tower','castle',
            'church','temple','school','academy','library','museum','hospital',
            'shop','store','market','mart','supermarket','grocery','convenience',
            'cafe','restaurant','bar','pub','tavern','inn','hotel',
            'park','garden','forest','beach','lake',
            'plaza','square','palace','manor','mansion','apartment','building',
            'kitchen','bedroom','bathroom','basement','attic','garage','living room',
            'gym','arena','stadium','court','field','ground',
            'base','camp','bunker','barracks','armory','quarters','dormitory','dorm',
            'lab','laboratory','workshop','warehouse','prison','dungeon','cave',
            'dock','port','harbor','airport','terminal',
            'lounge','lobby','chamber','cafeteria','canteen',
            'club','center','centre','studio','nursery','clinic','salon','theater','theatre',
        ];

        this.engMoveVerbs = [
            'headed to','walked to','went to','arrived at','arrived in','moved to',
            'returned to','ran to','rushed to','hurried to',
            'entered','reached','reach','reaches','reaching','marched to',
            'stepped into','burst into','stormed into','step into','pull into','pulled into',
            'made it to','make it to','got to','get to','stop by','stopped by','head into','heading to','heading into','landed at','landed in',
            'headed home','went home','got home','came home',
            'drove to','traveled to','flew to','took a taxi to',
            'made it to','pulled up to','showed up at',
        ];

        this.skipMods = [
            'the','a','an','this','that','its','his','her','their','my','our',
            'old','new','big','small','dark','bright','lit','large','little',
            'very','quite','really','pretty','rather','fairly','super','ultra',
            'metal','wooden','stone','steel','stainless','plastic','heavy',
            'entered','reached','left','to','at','into','from','of','in','on',
            'toward','towards','inside','through','open',
            // 시간/동작 수식어 (After returning home 오탐 방지)
            'after','before','while','during','upon','until','since',
            'returning','coming','going','leaving','heading','walking','running',
            'passing','following','approaching','entering','exiting',
            'back','just','then','still','already','finally','eventually',
            'nearby','near','around','along','across','over','under','behind',
            'quickly','slowly','suddenly','further','closer',
            'damn','goddamn','fucking','fuckin','freaking','bloody','stupid','holy',
        ];

        // 인명 호칭 (bug 21)
        this.namePrefix = ['mr','mrs','ms','miss','dr','captain','colonel','sergeant','general','professor','officer','sir','madam','lady','lord'];

        // placeWord 뒤에 이게 오면 장소 아님 (bug 18: "apartment door lock")
        this.notPlaceSuffix = [
            'door','key','wall','window','floor','lock','roof','ceiling','gate','sign','number','building','complex',
            'chair','desk','soap','table','lamp','shirt','staff','worker','work','supplies','equipment',
            'bell','exam','sandwich','party','chart','code','stool','counter','screen','page','button',
            'service','temperature','uniform','bus','gown',
        ];

        // #36: 도시명 감지 — 주요 도시/지역명 (한/영)
        this.cityNames = [
            // 한국
            '서울','부산','대구','인천','광주','대전','울산','세종','수원','성남',
            '고양','용인','창원','청주','전주','천안','안산','남양주','화성','평택',
            '제주','포항','김해','파주','시흥','안양','군포','하남','양산','광명',
            '밀양','거제','통영','고성','사천',
            // 일본
            '도쿄','오사카','교토','요코하마','나고야','삿포로','후쿠오카','고베','히로시마','센다이','나라',
            // 중국
            '베이징','상하이','광저우','선전','항저우','난징','충칭','청두','시안','우한',
            // 영미
            'Seoul','Busan','Tokyo','Osaka','Kyoto','Beijing','Shanghai',
            'New York','Los Angeles','Chicago','London','Paris','Berlin','Rome',
            'Madrid','Barcelona','Amsterdam','Vienna','Moscow','Sydney','Toronto',
            'Vancouver','San Francisco','Seattle','Boston','Washington','Miami',
            'Las Vegas','Houston','Dallas','Atlanta','Denver','Phoenix','Portland',
            'Munich','Hamburg','Zurich','Geneva','Brussels','Prague','Warsaw',
            'Budapest','Stockholm','Oslo','Helsinki','Copenhagen','Dublin','Edinburgh',
            'Singapore','Bangkok','Manila','Jakarta','Hanoi','Taipei','Mumbai','Delhi',
            'Cairo','Dubai','Istanbul','Athens','Lisbon','Rio','São Paulo',
            // 국가 (한국어) — "내일 한국 갈거야" 등
            '한국','대한민국','일본','중국','미국','영국','프랑스','독일','이탈리아','스페인','캐나다','호주','멕시코','브라질','인도','태국','베트남','필리핀','인도네시아','싱가포르','러시아','네덜란드','스위스','스웨덴','터키','이집트','그리스','포르투갈','아일랜드','오스트리아',
            // 국가 (영어)
            'Korea','South Korea','Japan','China','United States','France','Germany','Italy','Spain','Canada','Australia','Mexico','Brazil','India','Thailand','Vietnam','Philippines','Indonesia','Singapore','Russia','Netherlands','Switzerland','Sweden','Turkey','Egypt','Greece','Portugal','Ireland','Austria',
            // 추가 도시/관광지
            '칸쿤','카보','괌','하와이','발리','세부','다낭','오키나와','니스','베네치아','피렌체',
            'Cancun','Cabo San Lucas','Guam','Hawaii','Bali','Cebu','Okinawa','Nice','Venice','Florence',
            // 미주/유럽 도시 (한국어 표기) — AI가 한국어로 쓸 때
            '뉴욕','로스앤젤레스','샌프란시스코','시카고','런던','파리','베를린','로마','마드리드','바르셀로나','암스테르담',
        ];
    }

    // ========== 등록된 장소 감지 (case-insensitive!) ==========
    detect(text) {
        if (!text || this.lm.locations.length === 0) return null;
        const clean = this._strip(text).toLowerCase();
        const hasFut = this.futureKw.some(k => clean.includes(k));
        let best = null;

        for (const loc of this.lm.locations) {
            for (const name of [loc.name, ...(loc.aliases || [])]) {
                if (!name || name.length < 1) continue;
                const nameLo = name.toLowerCase();
                for (const idx of this._findAllStrict(clean, nameLo)) {
                    if (this._isObjectUse(clean, idx, nameLo)) continue;
                    const inDlg = this._inDlg(clean, idx);
                    const before = clean.substring(Math.max(0, idx - 48), idx).trimEnd();
                    const after = clean.substring(idx + nameLo.length, idx + nameLo.length + 40);
                    const near = clean.substring(Math.max(0, idx - 45), Math.min(clean.length, idx + nameLo.length + 55));

                    // 같은 confidence면 뒤쪽 위치 우선 (최종 목적지)
                    const better = (c, i) => !best || c > best.confidence || (c === best.confidence && i > best.pos);

                    // A named source ("left Club", "클럽에서 나왔다") is not the destination.
                    if (!inDlg && this.departureSuffix.some(pattern => pattern.test(after))) continue;
                    if (!inDlg && this.suffixPat.some(p => p.test(after)) && !hasFut) {
                        const c = 0.95; if (better(c, idx)) best = { location: loc, type: 'move', confidence: c, pos: idx }; continue;
                    }
                    const directEnglishMove = this.engMoveVerbs.some(verb => {
                        const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        return new RegExp(`${escaped}(?:\\s+the)?\\s*$`, 'i').test(before);
                    });
                    if (!inDlg && directEnglishMove && !hasFut) {
                        const c = 0.95; if (better(c, idx)) best = { location: loc, type: 'move', confidence: c, pos: idx }; continue;
                    }
                    if (!inDlg && this.presSuffix.some(p => p.test(after))) {
                        const c = 0.7; if (better(c, idx)) best = { location: loc, type: 'present', confidence: c, pos: idx }; continue;
                    }
                    if (this.moveKw.some(k => near.includes(k)) && !hasFut) {
                        const c = inDlg ? 0.6 : 0.85; if (better(c, idx)) best = { location: loc, type: 'move', confidence: c, pos: idx }; continue;
                    }
                    if (this.presKw.some(k => near.includes(k))) {
                        const c = inDlg ? 0.4 : 0.6; if (better(c, idx)) best = { location: loc, type: 'present', confidence: c, pos: idx }; continue;
                    }
                    if (inDlg) {
                        const dl = this._getDlg(clean, idx);
                        if (dl && dl.trim().length < nameLo.length + 15 && !hasFut) {
                            const c = 0.55; if (better(c, idx)) best = { location: loc, type: 'move', confidence: c, pos: idx };
                        }
                    }
                }
            }
        }
        return (best && (best.type === 'move' || best.type === 'present')) ? best : null;
    }

    // ========== 미등록 장소 발견 (mode: 'user'=높은감도, 'ai'=엄격) ==========
    // 여러 장소 언급 시 마지막 장소 반환 (최종 목적지)
    detectNewPlace(text, mode = 'user') {
        if (!text) return null;
        const clean = this._strip(text);
        if (this.futureKw.some(k => clean.toLowerCase().includes(k))) return null;
        const nar = clean.replace(/"[^"]*"/g,' ').replace(/「[^」]*」/g,' ').replace(/"[^"]*"/g,' ');
        let lastFound = null;

        // v0.9.35: 알려진 도시/지역/국가가 이동 맥락과 함께 나오면 최우선 — 조각 단어(교차로→"교차", 카보 산 루카스→"루카스") 오인 방지
        const earlyCity = this._detectCity(nar);
        if (earlyCity) return earlyCity;

        // 한국어 방법 1: 조사 패턴 — USER만
        if (mode === 'user') {
            const pPat = /([가-힣]{1,8}?)(?:으로|에서|에|의|로)\s/g;
            const moveRx = /걸어[가간갔]|돌아[가간왔옴]|들어[가간서섰]|나[서섰왔]|향[하해했]/;
            for (const para of nar.split(/\n+/)) {
                const hasM = this.moveKw.some(k => para.includes(k)) || moveRx.test(para);
                if (!hasM) continue;
                pPat.lastIndex = 0; let m;
                while ((m = pPat.exec(para)) !== null) {
                    const tail = para.substring(m.index + m[0].length, m.index + m[0].length + 18);
                    if (/(?:나와|나왔|나서|나섰|떠나|떠났|벗어나|빠져나)/.test(tail)) continue;
                    let c = m[1].trim().replace(/으$/, '');
                    if (this._validKo(c)) { lastFound = c; }
                }
            }
        }

        // 한국어 방법 2: 직접 패턴 — USER/AI 모두
        const dPat = [
            /([가-힣]{1,8}?)(?:으로|로)\s*(?:향하|가|갔|간다|걸어|이동|달려|돌아|출발)/g,
            /([가-힣]{1,8}?)에\s*(?:도착|당도|들어서|들어섰|왔다|갔다|간다)/g,
        ];
        for (const p of dPat) {
            p.lastIndex=0; let m;
            while ((m = p.exec(nar)) !== null) {
                if (m[1]) {
                    let c = m[1].trim().replace(/으$/, '');
                    if (this._validKo(c)) { lastFound = c; }
                }
            }
        }

        if (lastFound) return lastFound;

        // 영어: "headed home" 특수 처리
        if (/\b(?:headed|went|got|came|arrived|returned|returning)\s+home\b/i.test(nar)) {
            if (!this.lm.findByNameExact('Home')) return 'Home';
        }

        // 영어 방법 3: 이동 동사 + 장소 단어
        const lo = nar.toLowerCase();
        if (this.engMoveVerbs.some(v => lo.includes(v)) || /\b(?:into|inside|toward|towards)\b/.test(lo)) {
            const r = this._engDet(nar, true); if (r) return r;
        }

        // 영어 방법 4: 존재/묘사 — USER만
        if (mode === 'user') {
            const r2 = this._engDet(nar, false); if (r2) return r2;
        }

        // 도시명 감지 — USER/AI 모두
        const cityResult = this._detectCity(nar);
        if (cityResult) return cityResult;

        return null;
    }

    _engDet(nar, moveOnly) {
        const sents = nar.split(/[.!?]+/).filter(s => s.trim());
        for (const sent of sents) {
            const lo = sent.toLowerCase();
            const hasM = this.engMoveVerbs.some(v => lo.includes(v)) || /\b(?:into|toward|towards)\b/.test(lo);
            if (moveOnly && !hasM) continue;
            if (!moveOnly && hasM) continue;
            if (!moveOnly && !/\b(?:in|inside|within|at|of|around)\s+(?:the|a|his|her|my|your|their|our)\b/.test(lo) && !/\bthe\s+/.test(lo) && !/\b(?:in|inside|at)\s+\w+'s\b/.test(lo)) continue;

            for (const pw of this.placeWords) {
                if (this.transitEn.includes(pw)) continue;
                const rx = new RegExp('\\b' + pw + '(?:s)?\\b', 'i');
                const m = lo.match(rx); if (!m) continue;
                const idx = m.index;

                // Bug 21: 인명 체크 — "Mrs. Park" 스킵
                const beforeFull = sent.substring(Math.max(0, idx - 15), idx).trim().toLowerCase();
                if (this.namePrefix.some(np => beforeFull.endsWith(np) || beforeFull.endsWith(np + '.'))) continue;

                // Bug 18: 뒤에 비장소 명사 오면 스킵 — "apartment door lock"
                const afterWord = lo.substring(idx + m[0].length).trim().split(/\s+/)[0] || '';
                if (this.notPlaceSuffix.includes(afterWord)) continue;

                const before = sent.substring(0, idx).trim().split(/\s+/).filter(Boolean);
                const actual = sent.substring(idx, idx + m[0].length).trim();
                let name = actual;
                const mods = before.slice(-2).filter(w => !this.skipMods.includes(w.toLowerCase()) && !this._isSkip(w) && !w.includes('-') && w.length > 1);
                if (mods.length) name = mods.join(' ') + ' ' + actual;
                name = name.charAt(0).toUpperCase() + name.slice(1);
                if (name.length >= 3 && name.length <= 30 && !this.lm.findByNameExact(name)) {
                    return name;
                }
            }
        }
        return null;
    }

    // #36: 도시명 감지
    // ========== 설명문에서 장소 추출 (이동 동사 없이) ==========
    detectFromDescription(text) {
        if (!text) return null;
        const clean = this._strip(text);
        const lo = clean.toLowerCase();

        // 1) 도시명 매칭 (Bug F: 영어는 단어 경계 체크)
        const foodCtx = /chocolate|coffee|tea|cake|cookie|pizza|burger|steak|food|cuisine|restaurant|dish|recipe|flavor|taste|spice/i;
        for (const city of this.cityNames) {
            if (this.lm.findByNameExact(city)) continue;
            // ★ 음식/브랜드 맥락이면 도시명 스킵 ("Dubai chocolate" → 스킵)
            if (foodCtx.test(clean)) continue;
            if (/[a-zA-Z]/.test(city)) {
                const rx = new RegExp('\\b' + city.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
                if (rx.test(clean)) return city;
            } else {
                if (lo.includes(city.toLowerCase())) return city;
            }
        }

        // 2) 영어 placeWord 매칭 ("SAS base", "royal palace")
        for (const pw of this.placeWords) {
            if (this.transitEn.includes(pw)) continue;
            const rx = new RegExp('\\b(\\w+\\s+)?' + pw + '(?:s)?\\b', 'i');
            const m = clean.match(rx);
            if (!m) continue;
            let name = m[0].trim();
            const words = name.split(/\s+/);
            if (words.length > 1 && this.skipMods.includes(words[0].toLowerCase())) name = words.slice(1).join(' ');
            // ★ 음식/사물 + placeWord 조합 스킵 ("Chocolate bar", "Iron bar", "Towel rack")
            if (words.length > 1 && this._isSkip(words[0])) continue;
            // ★ 선행 관사/접속사 제거 ("And gynecology clinic" → "gynecology clinic")
            name = name.replace(/^(?:And|The|A|An|Or|But|In|On|At|Of|For|By|To)\s+/i, '');
            name = name.charAt(0).toUpperCase() + name.slice(1);
            // ★ 서브장소 키워드 단독이면 독립 장소 등록 안 함 (#11)
            const bareSubKw = /^(?:room|kitchen|bathroom|bedroom|living\s*room|hall|lobby|office|garage|basement|attic|balcony|거실|부엌|주방|침실|화장실|방|복도|현관)s?$/i;
            if (bareSubKw.test(name)) continue;
            if (name.length >= 3 && name.length <= 30 && !this.lm.findByNameExact(name)) {
                return name;
            }
        }

        // 3) 한국어 장소 키워드
        const koPlaces = /([가-힣]{2,6}(?:기지|부대|학교|마을|도시|왕국|성|궁|사원|신전|숲|섬|산|강|호수|바다))/g;
        let km;
        while ((km = koPlaces.exec(clean)) !== null) {
            const c = km[1];
            if (!this.skipKo.includes(c) && !this.lm.findByNameExact(c)) {
                return c;
            }
        }
        return null;
    }

    // 알려진 도시 → "City, Country" 영문 쿼리 (다국어 검색 정확도 보강)
    cityGeoQuery(name) {
        if (!name) return name;
        const hint = {
            // 일본
            '도쿄':'Tokyo, Japan','오사카':'Osaka, Japan','교토':'Kyoto, Japan','요코하마':'Yokohama, Japan',
            '나고야':'Nagoya, Japan','삿포로':'Sapporo, Japan','후쿠오카':'Fukuoka, Japan','고베':'Kobe, Japan',
            '히로시마':'Hiroshima, Japan','센다이':'Sendai, Japan','나라':'Nara, Japan','오키나와':'Okinawa, Japan',
            // 중국
            '베이징':'Beijing, China','상하이':'Shanghai, China','광저우':'Guangzhou, China','선전':'Shenzhen, China',
            '항저우':'Hangzhou, China','난징':'Nanjing, China','충칭':'Chongqing, China','청두':'Chengdu, China',
            '시안':"Xi'an, China",'우한':'Wuhan, China',
            // 미주/유럽 (한국어 표기)
            '뉴욕':'New York, USA','로스앤젤레스':'Los Angeles, USA','샌프란시스코':'San Francisco, USA',
            '시카고':'Chicago, USA','런던':'London, UK','파리':'Paris, France','베를린':'Berlin, Germany',
            '로마':'Rome, Italy','마드리드':'Madrid, Spain','바르셀로나':'Barcelona, Spain','암스테르담':'Amsterdam, Netherlands',
            // 관광지
            '칸쿤':'Cancun, Mexico','카보':'Cabo San Lucas, Mexico','괌':'Guam','하와이':'Honolulu, Hawaii, USA',
            '발리':'Bali, Indonesia','세부':'Cebu, Philippines','다낭':'Da Nang, Vietnam',
            '니스':'Nice, France','베네치아':'Venice, Italy','피렌체':'Florence, Italy',
            // 국가
            '한국':'South Korea','대한민국':'South Korea','일본':'Japan','중국':'China','미국':'United States',
            '영국':'United Kingdom','프랑스':'France','독일':'Germany','이탈리아':'Italy','스페인':'Spain',
            '캐나다':'Canada','호주':'Australia','멕시코':'Mexico','브라질':'Brazil','인도':'India',
            '태국':'Thailand','베트남':'Vietnam','필리핀':'Philippines','인도네시아':'Indonesia',
        };
        return hint[name] || name;
    }

    // v0.9.36: 장소 이름 안에 알려진 도시/지역/국가가 들어있으면 반환 (지오코딩 폴백용, 이동 맥락 불필요)
    cityInName(name) {
        if (!name) return null;
        const lo = name.toLowerCase();
        let best = null;
        for (const city of this.cityNames) {
            const cl = city.toLowerCase();
            if (/[a-zA-Z]/.test(city)) {
                const rx = new RegExp('\\b' + cl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
                if (!rx.test(name)) continue;
            } else {
                if (!lo.includes(cl)) continue;
            }
            if (!best || city.length > best.length) best = city; // 더 구체적인(긴) 지명 우선
        }
        return best;
    }

    _detectCity(text) {
        const lo = text.toLowerCase();
        // 이동 맥락 확인
        const hasMove = this.moveKw.some(k => lo.includes(k)) ||
            /비행기|기차|KTX|버스|택시|배|여객선|페리/i.test(text) ||
            /\b(?:flight|train|bus|taxi|ferry)\b/i.test(text);
        if (!hasMove) return null;

        for (const city of this.cityNames) {
            const cityLo = city.toLowerCase();
            // Bug F: 단어 경계 체크 (영어) — "rio"가 "mario" 안에서 매칭 방지
            if (/[a-zA-Z]/.test(city)) {
                const rx = new RegExp('\\b' + cityLo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
                if (!rx.test(text)) continue;
            } else {
                if (!lo.includes(cityLo)) continue;
            }
            if (this.lm.findByNameExact(city)) continue;
            const idx = lo.indexOf(cityLo);
            const before = text.substring(Math.max(0, idx - 20), idx).trim().toLowerCase();
            if (this.namePrefix.some(np => before.endsWith(np) || before.endsWith(np + '.'))) continue;
            return city;
        }
        return null;
    }

    _validKo(c) {
        if (!c) return false;
        if (c.length === 1) return this.singleKo.includes(c);
        if (c.length > 8) return false;
        if (this.lm.findByNameExact(c)) return false;
        if (this.skipKo.includes(c)) return false;
        if (c.length === 2 && /[을를이가에은는도로서]$/.test(c)) return false;
        // ★ 한국어 형용사/부사 접미사 → 장소 아님
        if (/[적]인?$|스러[운운]|[답]게?$|[롭]게?$/.test(c)) return false;
        // ★ 두 글자 한글: 조사 붙은 형태, 순수 동사/형용사 어근 필터
        if (c.length === 2 && /^[가-힣]{2}$/.test(c)) {
            // 동사/형용사 어근 (X다, X고, X며, X면, X서, X니, X게, X지, X듯, X적)
            if (/[다고며면서니게지듯적]$/.test(c)) return false;
        }
        return true;
    }

    // ★ skipKo + skipEn 통합 체크 (약속 장소 감지 등에서 사용)
    _isSkip(place) {
        if (!place) return true;
        const lower = place.toLowerCase();
        if (this.skipKo.includes(place)) return true;
        if (this.skipKo.includes(lower)) return true;
        // 영어 2글자 이하 → 무조건 스킵 (장소명은 최소 3글자)
        if (/^[a-zA-Z]+$/.test(place) && place.length <= 2) return true;

        // v0.8.25: 강력한 오탐 필터 추가
        // 1) 숫자만 있으면 스킵 ("10", "42", "123")
        if (/^[\d\s.,]+$/.test(place)) return true;
        // 2) 구두점 포함 → 스킵 (쉼표, 세미콜론, 따옴표 등)
        if (/[,;:!?"'`]/.test(place)) return true;
        // 3) 공백 3개 이상 = 4단어 이상 → 장소명 아님 (진짜 지명은 1~3단어)
        const spaceCount = (place.match(/\s/g) || []).length;
        if (spaceCount >= 3) return true;
        // 4) 끝이 ... 또는 - 으로 끝나면 잘린 텍스트 → 스킵
        if (/[-…]+$/.test(place.trim())) return true;
        // 5) 영어 과거형(-ed) / 진행형(-ing) 단어로 시작하면 장소 아님 (scanned room, running track ×)
        //    실제 지명은 거의 없음 (United는 고유명사라 대문자 시작이니 OK, 여기는 소문자만 체크)
        const firstWord = place.split(/\s+/)[0].toLowerCase();
        if (/^[a-z]+(ed|ing)$/.test(firstWord) && firstWord.length >= 5) {
            // 예외: "United States", "Crossing" 같은 지명
            const edIngExceptions = new Set(['united','crossing','wedding','trading','building','landing']);
            if (!edIngExceptions.has(firstWord)) return true;
        }
        // 6) 영어 동사로 시작하는 구문 ("say thank you", "make coffee" 등)
        //    say/make/do/get/take 등으로 시작하는 다단어 → 장소 아님
        const verbStarters = new Set([
            'say','says','saying','make','makes','making','do','does','doing',
            'get','gets','getting','take','takes','taking','give','gives','giving',
            'go','goes','going','come','comes','coming','see','sees','seeing',
            'know','knows','knowing','think','thinks','thinking','want','wants',
            'need','needs','needing','feel','feels','feeling','look','looks','looking',
            'find','finds','finding','tell','tells','telling','ask','asks','asking',
            'try','tries','trying','call','calls','calling','work','works','working',
            'seem','seems','seeming','leave','leaves','leaving','help','helps','helping',
            'talk','talks','talking','turn','turns','turning','start','starts','starting',
            'show','shows','showing','hear','hears','hearing','play','plays','playing',
            'run','runs','running','move','moves','moving','live','lives','living',
            'believe','bring','happen','write','provide','sit','stand','lose','pay','meet',
            'include','continue','set','learn','change','lead','understand','watch','follow',
            'stop','create','speak','read','allow','add','spend','grow','open','walk','win',
            'offer','remember','love','consider','appear','buy','wait','serve','die','send',
            'expect','build','stay','fall','cut','reach','kill','remain'
        ]);
        if (spaceCount >= 1 && verbStarters.has(firstWord)) return true;
        // 7) "you", "he", "she", "it" 등 대명사로 시작 → 장소 아님
        const pronounStarters = new Set(['you','he','she','it','we','they','i','me','my','your','his','her','our','their']);
        if (spaceCount >= 1 && pronounStarters.has(firstWord)) return true;
        // 8) 순수 영소문자만 있고 길이 5+ 공백 있으면 의심 (고유명사면 보통 대문자 시작)
        //    단, "rue de ~" 같은 프랑스 지명 예외
        if (spaceCount >= 1 && /^[a-z\s]+$/.test(place) && place.length > 8) {
            const lowerPrefixes = new Set(['rue','via','avenida','calle','plaza','piazza']);
            if (!lowerPrefixes.has(firstWord)) return true;
        }

        // ★ 영어 -ly 부사 → 무조건 스킵 (terribly, quickly, slowly...)
        // 단, 실제 지명은 제외 (Sicily, Beverly, Holly, Bali...)
        const lyExceptions = new Set(['sicily','beverly','holly','bali','italy','family','rally','alley','valley','assembly','embassy']);
        if (/^[a-zA-Z]+ly$/i.test(place) && place.length >= 5 && !lyExceptions.has(lower)) return true;
        // 영어 일반 명사/대명사/관사/접미사 필터
        const skipEn = ['the','a','an','this','that','here','there','where','my','your','his','her',
            'place','somewhere','anywhere','nowhere','outside','inside','back','front','home',
            'way','side','thing','stuff','part','end','top','bottom','left','right','it','me',
            'th','st','nd','rd','am','pm','vs','mr','ms','dr','etc','aka',
            'and','but','for','not','with','from','into','over','under','between',
            'very','just','also','only','even','still','already','never','always',
            'said','told','asked','went','came','got','had','was','were','been',
            'can','will','shall','may','might','could','would','should',
            'them','they','their','its','our','him','she','who','what','how','why','when',
            'family','supply','tactical','quick','little','big','small','great','good','bad',
            'nice','proper','simple','easy','hard','long','short','new','old','real',
            'whole','entire','full','half','daily','weekly','morning','evening','night',
            'emergency','routine','regular','special','secret','final','last','first','next',
            'immediate','absolute','terrible','beautiful','brilliant','bloody','fucking',
            'civilian','military','tactical','strategic','operational','critical','vital',
            'another','other','same','such','much','many','some','any','every','each',
            'after','before','during','since','until','while','about','around','through',
            'again','away','down','off','out','up','near','far','above','below',
            // ★ RP 캐릭터 이름 오탐 방지
            'price','soap','ghost','gaz','alejandro','horangi','könig','konig','valeria',
            'captain','lieutenant','sergeant','corporal','private','commander','general',
            'doctor','nurse','professor','teacher','master','boss','chief','sir','madam',
            // ★ 사물/도구 오탐 방지
            'tablet','phone','laptop','computer','screen','monitor','keyboard','radio',
            'weapon','rifle','pistol','gun','knife','sword','grenade','bullet','magazine',
            'chair','table','desk','bed','sofa','couch','door','window','wall','floor',
            'plate','cup','mug','glass','bottle','bowl','spoon','fork','paper','card',
            'bag','box','case','pack','kit','vest','mask','hood','helmet','boot','glove',
            'toe','finger','hand','arm','leg','foot','head','face','eye','ear','nose','mouth','lip','neck','shoulder','knee','chest','chin',
            // 🚫 일반 명사/형용사 오탐 (v0.6.0 r11)
            'facility','facilities','scattered','blood','bloody','scattered','torn','broken','damaged','destroyed','ruined','burning','burnt','frozen','shattered','wounded','injured','dead','dying','silent','empty','crowded','abandoned','deserted','forgotten','hidden','secret','mysterious','unknown','familiar','strange','weird','normal','usual','regular','sudden','random','various','several','countless','numerous','endless','infinite','massive','huge','tiny','small','big','giant','enormous','distant','nearby','far','close','inside','outside','above','below','beyond','within','across','through','around','beside','behind','ahead','near','away','together','apart',
            // 혈액/신체 관련
            'flesh','skin','bone','muscle','nerve','vein','artery','tissue','organ','heart','brain','lung','liver','kidney','stomach','throat','spine',
            // 상태/감정 관련
            'anger','rage','fury','fear','terror','panic','shock','horror','pain','agony','sorrow','grief','joy','happiness','love','hate','rage','calm','peace','chaos','silence','noise','darkness','brightness','warmth','coldness',
            // 액션/상황
            'attack','defense','retreat','advance','fight','battle','war','peace','escape','rescue','mission','operation','briefing','debrief','training','exercise','practice','drill','patrol','watch','guard','duty','shift',
            'clear','clean','dark','bright','warm','cold','hot','cool','wet','dry','loud','quiet','soft','rough','sharp','dull','tight','loose',
            // ★ 성인 RP 오탐 방지
            'cum','climax','orgasm','thrust','moan','groan','pant','gasp','shudder',
            'breast','chest','thigh','hip','groin','crotch','nipple','cock','dick',
            'arousal','erection','penetration','rhythm','pace','intensity','friction',
            // ★ 음식/물건 + placeWord 조합 오탐 방지
            'chocolate','coffee','protein','candy','snack','energy','cereal','granola',
            'iron','steel','crow','towel','mini','wet','dry','cold','hot','raw',
            'sleep','asleep','awake','rest','nap','dream','wake','eat','drink','cook',
            'walk','talk','watch','wait','sit','stand','run','hide','fight','work',
            'fix','fixed','fixing','break','broken','clean','open','close','lock','pull','push',
            'terribly','horribly','incredibly','absolutely','completely','entirely','perfectly',
            'slowly','quickly','quietly','loudly','gently','roughly','softly','hardly','barely'];
        if (skipEn.includes(lower)) return true;
        if (place.length <= 1) return true;
        return false;
    }

    _strip(t) { return t.replace(/<[^>]+>/g,'').replace(/\*{1,2}([^*]+)\*{1,2}/g,'$1').replace(/_{1,2}([^_]+)_{1,2}/g,'$1').replace(/\[([^\]]*)\]/g, '$1'); }
    _findAll(t,n) { const r=[]; let p=0; while(true){ const i=t.indexOf(n,p); if(i===-1)break; r.push(i); p=i+1; } return r; }
    _findAllStrict(text, name) {
        return this._findAll(text, name).filter(index => this._hasNameBoundary(text, name, index));
    }
    _hasNameBoundary(text, name, index) {
        const before = index > 0 ? text[index - 1] : '';
        const after = text[index + name.length] || '';
        const startsLatin = /^[a-z0-9]/i.test(name);
        const endsLatin = /[a-z0-9]$/i.test(name);
        if (startsLatin && before && /[a-z0-9]/i.test(before)) return false;
        if (endsLatin && after && /[a-z0-9]/i.test(after)) return false;

        if (/^[가-힣]+$/.test(name)) {
            if (before && /[가-힣a-z0-9]/i.test(before)) return false;
            if (after && /[가-힣]/.test(after)) {
                const tail = text.slice(index + name.length, index + name.length + 4);
                if (!/^(?:으로|에서|에게|로|에|을|를|의|은|는|이|가|와|과)/.test(tail)) return false;
            }
            if (name.length === 1 && !['집', '방', '역', '산', '강'].includes(name)) return false;
        }
        return true;
    }
    _isObjectUse(text, index, name) {
        if (!/^[a-z]+$/i.test(name) || !this.placeWords.includes(name)) return false;
        const tail = text.slice(index + name.length, index + name.length + 32);
        return /^\s+(?:of\b|chair\b|desk\b|door\b|key\b|wall\b|window\b|floor\b|soap\b|table\b|lamp\b|shirt\b|staff\b|worker\b|work\b|supplies\b|equipment\b|bell\b|exam\b|sandwich\b|party\b|chart\b|code\b|stool\b|counter\b|screen\b|page\b|button\b|service\b|temperature\b|uniform\b|bus\b|gown\b)/i.test(tail);
    }
    _inDlg(t,pos) { const b=t.substring(0,pos); for(const[o,c]of[['"','"'],['"','"'],['「','」']]){const lo=b.lastIndexOf(o);if(lo>-1&&lo>b.lastIndexOf(c))return true;} return false; }
    _getDlg(t,pos) { for(const[o,c]of[['"','"'],['"','"'],['「','」']]){const s=t.lastIndexOf(o,pos);if(s===-1)continue;const e=t.indexOf(c,s+1);if(e>-1&&e>=pos)return t.substring(s+1,e);} return null; }
    _para(t,pos) { const b=t.substring(Math.max(0,pos-200),pos); const a=t.substring(pos,Math.min(t.length,pos+200)); return b.substring(Math.max(b.lastIndexOf('\n'),0))+(a.indexOf('\n')!==-1?a.substring(0,a.indexOf('\n')):a); }

    // ========== 터줏대감 (NPC/동물) 감지 ==========
    detectNPCs(text, userName, charName) {
        const clean = this._strip(text);
        const npcs = [];
        const exclude = new Set([userName?.toLowerCase(), charName?.toLowerCase(), 'user', 'character', 'you', 'i', 'me', 'my', 'he', 'she', 'they', 'it', 'the', 'a', 'an'].filter(Boolean));

        // 1. 대사 화자 감지 — "Name said", Name: "...", Name이/가 말했다
        const speakerPatterns = [
            /(?:^|\n)\s*(\*?\*?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\*?\*?)\s*(?:said|asked|replied|whispered|yelled|muttered|added|growled|snarled|laughed|grinned|sighed|murmured|called|shouted)/gi,
            /[""]([^""]+)[""]\s*(\w+)\s+(?:said|asked|replied)/gi,
            /([\uAC00-\uD7A3]{2,6})(?:이|가|은|는)\s*(?:말했|물었|속삭|외쳤|중얼|대답했|소리쳤|웃으며|한숨)/g,
        ];

        for (const pat of speakerPatterns) {
            let m;
            while ((m = pat.exec(clean)) !== null) {
                const name = (m[2] || m[1]).replace(/\*+/g, '').trim();
                if (name.length >= 2 && name.length <= 20 && !exclude.has(name.toLowerCase())) {
                    npcs.push({ name, type: 'npc', role: '' });
                }
            }
        }

        // 2. 동물 키워드 감지
        const animalKw = {
            ko: [
                [/(?:고양이|냥이|야옹이|길냥)\s*([\uAC00-\uD7A3]{1,6})?/, '고양이'],
                [/(?:강아지|멍멍이|퍼피)\s*([\uAC00-\uD7A3]{1,6})?/, '강아지'],
                [/군견\s*([\uAC00-\uD7A3A-Za-z]{1,10})?/, '군견'],
                [/([\uAC00-\uD7A3A-Za-z]{1,10})(?:라는|이라는)\s*(?:고양이|강아지|군견|개|새|앵무새|햄스터|토끼)/, 'animal'],
            ],
            en: [
                [/(?:cat|kitten|feline)\s+(?:named\s+)?([A-Z][a-z]+)?/i, 'cat'],
                [/(?:dog|puppy|canine|hound)\s+(?:named\s+)?([A-Z][a-z]+)?/i, 'dog'],
                [/(?:military|guard|war)\s*dog\s+(?:named\s+)?([A-Z][a-z]+)?/i, 'military dog'],
                [/([A-Z][a-z]+),?\s+(?:the|a)\s+(?:cat|dog|bird|parrot|hamster|rabbit|horse)/i, 'animal'],
            ],
        };

        for (const patterns of Object.values(animalKw)) {
            for (const [pat, animalType] of patterns) {
                const m = clean.match(pat);
                if (m) {
                    const name = (m[1] || '').trim();
                    if (name && name.length >= 1 && !exclude.has(name.toLowerCase())) {
                        npcs.push({ name, type: 'animal', role: animalType });
                    }
                }
            }
        }

        // 3. 중복 제거 (이름 기준)
        const seen = new Set();
        return npcs.filter(n => {
            const key = n.name.toLowerCase();
            if (seen.has(key) || exclude.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    // ========== 약속 장소 감지 ==========
    detectPromisePlace(text) {
        const clean = this._strip(text);
        const patterns = [
            // 한국어: "내일 ~에서 만나자", "다음에 ~가자", "~에서 보자"
            /(?:내일|모레|다음에|나중에|주말에|이따가|다음달에|다음주에|이번\s*주말에?|이번\s*달에?|다음\s*번에?)\s+(.{1,15}?)(?:에서|에)\s*(?:만나|보자|가자|모이자|만날까|볼까|갈까)/,
            /(.{1,15}?)(?:에서|에)\s*(?:만나자|보자|가자|만날래|볼래|갈래|약속)/,
            // 한국어: "~로 여행가자", "~로 가자", "~에 놀러가자"
            /(?:내일|모레|다음에|나중에|주말에|다음달|다음주|이번주말?)\s*(.{1,15}?)(?:로|으로)\s*(?:여행|놀러|출발|떠나|가자|갈까|가볼까)/,
            /(.{1,15}?)(?:로|으로)\s*(?:여행\s*가자|여행\s*갈까|놀러\s*가자|놀러\s*갈까|떠나자|떠날까|출발)/,
            // 한국어: "테스코 나들이", "마트 장보기", "~쇼핑" (일정/계획 형태)
            /(?:내일|모레|다음에|주말에|다음달|다음주)[.\s]+['"']?(.{1,15}?)\s*(?:나들이|장보기|쇼핑|탐방|투어|가기|방문|데이트)/,
            /[''""](.{1,15}?)\s*(?:나들이|Run|Trip|Shopping|Tour)[''""]/i,
            // 한국어: "~에 가기로", "~갈 예정", "~갈 거야"
            /(.{1,15}?)(?:에|로)\s*(?:가기로|갈\s*예정|갈\s*거[야예]|갈\s*계획|가자고)/,
            // 한국어: 일정/달력/스케줄에 장소 언급
            /(?:일정|달력|스케줄|schedule|calendar)[^.]{0,30}?[''""](.{1,15}?)[''"" ]/i,
            // 영어: "meet at ~", "let's go to ~ tomorrow"
            /(?:tomorrow|next\s+(?:time|week|month)|later|weekend|tonight|this\s+weekend)\s+(?:at|in|to)\s+(.{2,20})/i,
            /(?:meet|see you|let'?s go|travel|trip|visit|head)\s+(?:at|to|in)\s+(.{2,20}?)(?:\s+(?:tomorrow|next|later|tonight|this|soon))?/i,
            /(?:let'?s|we'?ll|we\s+(?:should|could|can|are\s+going\s+to|will|gotta))\s+(?:go|travel|fly|drive|head|visit|hit)\s+(?:to|for)?\s*(.{2,20})/i,
            // 영어: "Tomorrow. 'Tesco Run'" 형태 (일정/계획 스타일)
            /[Tt]omorrow[.\s]+['"']?([A-Z][a-zA-Z]+)\s*(?:Run|Trip|Visit|Shopping|Day|Tour)['"']?/,
            /(?:schedule|calendar|planned|plan)[^.]{0,30}?[''""]([A-Z][a-zA-Z\s]{1,20}?)[''"" ]/i,
            // 영어: "~ tomorrow", "~ this weekend"
            /[''""]([A-Z][a-zA-Z\s]{1,15}?)[''""]\s*\.?\s*(?:tomorrow|next week|this weekend|tonight)/i,
            // 영어: "TESCO RUN", "Tesco run" (대문자 장소 + run/trip)
            /([A-Z][a-zA-Z]+)\s+(?:run|trip|visit|shopping|invasion|mission|outing|excursion)(?:\s|!|\.|\?|$)/i,
            // 영어: "go to Tesco" 느슨한 매칭 (we'll discuss, supply run 등 컨텍스트 무관)
            /(?:go\s+to|head\s+to|hit\s+up|stop\s+by|trip\s+to|run\s+to|visit)\s+([A-Z][a-zA-Z\s']{1,20}?)(?:[.!?,\s]|$)/i,
            // 한국어: "테스코 나들이/장보기/쇼핑" (느슨)
            /([A-Za-z\uAC00-\uD7A3]{2,10})\s*(?:나들이|장보기|쇼핑|탐방|투어|습격|작전|가기|방문)/,
        ];

        for (const pat of patterns) {
            const m = clean.match(pat);
            if (m?.[1]) {
                const place = m[1].replace(/[\[\](){}「」""''",.'!?…:;]+/g, '').replace(/\s+/g, ' ').trim();
                if (place.length >= 1 && place.length <= 15 && !this._isSkip(place)) {
                    return place;
                }
            }
        }
        return null;
    }
}
