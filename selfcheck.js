// index.html 자체검사 — node selfcheck.js
// 산출물 아님(SPEC의 "단일 index.html"은 게임 파일 기준). 지워도 게임은 돈다.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const noop = () => {};

// 실제 파일에서 이미지 크기를 읽는다 (PNG 헤더 / JPEG SOF 마커)
function imageSize(file) {
  const b = fs.readFileSync(file);
  if (b.slice(1, 4).toString() === 'PNG') return { w:b.readUInt32BE(16), h:b.readUInt32BE(20) };
  for (let i = 2; i < b.length - 9; ) {                 // JPEG
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
      return { h:b.readUInt16BE(i + 5), w:b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error('크기를 읽을 수 없음: ' + file);
}

// index.html의 인라인 스크립트를 꺼내 샌드박스에서 실행한다.
// withImages=true 면 실제 파일 크기를 가진 '로딩 완료' 이미지를 흉내낸다.
// Web Audio 스텁 — 실제 API에 없는 걸 쓰면 throw한다. 예약 시각도 기록한다.
function makeAudio(log) {
  let now = 0;
  const param = () => ({
    value: 0,
    setValueAtTime: (v, t) => { chk(t); }, linearRampToValueAtTime: (v, t) => chk(t),
    exponentialRampToValueAtTime: (v, t) => { if (v <= 0) throw new Error('exponentialRamp에 0 이하'); chk(t); },
    cancelScheduledValues: t => chk(t)
  });
  const chk = t => {
    if (typeof t !== 'number' || !isFinite(t)) throw new Error('예약 시각이 숫자가 아님: ' + t);
    if (t < now - 1e-9) throw new Error('과거 시각에 예약: ' + t + ' < ' + now);
  };
  const node = extra => Object.assign({
    connect(d) { if (!d) throw new Error('connect 대상이 없음'); return d; },
    disconnect() {}
  }, extra);
  const ac = {
    get currentTime() { return now; },
    advance(dt) { now += dt; },
    state: 'running', sampleRate: 48000, resume() { this.state = 'running'; },
    destination: node(),
    createGain: () => node({ gain: param() }),
    createOscillator: () => node({
      type: 'square', frequency: param(),
      start(t) { chk(t === undefined ? now : t); log.starts++; },
      stop(t) { chk(t === undefined ? now : t); }
    }),
    createBuffer: (ch, len, sr) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => node({ buffer: null, start(t) { log.starts++; } }),
    createBiquadFilter: () => node({ type: 'lowpass', frequency: { value: 0 } })
  };
  return ac;
}

function load(ctxStub, extraMission, withImages, audioLog) {
  let js = fs.readFileSync(__dirname + '/index.html', 'utf8').split('<script>')[1].split('</script>')[0];
  if (extraMission) js = js.replace('\n];\n\n// ══ 판정', extraMission + '\n];\n\n// ══ 판정');
  js += '\nglobalThis.__t={G,C,MISSIONS,CHECKS,ROUNDS,DUR,TOTAL,MULTS,FX,IMG,ASSET_DIR,obj,inRect,hit,'
      + 'within,wrap180,fit,update,render,judge,resolve,startGame,toTitle,grade,c4Leak,drawGhost,'
      + 'initAudio,bgmTick,bgmStart,bgmStop,duck,SFX,BGM_BPM,wrapLines,para,DUR};';
  const cv = { getContext:()=>ctxStub, addEventListener:noop, style:{},
               getBoundingClientRect:()=>({left:0,top:0,width:540,height:960}) };
  // 기본은 미로딩 상태 → 색 사각형 폴백 경로가 검사된다
  function Img() {
    this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0;
    let src = '';
    Object.defineProperty(this, 'src', {
      get: () => src,
      set: v => {
        src = v;
        if (!withImages) return;
        const p = __dirname + '/' + v;
        if (!fs.existsSync(p)) return;                  // 없으면 폴백 그대로
        const d = imageSize(p);
        this.naturalWidth = d.w; this.naturalHeight = d.h; this.complete = true;
      }
    });
  }
  const sb = { console, performance:{ now:()=>Date.now() }, requestAnimationFrame:noop,
               addEventListener:noop, innerWidth:540, innerHeight:960, Image:Img,
               document:{ getElementById:()=>cv, addEventListener:noop } };
  if (audioLog) {
    const ac = makeAudio(audioLog);
    audioLog.ac = ac;
    sb.AudioContext = function () { return ac; };
  }
  sb.globalThis = sb;                       // AudioContext 없음 → 사운드는 조용히 무시된다
  vm.createContext(sb);
  vm.runInContext(js, sb);
  return sb.__t;
}

// 뭐든 삼키는 ctx (판정 검사용)
const loose = new Proxy({}, { get:(t,k)=> k==='measureText' ? (()=>({width:100}))
  : String(k).startsWith('create') ? (()=>({addColorStop:noop})) : noop, set:()=>true });

// 실제 Canvas2D API에 없는 멤버를 쓰면 throw하는 ctx (렌더 검사용)
const METHODS = new Set('save restore beginPath closePath moveTo lineTo rect roundRect arc fill stroke clip fillRect strokeRect clearRect fillText strokeText measureText translate scale rotate setTransform resetTransform transform createLinearGradient createRadialGradient setLineDash getLineDash drawImage'.split(' '));
const PROPS = new Set('fillStyle strokeStyle lineWidth font textAlign textBaseline globalAlpha globalCompositeOperation lineCap lineJoin shadowBlur shadowColor canvas filter lineDashOffset'.split(' '));
const strict = new Proxy({}, {
  get(t, k) {
    if (typeof k === 'symbol') return undefined;
    if (METHODS.has(k)) return k === 'measureText' ? (()=>({width:100}))
      : String(k).startsWith('create') ? (()=>({addColorStop:noop})) : noop;
    if (PROPS.has(k)) return t[k];
    throw new Error('Canvas2D에 없는 멤버 사용: ctx.' + String(k));
  },
  set(t, k, v) {
    if (!PROPS.has(k)) throw new Error('Canvas2D에 없는 속성 대입: ctx.' + String(k));
    t[k] = v; return true;
  }
});

// 50ms씩 굴려 상태 전이를 하나도 건너뛰지 않게 한다. onState는 전이 시점에만 불린다.
function drive(t, onState, stop) {
  const { G, update } = t;
  let prev = null;
  for (let guard = 0; guard < 20000; guard++) {
    if (G.state !== prev) { prev = G.state; if (onState && onState(G.state) === 'stop') return; }
    if (stop && stop(G.state)) return;
    if (G.state === 'MISSION_PLAY') t.judge({ type:'timeout' });
    else update(50);
  }
  throw new Error('상태 머신이 멈추지 않음: ' + G.state);
}

// 미션 하나를 MISSION_PLAY까지 몰고 간다
function playTo(t, id) {
  const { G, update } = t;
  update(0); if (G.state === 'TITLE') t.startGame();
  drive(t, null, s => s === 'MISSION_PLAY' && G.m.def.id === id);
  if (!(G.state === 'MISSION_PLAY' && G.m.def.id === id)) throw new Error(id + ' 미션에 도달하지 못함');
  return G.m;
}

// ── 1. 사양 데이터 정합성 ──────────────────────────────────────
{
  const { MISSIONS, CHECKS, ROUNDS, TOTAL, MULTS } = load(loose);
  assert.equal(MISSIONS.length, 16, '미션 15개 + 타이밍 미션 B4');
  assert.equal(TOTAL, 16);
  assert.equal(ROUNDS.length, 3);
  ROUNDS.forEach((r, i) => assert.equal(r.mult, MULTS[i], `라운드 ${i+1} 시간 배율`));
  // 3.7장 고정 순서. B4는 ROUND_IDS 미등록이라 마지막 라운드에 자동 편성된다.
  assert.deepEqual(ROUNDS.map(r => r.defs.map(d => d.id)),
    [['A1','C1','B1','D1','A2'], ['C2','A3','D2','B2','C4','B4'], ['A4','D3','B3','A5','C3']]);
  assert.deepEqual(ROUNDS.map(r => r.defs.length), [5, 6, 5]);
  assert.equal(ROUNDS[2].defs[ROUNDS[2].defs.length-1].id, 'C3', 'C3가 마지막 = 클라이맥스 (3.7장)');

  const ids = new Set();
  for (const m of MISSIONS) {
    assert.ok(!ids.has(m.id), '미션 ID 중복: ' + m.id); ids.add(m.id);
    assert.ok(typeof CHECKS[m.check] === 'function', m.id + ' 판정 함수 없음: ' + m.check);
    assert.ok(m.rule && m.successMsg && m.cue, m.id + ' 필수 문구 누락');
    assert.ok(m.cue.length <= 6, m.id + ' 지시문이 너무 김: ' + m.cue);
    const keys = new Set();
    for (const o of m.objects) {
      assert.ok(!keys.has(o.key), m.id + ' 오브젝트 key 중복: ' + o.key); keys.add(o.key);
      assert.ok(['none','tap','drag','rotate','rub'].includes(o.interact), m.id + '.' + o.key + ' interact 불량');
      // 플레이 영역 470~1920 안에 있어야 한다 (2장)
      assert.ok(o.y - o.h/2 >= 470 && o.y + o.h/2 <= 1920, `${m.id}.${o.key} 플레이 영역 이탈`);
      assert.ok(o.x - o.w/2 >= 0 && o.x + o.w/2 <= 1080, `${m.id}.${o.key} 가로 이탈`);
      if (o.interact === 'rotate') assert.ok(typeof o.targetAngle === 'number', m.id + ' targetAngle 없음');
    }
    // trap이 있으면 trapReason이 있어야 엔진이 사유를 표시할 수 있다 (3.4장)
    if (m.objects.some(o => o.trap)) assert.ok(m.trapReason, m.id + ' trapReason 누락');
    // 재출제 고스트 힌트가 가리킬 대상
    assert.ok(m.hint && m.hint.length, m.id + ' hint 없음');
    for (const k of m.hint) assert.ok(keys.has(k), `${m.id} hint가 없는 key를 가리킴: ${k}`);
    assert.notEqual(m.objects.find(o => o.key === m.hint[0]).interact, 'none',
      m.id + ' hint 대상이 조작 불가 오브젝트');
  }
}

// ── 1b. 에셋 경로가 실제 파일과 맞는가 ─────────────────────────
{
  const t = load(loose), { MISSIONS, IMG, ASSET_DIR, fit } = t;
  const dir = __dirname + '/' + ASSET_DIR;
  assert.ok(fs.existsSync(dir), ASSET_DIR + ' 폴더 없음 — python tools/prep_assets.py 먼저');

  // 선로딩이 걸어둔 모든 src가 실제 파일이어야 한다
  const wanted = Object.values(IMG).map(i => i.src);
  assert.ok(wanted.length >= 20, '선로딩된 에셋이 너무 적음: ' + wanted.length);
  for (const src of wanted)
    assert.ok(fs.existsSync(__dirname + '/' + src), '파일 없음: ' + src);

  // 15미션 전부 배경이 지정돼 있어야 한다
  for (const m of MISSIONS) assert.ok(m.bgImage, m.id + ' bgImage 없음');

  // 이미지가 없는 오브젝트는 라벨이 있어야 폴백이 읽힌다
  for (const m of MISSIONS) for (const o of m.objects)
    assert.ok(o.img || o.label !== undefined, `${m.id}.${o.key} 그림도 라벨도 없음`);

  // 비율 유지 맞춤: 박스를 넘지 않고, 한 변은 정확히 채운다
  let f = fit(800, 200, 400, 400);
  assert.deepEqual(f, { w:400, h:100 });
  f = fit(200, 800, 400, 400);
  assert.deepEqual(f, { w:100, h:400 });
  f = fit(100, 100, 300, 200);
  assert.deepEqual(f, { w:200, h:200 }, '짧은 변 기준으로 맞춰야 찌그러지지 않는다');
}

// ── 2. 최소 터치 타깃 140 (8장) ────────────────────────────────
{
  const { MISSIONS, hit } = load(loose);
  for (const m of MISSIONS) for (const o of m.objects) {
    if (o.interact === 'none') continue;
    // 실제 사각형이 작아도 입력 히트박스는 140을 보장한다
    assert.ok(hit(o, o.x + 69, o.y + 69), `${m.id}.${o.key} 터치 타깃 140 미만`);
  }
  // 히트박스 패딩이 영역 판정(inRect)까지 넓히면 안 된다
  const { inRect, within } = load(loose);
  assert.equal(within({ x:0, y:0, w:100, h:100 }, 60, 0), false, 'inRect는 패딩 없이 순수 사각형');
  assert.equal(inRect({ x:60, y:0 }, { x:0, y:0, w:100, h:100 }), false);
}

// ── 3. 각 미션 판정 (성공/실패/timeout) ────────────────────────
{
  const t = load(loose), { CHECKS, obj } = t;
  const m = id => playTo(load(loose), id);

  // A1 drag → zone
  let x = m('A1'); const z = obj(x,'zone'), can = obj(x,'can');
  can.x = z.x; can.y = z.y;
  assert.deepEqual(CHECKS.checkA1(x, { type:'dragEnd', objKey:'can' }), { result:'success' });
  can.x = 540; can.y = 1330;
  assert.equal(CHECKS.checkA1(x, { type:'dragEnd', objKey:'can' }).reason, '캔이 버너에 남았습니다');
  assert.equal(CHECKS.checkA1(x, { type:'timeout' }), null, 'A1 timeout은 엔진 기본 사유');

  // A2 작은 불판을 버너 위로 드래그 → 큰 불판이 내려간다
  x = m('A2'); const st2 = obj(x,'stove');
  assert.equal(CHECKS.checkA2(x, { type:'dragEnd', objKey:'smallPan' }).reason, '불판이 그대로입니다');
  obj(x,'smallPan').x = st2.x; obj(x,'smallPan').y = st2.y;
  assert.deepEqual(CHECKS.checkA2(x, { type:'dragEnd', objKey:'smallPan' }), { result:'success' });
  assert.equal(obj(x,'bigPan').hidden, true, '큰 불판이 내려가야 한다');
  assert.equal(obj(x,'smallPan').x, st2.x, '작은 불판이 버너 위에 얹혀야 한다');
  assert.equal(CHECKS.checkA2(m('A2'), { type:'timeout' }).reason, '불판이 캔을 덮고 있습니다');
  assert.equal(m('A2').def.trapReason, '가열 중 캔을 만졌습니다');

  // A3 rotate 90° ±15
  x = m('A3');
  assert.equal(CHECKS.checkA3(x, { type:'rotate', objKey:'can', angle:40 }), null);
  assert.deepEqual(CHECKS.checkA3(x, { type:'rotate', objKey:'can', angle:82 }), { result:'success' });
  assert.equal(CHECKS.checkA3(m('A3'), { type:'rotate', objKey:'can', angle:-90 }), null, 'A3는 역방향 실패 없음');
  assert.equal(CHECKS.checkA3(m('A3'), { type:'timeout' }).reason, '홈이 어긋난 채 장착됐습니다');

  // A4 drag → shade
  x = m('A4'); const sh = obj(x,'shade');
  obj(x,'can').x = sh.x; obj(x,'can').y = sh.y;
  assert.deepEqual(CHECKS.checkA4(x, { type:'dragEnd', objKey:'can' }), { result:'success' });
  assert.equal(CHECKS.checkA4(m('A4'), { type:'timeout' }).reason, '캔이 햇볕에 남았습니다');

  // A5 연타 — 빠르게 두들기면 성공, 느리면 게이지가 샌다
  x = m('A5');
  let r5 = null;
  for (let i = 0; i < 5 && !r5; i++) r5 = CHECKS.checkA5(x, { type:'tap', objKey:'can' });
  assert.deepEqual(r5, { result:'success' }, '연속 5회면 성공');
  x = m('A5');
  for (let i = 0; i < 4; i++) {
    x.elapsed += 900;                                    // 한 번에 한 칸 이상 새는 간격
    assert.equal(CHECKS.checkA5(x, { type:'tap', objKey:'can' }), null, '느리게 누르면 안 찬다');
  }
  assert.ok(x.s.hits < 2, '느린 연타는 게이지가 새야 한다: ' + x.s.hits);
  assert.equal(CHECKS.checkA5(m('A5'), { type:'timeout' }).reason, '구멍을 다 뚫지 못했습니다');

  // B1 tap knob → 불 꺼짐
  x = m('B1');
  assert.deepEqual(CHECKS.checkB1(x, { type:'tap', objKey:'knob' }), { result:'success' });
  assert.equal(x.s.off, true);
  assert.equal(CHECKS.checkB1(m('B1'), { type:'timeout' }).reason, '냄비가 끓어 넘쳤습니다');

  // B2 rotate — 정방향 성공 / 역방향 즉시 실패
  x = m('B2');
  assert.deepEqual(CHECKS.checkB2(x, { type:'rotate', objKey:'valve', angle:95 }), { result:'success' });
  assert.equal(x.s.locked, true, '성공 시 가스 흐름 정지 플래그');
  assert.equal(CHECKS.checkB2(m('B2'), { type:'rotate', objKey:'valve', angle:-88 }).reason, '밸브를 반대로 돌렸습니다');
  assert.equal(CHECKS.checkB2(m('B2'), { type:'rotate', objKey:'valve', angle:45 }), null);
  assert.equal(CHECKS.checkB2(m('B2'), { type:'timeout' }).reason, '밸브가 열려 있습니다');

  // B3 슬라이더 y ≥ 1650
  x = m('B3'); obj(x,'slider').y = 1700;
  assert.deepEqual(CHECKS.checkB3(x, { type:'dragEnd', objKey:'slider' }), { result:'success' });
  obj(x,'slider').y = 1400;
  assert.equal(CHECKS.checkB3(x, { type:'dragEnd', objKey:'slider' }).reason, '화력이 그대로입니다');

  // C1 창문
  assert.deepEqual(CHECKS.checkC1(m('C1'), { type:'tap', objKey:'window' }), { result:'success' });
  assert.equal(CHECKS.checkC1(m('C1'), { type:'timeout' }).reason, '환기하지 못했습니다');

  // C2 rotate
  assert.deepEqual(CHECKS.checkC2(m('C2'), { type:'rotate', objKey:'valve', angle:90 }), { result:'success' });
  assert.equal(CHECKS.checkC2(m('C2'), { type:'rotate', objKey:'valve', angle:-90 }).reason, '밸브를 반대로 돌렸습니다');

  // C3 핵심 미션 — door 성공, stove 무판정, 함정 3개
  x = m('C3');
  assert.deepEqual(CHECKS.checkC3(x, { type:'tap', objKey:'door' }), { result:'success' });
  assert.equal(CHECKS.checkC3(x, { type:'tap', objKey:'stove' }), null, '가스레인지 탭은 판정 보류');
  assert.equal(CHECKS.checkC3(x, { type:'timeout' }).reason, '대피가 늦었습니다');
  for (const k of ['light','fan','phone']) assert.ok(obj(x,k).trap, 'C3 ' + k + '는 함정이어야 한다');
  assert.ok(!obj(x,'door').trap);

  // C4 문지르기 — 누출 지점 위를 충분히 문질러야 성공. 위치는 매 플레이 랜덤
  x = m('C4'); const leak = t.c4Leak(x);
  assert.ok([297, 540, 772].includes(leak));
  assert.equal(t.c4Leak(x), leak, '누출 지점은 한 번 정해지면 고정');
  const rub = (o, dx, d) => CHECKS.checkC4(o, { type:'rub', objKey:'hose', x:leak + dx, y:1200, dist:d });
  assert.equal(rub(x, 400, 3000), null, '엉뚱한 곳은 아무리 문질러도 성공하지 않는다');
  assert.equal(rub(x, 0, 190), null, '한 번 훑어서는 안 된다');
  // 누출 지점을 가로지르는 한 획 ≈ 190px. 5획쯤 문질러야 거품이 터진다.
  let strokes = 1, r4 = null;
  while (!r4 && strokes < 20) { r4 = rub(x, (strokes % 2 ? 60 : -60), 190); strokes++; }
  assert.deepEqual(r4, { result:'success' });
  assert.ok(strokes >= 4 && strokes <= 7, `5획 안팎이어야 한다 (실제 ${strokes}획)`);
  assert.ok(x.s.x0 < x.s.x1, '비눗물 칠해진 범위가 기록된다');
  assert.equal(CHECKS.checkC4(m('C4'), { type:'tap', objKey:'hose' }), null, '탭은 판정하지 않는다');
  assert.equal(CHECKS.checkC4(m('C4'), { type:'timeout' }).reason, '누출 지점을 찾지 못했습니다');

  // B4 타이밍 — 초록 구간 안에서만 성공
  const at = (o, prog) => { o.left = o.limit * (1 - prog); return CHECKS.checkB4(o, { type:'tap', objKey:'igniter' }); };
  assert.equal(at(m('B4'), .20).reason, '고인 가스에 불이 붙었습니다');
  assert.equal(at(m('B4'), .61).reason, '고인 가스에 불이 붙었습니다');
  assert.deepEqual(at(m('B4'), .62), { result:'success' });
  assert.deepEqual(at(m('B4'), .74), { result:'success' });
  assert.deepEqual(at(m('B4'), .86), { result:'success' });
  assert.equal(at(m('B4'), .92).reason, '너무 오래 기다렸습니다');
  assert.equal(CHECKS.checkB4(m('B4'), { type:'timeout' }).reason, '점화하지 못했습니다');

  // D1 box → zone
  x = m('D1'); const dz = obj(x,'zone');
  obj(x,'box').x = dz.x; obj(x,'box').y = dz.y;
  assert.deepEqual(CHECKS.checkD1(x, { type:'dragEnd', objKey:'box' }), { result:'success' });
  assert.equal(CHECKS.checkD1(m('D1'), { type:'timeout' }).reason, '배기구가 막혀 있습니다');

  // D2 반경 80 스냅
  x = m('D2'); const so = obj(x,'socket');
  obj(x,'pipe').x = so.x + 60; obj(x,'pipe').y = so.y;
  assert.deepEqual(CHECKS.checkD2(x, { type:'dragEnd', objKey:'pipe' }), { result:'success' });
  obj(x,'pipe').x = so.x + 200;
  assert.equal(CHECKS.checkD2(x, { type:'dragEnd', objKey:'pipe' }).reason, '배기통이 빠져 있습니다');
  assert.equal(so.snap, 80, '하이라이트 반경과 판정 반경이 같아야 한다');

  // D3 난방기 y ≥ 1700, 실패 사유 없이 재시도 가능
  x = m('D3'); obj(x,'heater').y = 1750;
  assert.deepEqual(CHECKS.checkD3(x, { type:'dragEnd', objKey:'heater' }), { result:'success' });
  obj(x,'heater').y = 1300;
  assert.equal(CHECKS.checkD3(x, { type:'dragEnd', objKey:'heater' }), null, '놓쳐도 재시도 가능');
  assert.equal(CHECKS.checkD3(m('D3'), { type:'timeout' }).reason, '일산화탄소가 가득 찼습니다');
}

// ── 4. 회전 누적 ±180° 경계 보정 (3.1장) ───────────────────────
{
  const { wrap180 } = load(loose);
  assert.equal(wrap180(10), 10);
  assert.equal(wrap180(-350), 10, '179°→-179° 점프가 +2°로 보정돼야 한다');
  assert.equal(wrap180(350), -10);
  // 한 바퀴를 잘게 나눠 돌려도(경계 통과 포함) 누적각이 정확히 360이 된다
  const norm = a => wrap180(a % 360);
  let acc = 0, prev = norm(0);
  for (let step = 7; step <= 360; step += 7) {
    const a = norm(step);
    acc += wrap180(a - prev); prev = a;
  }
  assert.ok(Math.abs(acc - 357) < 1e-9, '누적 회전각 오차: ' + acc);   // 7°×51 = 357°
  assert.ok(acc > 0, '경계를 넘어도 부호가 뒤집히지 않는다');
}

// ── 5. 목숨·재출제·엔딩 (3.6 / 3.8 / 3.9장) ────────────────────
{
  const t = load(loose), { G, update, DUR, TOTAL } = t;
  update(0); t.startGame();

  // 전 미션을 timeout으로 실패시키며 끝까지 굴린다
  let missionsPlayed = 0, retriesSeen = 0;
  drive(t, s => {
    if (s === 'MISSION_RETRY') retriesSeen++;
    if (s === 'MISSION_PLAY')  missionsPlayed++;
  }, s => s === 'ENDING');
  assert.equal(G.state, 'ENDING');
  // 전부 실패시켰으니 라운드마다 재출제 2개씩 = 6회
  assert.equal(retriesSeen, 6, '라운드당 재출제 최대 2개 × 3라운드');
  assert.equal(missionsPlayed, TOTAL + 6, '기본 16 + 재출제 6');
  assert.equal(G.done, TOTAL, '진행 카운터는 재출제로 부풀지 않는다');
  assert.equal(G.lives, 0, '목숨은 0에서 멈춘다');
  assert.equal(Object.keys(G.status).length, TOTAL);
  assert.equal(t.grade(0).name, '가스안전 요원');
  assert.equal(t.grade(12).name, '가스안전 요원');
  assert.equal(t.grade(13).name, '가스안전 반장');   // ceil(16*0.8)
  assert.equal(t.grade(15).name, '가스안전 반장');
  assert.equal(t.grade(16).name, '가스안전 대장');
  update(DUR.ENDING);
  assert.equal(G.state, 'TITLE', '엔딩 30초 후 자동 복귀');
}

// ── 6. 재출제 성공은 "놓친 수칙"에서 빠진다 ────────────────────
{
  const t = load(loose), { G, update, judge, DUR } = t;
  update(0); t.startGame(); update(DUR.ROUND_INTRO);

  // 라운드1의 5미션을 전부 실패시킨다
  for (let i = 0; i < 5; i++) {
    update(DUR.MISSION_CUE); assert.equal(G.state, 'MISSION_PLAY');
    judge({ type:'timeout' }); update(DUR.MISSION_RESULT);
  }
  assert.equal(G.state, 'MISSION_RETRY', '라운드 종료 직후 즉시 재출제');
  const retryId = G.m.def.id;
  assert.equal(G.status[retryId], false);
  assert.equal(G.m.limit, G.m.def.timeLimit * 1.0, '재출제는 해당 라운드 배율 유지');
  const livesBefore = G.lives;
  update(DUR.MISSION_RETRY); update(DUR.MISSION_CUE);
  t.resolve({ result:'success' });
  assert.equal(G.status[retryId], true, '재출제 성공 시 놓친 수칙에서 제외');
  assert.equal(G.lives, livesBefore, '재출제 성공해도 목숨은 회복되지 않는다');
}

// ── 7. 미션은 데이터다: 배열에 객체 하나 추가 = 미션 하나 추가 ──
{
  const t = load(loose, `,
  { id:'E1', hint:['door'], group:'수소', cue:'꺼!', check:'checkC3', timeLimit:5000, bg:'#333333',
    rule:'수소차 충전 전에는 시동을 끈다', successMsg:'테스트', trapReason:'테스트',
    objects:[{ key:'door', label:'시동 버튼', x:540, y:1200, w:300, h:400, color:'#888888', interact:'tap' }] }`);
  assert.equal(t.MISSIONS.length, 17);
  assert.equal(t.TOTAL, 17, '엔진 수정 없이 총 미션 수가 늘어난다');
  assert.equal(t.ROUNDS[2].defs.length, 6, '미등록 미션은 마지막 라운드에 자동 편성');
  const m = playTo(t, 'E1');
  assert.deepEqual(t.CHECKS[m.def.check](m, { type:'tap', objKey:'door' }), { result:'success' });
  // 등급 컷도 총 미션 수에 따라온다
  assert.equal(t.grade(17).name, '가스안전 대장');
  assert.equal(t.grade(14).name, '가스안전 반장');
}

// ── 8. 렌더 경로: 15미션 × 전 상태, Canvas2D 규격 위반 0건 ─────
{
  const t = load(strict), { G, update, render, DUR, MISSIONS, FX } = t;
  const seen = new Set(), rendered = new Set();

  update(0); render(); seen.add(G.state);
  for (let i = 0; i < 4; i++) { update(120); render(); }   // 타이틀 점멸 양쪽
  t.startGame();

  drive(t, s => {
    seen.add(s);
    if (s !== 'MISSION_PLAY') { render(); return; }
    rendered.add(G.m.def.id);
    render();
    // 드래그·회전 중 렌더
    const d = G.m.objs.find(o => o.interact === 'drag');
    const r = G.m.objs.find(o => o.interact === 'rotate');
    if (d) { G.p = { dragKey:d.key, id:1, x:d.x, y:d.y, x0:d.x, y0:d.y, t0:0 }; update(60); render(); G.p = null; }
    if (r) { r.angle = 45; update(60); render(); }
    // 성공 연출 상태(불 꺼짐 / 밸브 잠김 / 불판 교체 / 연타 진행)도 렌더한다
    const c = t.CHECKS[G.m.def.check];
    ['knob', 'bigPan', 'can'].forEach(k => c(G.m, { type:'tap', objKey:k }));
    c(G.m, { type:'rotate', objKey:'valve', angle:90 });
    update(60); render();
  }, s => s === 'ENDING');

  for (let i = 0; i < 3; i++) { update(100); render(); }    // ENDING (놓친 수칙 8개 + "외 N개")
  update(DUR.ENDING); render();
  assert.equal(G.state, 'TITLE');

  for (const s of ['TITLE','ROUND_INTRO','MISSION_RETRY','MISSION_CUE','MISSION_PLAY','MISSION_RESULT','ROUND_RESULT','ENDING'])
    assert.ok(seen.has(s), s + ' 상태가 렌더되지 않음');
  for (const m of MISSIONS) assert.ok(rendered.has(m.id), m.id + ' 미션이 렌더되지 않음');
  for (const id of Object.keys(FX)) assert.ok(MISSIONS.some(m => m.id === id), 'FX 고아 항목: ' + id);
}

// ── 9. 이미지가 실제로 로드된 상태의 렌더 (drawImage 경로) ─────
{
  const t = load(strict, null, true), { G, update, render, MISSIONS, IMG, fit } = t;

  const loaded = Object.values(IMG).filter(i => i.complete);
  assert.equal(loaded.length, Object.keys(IMG).length, '선로딩 에셋 중 크기를 못 읽은 파일이 있음');
  assert.ok(loaded.length >= 20);

  // 그림이 스펙 박스를 넘지 않는지 (비율 유지 맞춤)
  for (const m of MISSIONS) for (const o of m.objects) {
    if (!o.img) continue;
    const i = IMG[o.img];
    const f = fit(i.naturalWidth, i.naturalHeight, o.w, o.h);
    assert.ok(f.w <= o.w + 1e-6 && f.h <= o.h + 1e-6, `${m.id}.${o.key} 박스를 넘음`);
    assert.ok(f.w >= o.w - 1e-6 || f.h >= o.h - 1e-6, `${m.id}.${o.key} 한 변도 못 채움`);
    // 박스를 심하게 못 채우면 그림이 외따로 작게 보인다
    const use = (f.w * f.h) / (o.w * o.h);
    assert.ok(use > .40, `${m.id}.${o.key} 박스 대비 ${(use*100).toFixed(0)}%만 채움 — 크기 조정 필요`);
  }

  update(0); t.startGame();
  const seen = new Set();
  drive(t, s => {
    seen.add(s); render();
    if (s !== 'MISSION_PLAY') return;
    const z = G.m.objs.find(o => o.zone);
    const d = G.m.objs.find(o => o.interact === 'drag');
    if (z) { z.hot = true; render(); }                  // 이미지 위 하이라이트 경로
    if (d) { G.p = { dragKey:d.key, id:1, x:d.x, y:d.y, x0:d.x, y0:d.y, t0:0 }; update(60); render(); G.p = null; }
    const r = G.m.objs.find(o => o.interact === 'rotate');
    if (r) { r.angle = 45; update(60); render(); }
  }, s => s === 'ENDING');
  render();
  assert.equal(seen.size >= 6, true);
}

// ── 10. 고스트 힌트는 재출제 미션에서만 ────────────────────────
{
  const t = load(strict, null, true), { G, update, render, DUR } = t;
  update(0); t.startGame();

  // 라운드1의 5미션을 전부 실패시킨다 → 재출제 진입
  let firstPlay = null, retryPlay = null;
  drive(t, s => {
    if (s !== 'MISSION_PLAY') return;
    if (firstPlay === null) firstPlay = G.m.entry.retry;
    if (G.m.entry.retry) retryPlay = G.m;
  }, s => s === 'MISSION_PLAY' && G.m.entry.retry);

  assert.equal(firstPlay, false, '첫 출제는 힌트 없음');
  assert.ok(retryPlay, '재출제 미션에 도달해야 한다');
  assert.equal(retryPlay.entry.retry, true);
  render();                                   // 고스트 포함 렌더가 Canvas2D 규격을 지키는지
  retryPlay.elapsed += 700; render();         // 시연 중간 구간
  retryPlay.elapsed += 700; render();         // 반복 경계
}

// ── 11. 오디오: BGM 시퀀서 · 더킹 · 콤보 ───────────────────────
{
  const log = { starts: 0 };
  const t = load(loose, null, false, log);
  const { G, update, DUR, BGM_BPM } = t;

  t.initAudio();
  assert.ok(log.ac, 'AudioContext가 열려야 한다');

  // 오디오 시계를 굴리며 BGM을 예약한다. 과거 시각 예약이면 스텁이 throw한다.
  t.startGame();
  for (let i = 0; i < 400; i++) { log.ac.advance(0.016); t.bgmTick(); }
  // 6.4초 × 104BPM(8분음표 0.288초) ≈ 22스텝, 스텝당 베이스+하이햇+킥 ≈ 2음
  assert.ok(log.starts > 30, 'BGM이 음을 예약하지 않았다: ' + log.starts);

  // 템포는 라운드별로 올라간다
  assert.deepEqual(BGM_BPM.slice(0, 3), [104, 124, 146]);
  assert.ok(BGM_BPM[1] > BGM_BPM[0] && BGM_BPM[2] > BGM_BPM[1], '라운드마다 빨라져야 한다');
  const before = log.starts;
  G.roundIdx = 2;
  for (let i = 0; i < 100; i++) { log.ac.advance(0.016); t.bgmTick(); }
  const r3 = log.starts - before;
  G.roundIdx = 0;
  const mid = log.starts;
  for (let i = 0; i < 100; i++) { log.ac.advance(0.016); t.bgmTick(); }
  assert.ok(r3 > log.starts - mid, `라운드3이 라운드1보다 음이 많아야 한다 (${r3} vs ${log.starts - mid})`);

  // 정지하면 더 예약하지 않는다
  t.bgmStop();
  const stopped = log.starts;
  for (let i = 0; i < 100; i++) { log.ac.advance(0.016); t.bgmTick(); }
  assert.equal(log.starts, stopped, '정지 후에도 음이 예약됨');

  t.duck();                                   // 더킹이 실제 API 위에서 도는지
  Object.keys(t.SFX).forEach(k => t.SFX[k](7));

  // 콤보: 연속 성공에 오르고 실패에 끊긴다
  const g = load(loose, null, false, { starts: 0 });
  g.initAudio(); g.update(0); g.startGame();
  drive(g, s => { if (s === 'MISSION_PLAY') g.resolve({ result:'success' }); }, s => g.G.combo >= 4);
  assert.equal(g.G.combo, 4);
  assert.equal(g.G.best, 4);
  assert.ok(g.G.m.fast, '제한시간 40% 안에 끝내면 fast');
  g.resolve({ result:'fail', reason:'x' });
  assert.equal(g.G.combo, 0, '실패하면 콤보가 끊긴다');
  assert.equal(g.G.best, 4, '최고 콤보는 남는다');
}

// ── 12. 문구가 잘리지 않고 다 읽히는가 ─────────────────────────
{
  // 한글은 글자폭 ≈ 글자크기. 실제보다 넉넉히 잡아 통과하면 브라우저에서도 통과한다.
  let size = 16;
  const metric = new Proxy({}, {
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k === 'measureText') return str => {
        let w = 0;
        for (const ch of String(str)) w += ch === ' ' ? size * .32 : (ch.charCodeAt(0) > 0x2000 ? size : size * .55);
        return { width: w };
      };
      if (String(k).startsWith('create')) return () => ({ addColorStop: noop });
      return noop;
    },
    set(t, k, v) {
      if (k === 'font') { const m = /(\d+)px/.exec(v); if (m) size = +m[1]; }
      return true;
    }
  });
  const t = load(metric), { MISSIONS, wrapLines, DUR } = t;

  // 결과 배너: 48px, 폭 830, 2줄
  for (const m of MISSIONS) {
    const ls = wrapLines(m.successMsg, 1080 - 250, 48);
    assert.ok(ls.length <= 2, `${m.id} 성공 문구가 배너 2줄을 넘음 (${ls.length}줄): ${m.successMsg}`);
    assert.ok(!ls.join('').includes('…'), m.id + ' 성공 문구 잘림');
  }
  // 엔딩 수칙 카드: 34px, 폭 580, 3줄
  for (const m of MISSIONS) {
    const ls = wrapLines(m.rule, 1080 - 500, 34);
    assert.ok(ls.length <= 3, `${m.id} 수칙이 카드 3줄을 넘음 (${ls.length}줄): ${m.rule}`);
  }
  // 지시문은 한 줄에 들어가야 한다 (160px)
  for (const m of MISSIONS)
    assert.equal(wrapLines(m.cue, 1080, 160).length, 1, m.id + ' 지시문이 한 줄을 넘음');

  // 줄바꿈 자체가 도는지
  assert.equal(wrapLines('가나다라마바사아자차', 10000, 40).length, 1);
  assert.ok(wrapLines('가나다라마바사아자차카타파하', 200, 40).length >= 2, '넘치면 나뉘어야 한다');
  assert.ok(wrapLines('공백없는아주긴한글단어가여기있습니다정말로깁니다', 200, 40).length >= 2,
    '공백이 없어도 글자 단위로 나뉘어야 한다');

  // 수칙을 읽을 시간이 실제로 확보돼 있는가
  assert.ok(DUR.MISSION_RESULT >= 1800, '결과 노출이 너무 짧다: ' + DUR.MISSION_RESULT);
}

console.log('OK — 데이터 정합성 · 에셋 경로 · 판정 16종 · 회전 · 재출제 · 등급 · 확장성 · 렌더(폴백+이미지+고스트) · 오디오 · 문구 가독성 전부 통과');
