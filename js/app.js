/**
 * app.js — 메인 제어 로직
 *
 * ▶ 핵심 파이프라인
 *   웹캠 → COCO-SSD → onDetections() → sequencer.trigger() → buildPacket() → COM3
 *
 * ▶ 버그 수정 이력
 *   - 쿨다운 로직 전면 재작성
 *     기존: isBusy이면 early-return → _lastTriggerTime 갱신 안 됨
 *           → IDLE 복귀 후에도 sameLabel+tooSoon 조건이 계속 참 → 영구 차단
 *     수정: isBusy이면 감지 UI만 갱신하고 트리거 시도 자체를 건너뜀
 *           IDLE일 때만 쿨다운 검사 → trigger() 성공 시에만 타이머 갱신
 */

// ─── 상수 ───
const MOTION_NAMES = {
  1:'기본자세', 2:'모션2', 3:'모션3', 4:'모션4', 5:'모션5',
  6:'모션6', 7:'모션7', 8:'모션8', 9:'모션9', 10:'모션10',
  11:'모션11', 12:'모션12', 13:'모션13', 14:'모션14', 15:'모션15',
  16:'모션16', 17:'모션17', 18:'손흔들기', 19:'인사', 20:'커스텀20',
  21:'모션21', 22:'모션22', 23:'모션23', 24:'모션24', 25:'모션25',
};

const LABEL_EMOJI = {
  person:'👤', bottle:'🍾', 'cell phone':'📱', cup:'☕', chair:'🪑',
  book:'📚', laptop:'💻', dog:'🐕', cat:'🐈', car:'🚗', bicycle:'🚲',
  bus:'🚌', bird:'🐦', apple:'🍎', banana:'🍌', backpack:'🎒',
  umbrella:'☂️', clock:'🕐', keyboard:'⌨️', mouse:'🖱️', remote:'📺',
  scissors:'✂️', 'wine glass':'🍷', fork:'🍴', knife:'🔪', spoon:'🥄',
  bowl:'🥣', sandwich:'🥪', orange:'🍊', broccoli:'🥦', carrot:'🥕',
};

// ─── 초기 LABEL_TO_MOTION 매핑 ───
let currentMappings = [
  { label:'person',     motionId:19, emoji:'👤' },
  { label:'bottle',     motionId:18, emoji:'🍾' },
  { label:'cell phone', motionId:20, emoji:'📱' },
];

// ─── 전역 인스턴스 ───
let simulator = null;
let sequencer = null;
let serialMgr = null;
let packetUI  = null;
let _mainRaf  = null;
let systemOn  = false;
let totalPkts = 0;

// ─── 트리거 쿨다운 (IDLE 상태에서만 동작) ───
// 같은 라벨이 IDLE 복귀 직후 즉시 재트리거되는 것을 1초간 억제
const TRIGGER_COOLDOWN_MS = 1000;
let _lastTriggeredAt    = 0;   // 마지막 trigger() 성공 시각 (performance.now)
let _lastTriggeredLabel = '';  // 마지막 trigger() 성공 라벨

// ════════════════════════════════════════════════════════════
// 진입점 — DOMContentLoaded 즉시 실행
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {

  // COCO datalist 자동완성
  const dl = document.getElementById('coco-labels');
  if (dl) COCO_CLASSES.forEach(c => {
    const o = document.createElement('option'); o.value = c; dl.appendChild(o);
  });

  packetUI = new PacketBuilderUI();
  initTabs();
  bindEvents();
  renderMappings();
  renderTriggerGrid();
  updateSerialButtonVisibility();

  await bootSystem();
});

// ════════════════════════════════════════════════════════════
// 시스템 부팅: 모델 → 카메라 → 시퀀서 → 루프 시작
// ════════════════════════════════════════════════════════════
async function bootSystem() {
  setStatus('loading', 'AI 모델 로딩 중...');
  setHUD('🧠 COCO-SSD 모델 로딩 중... 잠시 기다려 주세요');
  serialLog('[BOOT] 시스템 부팅 시작', 'sys');

  // 1. SerialManager 생성
  serialMgr = new SerialManager({
    baudRate: 115200,
    onLog: (msg, cls) => serialLog(msg, cls || 'sys'),
    onStatusChange: s => updateSerialStatus(s),
  });

  serialLog(
    serialMgr.isSupported()
      ? '[SERIAL] Web Serial API 지원 — 상단 "포트 연결" 버튼으로 연결 가능'
      : '[SERIAL] ⚠ Web Serial 미지원 브라우저 — 패킷 로그 모드로 동작',
    serialMgr.isSupported() ? 'rx' : 'warn'
  );

  // 2. COCO-SSD 탐지 엔진 생성
  simulator = new YoloSimulator('detection-canvas', 'webcam-video', {
    confThreshold : parseFloat(document.getElementById('conf-slider').value),
    labelToMotion : getMappingObj(),
    onDetection   : onDetections,
    onModelProgress: (pct, msg) => {
      setInitFill(pct);
      setInitMsg(msg);
      if (pct >= 0) serialLog(`[MODEL] ${msg}`, 'sys');
    },
    onModelLoaded: () => serialLog('[MODEL] ✅ COCO-SSD 로드 완료', 'rx'),
  });

  // 3. 모델 로드
  const modelOk = await simulator.loadModel();
  if (!modelOk) {
    setStatus('error', '모델 로드 실패');
    setHUD('❌ AI 모델 로드 실패 — 인터넷 연결 확인 후 새로고침', 'error');
    hideInitOverlay();
    return;
  }

  setInitFill(70);
  setInitMsg('📷 카메라 권한 요청 중...');
  serialLog('[CAM] 카메라 권한 요청 중...', 'sys');

  // 4. 웹캠 시작
  const camOk = await simulator.startWebcam();
  if (!camOk) {
    hideInitOverlay();
    document.getElementById('cam-error-overlay')?.classList.remove('hidden');
    setStatus('error', '카메라 오류');
    serialLog('[CAM] ❌ 카메라 권한 거부 또는 오류', 'error');
    return;
  }

  setInitFill(90);
  setInitMsg('🤖 시퀀서 초기화 중...');
  serialLog('[CAM] ✅ 카메라 연결 완료', 'rx');

  // 5. MotionSequencer 생성 — SerialManager 주입
  sequencer = new MotionSequencer({
    returnMotion  : parseInt(document.getElementById('cfg-return-motion').value) || 1,
    actionHoldSec : parseInt(document.getElementById('cfg-action-hold').value)   || 7,
    returnHoldSec : parseInt(document.getElementById('cfg-return-hold').value)   || 3,
    serialManager : serialMgr,
    onSendMotion  : onMotionSend,
    onStateChange : onStateChange,
    onLog         : msg => {
      const cls = msg.includes('[TX') ? 'tx' : 'sys';
      serialLog(msg, cls);
    },
  });

  setInitFill(100);
  setInitMsg('✅ 준비 완료!');
  await sleep(300);
  hideInitOverlay();

  // 6. 추론 루프 + 시퀀서 루프 시작
  systemOn = true;
  simulator.start();
  startSeqLoop();

  setRobotState('idle');
  setSMState('idle');
  setStatus('running', '탐지 실행 중');
  setHUD('✅ 실시간 탐지 중 — 카메라 앞에 사물을 보여주세요!', 'success');

  const mapStr = currentMappings.map(m => `"${m.label}"→M${m.motionId}(${MOTION_NAMES[m.motionId]||''})`).join(', ');
  serialLog(`[SYSTEM] ✅ 시작 완료 — 115200bps`, 'rx');
  serialLog(`[MAPPING] ${mapStr}`, 'sys');
  serialLog('[PIPELINE] 탐지 → 매핑 → trigger() → buildPacket() → TX', 'sys');

  document.getElementById('conf-display').textContent = simulator.confThreshold.toFixed(2);
  setInterval(tickUI, 100);
}

// ════════════════════════════════════════════════════════════
// 탐지 콜백 — COCO-SSD에서 매 프레임 호출
//
// ▶ 흐름
//   1. 탐지 결과 UI 갱신 (항상)
//   2. sequencer.isBusy → 모션 진행 중이므로 트리거 스킵
//   3. IDLE 상태 → 매핑된 첫 번째 객체로 트리거 시도
//   4. 쿨다운 체크는 IDLE일 때만, trigger() 성공 시에만 타이머 갱신
// ════════════════════════════════════════════════════════════
function onDetections(detections) {
  if (!systemOn || !sequencer) return;

  // ① 탐지 로그 UI 갱신 (모션 상태와 무관하게 항상 표시)
  updateDetectionLog(detections);

  // ② 탐지 결과 없으면 종료
  if (detections.length === 0) return;

  // ③ 시퀀서가 이미 ACTION 또는 RETURN 중이면 트리거 불필요
  //    (isBusy일 때 return — 이때 _lastTriggeredAt은 건드리지 않음)
  if (sequencer.isBusy) return;

  // ④ IDLE 상태 → 매핑된 객체 탐색 후 트리거
  const map = getMappingObj();
  const now = performance.now();

  for (const det of detections) {
    const motionId = map[det.label];
    if (motionId === undefined) continue;  // 매핑 없는 객체 스킵

    // ⑤ 쿨다운 체크 (IDLE 상태에서만 의미 있음)
    //    같은 라벨이 쿨다운 이내면 스킵 (다른 라벨은 즉시 허용)
    const sameLabelCooldown =
      det.label === _lastTriggeredLabel &&
      (now - _lastTriggeredAt) < TRIGGER_COOLDOWN_MS;
    if (sameLabelCooldown) continue;

    // ⑥ 트리거 시도
    const ok = sequencer.trigger(motionId);
    if (ok) {
      // 성공 시에만 타이머·라벨 갱신
      _lastTriggeredAt    = now;
      _lastTriggeredLabel = det.label;

      highlightMapping(det.label);
      setHUD(
        `🎯 "${det.label}" (${(det.conf*100).toFixed(0)}%) ` +
        `→ Motion #${motionId} [${MOTION_NAMES[motionId]||''}] 실행!`,
        'success'
      );
      serialLog(
        `[DETECT→ROBOT] "${det.label}" ${(det.conf*100).toFixed(0)}% ` +
        `→ Motion #${motionId} (${MOTION_NAMES[motionId]||''}) ✅`,
        'rx'
      );
    }
    break;  // 첫 번째 매핑 객체만 처리
  }
}

// ════════════════════════════════════════════════════════════
// 모션 전송 콜백 (MotionSequencer → UI)
// ════════════════════════════════════════════════════════════
function onMotionSend(motionId, pkt, count) {
  totalPkts = count;
  const name = MOTION_NAMES[motionId] || '';
  document.getElementById('robot-info-packets').textContent = `${count} 패킷`;
  document.getElementById('robot-info-motion').textContent  = `#${motionId} ${name}`;
  if (packetUI) packetUI.addFromSimulator(motionId);
}

// ════════════════════════════════════════════════════════════
// 상태 변화 콜백 (MotionSequencer → UI)
// ════════════════════════════════════════════════════════════
function onStateChange(state, motionId) {
  setSMState(state.toLowerCase());

  switch (state) {
    case SEQ_STATE.IDLE:
      setRobotState('idle');
      document.getElementById('robot-info-state').textContent  = 'IDLE — 대기';
      document.getElementById('robot-info-motion').textContent = '없음';
      document.getElementById('robot-info-timer').textContent  = '--';
      setHUD('IDLE — 다음 감지 대기 중...', 'info');
      break;

    case SEQ_STATE.ACTION:
      setRobotState('action');
      document.getElementById('robot-info-state').textContent =
        `ACTION → Motion #${motionId} (${MOTION_NAMES[motionId]||''})`;
      document.getElementById('sm-action-desc').textContent = `M#${motionId}`;
      updateRobotScreen(`M${motionId}`, MOTION_NAMES[motionId] || '실행 중');
      break;

    case SEQ_STATE.RETURN:
      setRobotState('return');
      document.getElementById('robot-info-state').textContent = 'RETURN — 기본자세 복귀';
      updateRobotScreen('RTN', '기본자세');
      break;
  }
}

// ════════════════════════════════════════════════════════════
// 시퀀서 RAF 루프
// ════════════════════════════════════════════════════════════
function startSeqLoop() {
  function loop(now) {
    if (!systemOn) return;
    _mainRaf = requestAnimationFrame(loop);
    if (sequencer) sequencer.update(now);
  }
  _mainRaf = requestAnimationFrame(loop);
}

function stopSeqLoop() {
  if (_mainRaf) { cancelAnimationFrame(_mainRaf); _mainRaf = null; }
}

// ════════════════════════════════════════════════════════════
// UI 주기 업데이트 (100ms 인터벌)
// ════════════════════════════════════════════════════════════
function tickUI() {
  if (!sequencer) return;
  const state = sequencer.state;
  const timer = Math.max(0, sequencer.stateTimer);
  const total = sequencer.totalTime;
  const pct   = total > 0 ? (1 - timer / total) * 100 : 0;

  const timerEl = document.getElementById('robot-info-timer');
  if (timerEl) timerEl.textContent = state !== SEQ_STATE.IDLE ? `${timer.toFixed(1)}s` : '--';

  const fillEl = document.getElementById('seq-timer-fill');
  if (fillEl) fillEl.style.width = `${pct}%`;

  const labelMap = {
    [SEQ_STATE.IDLE]:   '탐지 대기 중',
    [SEQ_STATE.ACTION]: `모션 실행 중 (${timer.toFixed(1)}s 남음)`,
    [SEQ_STATE.RETURN]: `복귀 대기 (${timer.toFixed(1)}s 남음)`,
  };
  const lblEl = document.getElementById('seq-timer-label-text');
  if (lblEl) lblEl.textContent = labelMap[state] || '--';

  const valEl = document.getElementById('seq-timer-value');
  if (valEl) valEl.textContent = state !== SEQ_STATE.IDLE ? `${timer.toFixed(1)}s` : '';

  const sm1El = document.getElementById('sm-timer-1');
  if (sm1El) sm1El.textContent = `${document.getElementById('cfg-action-hold').value}s`;
}

// ════════════════════════════════════════════════════════════
// Web Serial 연결 UI
// ════════════════════════════════════════════════════════════
function updateSerialButtonVisibility() {
  const btn = document.getElementById('serial-connect-btn');
  if (!btn) return;
  btn.classList.toggle('hidden', !('serial' in navigator));
}

function updateSerialStatus(status) {
  const btn   = document.getElementById('serial-connect-btn');
  const badge = document.getElementById('serial-status-badge');

  const MAP = {
    connected:    { label:'🔌 포트 연결됨', cls:'badge-connected',    btnTxt:'연결 해제', btnCls:'btn-danger',   disabled:false },
    connecting:   { label:'⏳ 연결 중...',     cls:'badge-connecting',   btnTxt:'...',       btnCls:'btn-primary',  disabled:true  },
    disconnected: { label:'⭕ 미연결',         cls:'badge-disconnected', btnTxt:'포트 연결', btnCls:'btn-primary',  disabled:false },
    unsupported:  { label:'⚠ 미지원',         cls:'badge-unsupported',  btnTxt:'미지원',    btnCls:'btn-secondary',disabled:true  },
  };
  const info = MAP[status] || MAP.disconnected;
  if (badge) { badge.textContent = info.label; badge.className = `serial-badge ${info.cls}`; }
  if (btn)   { btn.innerHTML = `<i class="fas fa-plug"></i> ${info.btnTxt}`; btn.className = info.btnCls; btn.disabled = info.disabled; }

  // 로봇 상태 패널 포트 배지 갱신
  const portBadge = document.getElementById('port-badge');
  if (portBadge) {
    portBadge.innerHTML = status === 'connected'
      ? '<i class="fas fa-plug"></i> 연결됨 · 115200'
      : '<i class="fas fa-plug"></i> 미연결 · 115200';
  }
  // 시리얼 로그 배지 갱신
  const serialBadge = document.getElementById('serial-log-badge');
  if (serialBadge) {
    serialBadge.textContent = status === 'connected' ? '연결됨 · 115200' : '미연결 · 115200';
  }
}

async function toggleSerialConnection() {
  if (!serialMgr) return;
  if (serialMgr.isConnected) {
    await serialMgr.disconnect();
  } else {
    serialLog('[SERIAL] 포트 선택 팝업 표시 중...', 'sys');
    const ok = await serialMgr.connectCOM3();
    if (ok) setHUD('🔌 포트 연결됨 — 실제 로봇 패킷 전송 활성화!', 'success');
  }
}

// ════════════════════════════════════════════════════════════
// 이벤트 바인딩
// ════════════════════════════════════════════════════════════
function bindEvents() {
  // 신뢰도 슬라이더
  const cs = document.getElementById('conf-slider');
  cs?.addEventListener('input', () => {
    const v = parseFloat(cs.value).toFixed(2);
    document.getElementById('conf-value').textContent   = v;
    document.getElementById('conf-display').textContent = v;
    if (simulator) simulator.setConfThreshold(parseFloat(v));
  });

  // 탐지 ON/OFF 토글
  document.getElementById('toggle-detection-btn')?.addEventListener('click', () => {
    if (!simulator) return;
    simulator.detectionEnabled = !simulator.detectionEnabled;
    const btn = document.getElementById('toggle-detection-btn');
    const ico = btn?.querySelector('i');
    if (simulator.detectionEnabled) {
      btn?.classList.add('active');
      if (ico) ico.className = 'fas fa-eye';
      setHUD('탐지 활성화', 'success');
    } else {
      btn?.classList.remove('active');
      if (ico) ico.className = 'fas fa-eye-slash';
      setHUD('탐지 일시정지', 'info');
    }
  });

  // 중지 / 재시작
  document.getElementById('stop-btn')?.addEventListener('click', stopSystem);
  document.getElementById('restart-btn')?.addEventListener('click', () => location.reload());

  // COM3 연결 버튼
  document.getElementById('serial-connect-btn')?.addEventListener('click', toggleSerialConnection);

  // 수동 트리거
  document.getElementById('manual-trigger-btn')?.addEventListener('click', () => {
    const id = parseInt(document.getElementById('manual-motion-input').value);
    if (!isNaN(id) && id >= 1 && id <= 30) manualTrigger(id);
  });
  document.getElementById('manual-motion-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const id = parseInt(e.target.value);
      if (!isNaN(id)) manualTrigger(id);
    }
  });

  // 로그 초기화
  document.getElementById('clear-log-btn')?.addEventListener('click', () => {
    const log = document.getElementById('detection-log');
    if (log) log.innerHTML = '<div class="log-empty">탐지된 객체 없음</div>';
  });
  document.getElementById('clear-serial-btn')?.addEventListener('click', () => {
    const out = document.getElementById('serial-output');
    if (out) out.innerHTML = '<div class="serial-line sys">[SYSTEM] 로그 초기화</div>';
  });

  // 매핑 추가 모달
  document.getElementById('add-mapping-btn')?.addEventListener('click', () => {
    document.getElementById('mapping-modal').classList.remove('hidden');
    document.getElementById('mapping-label-input').value  = '';
    document.getElementById('mapping-motion-input').value = '';
    document.getElementById('mapping-label-input')?.focus();
  });
  document.getElementById('mapping-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('mapping-modal').classList.add('hidden');
  });
  document.getElementById('mapping-save-btn')?.addEventListener('click', addMappingFromModal);
  document.getElementById('mapping-motion-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') addMappingFromModal();
  });

  // 설정 변경
  ['cfg-action-hold','cfg-return-hold','cfg-return-motion'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyConfig);
  });

  // 문서 탭 스크롤 스파이
  document.querySelector('.docs-content')?.addEventListener('scroll', function() {
    let activeId = null;
    this.querySelectorAll('section[id]').forEach(s => {
      if (s.offsetTop - this.scrollTop <= 80) activeId = s.id;
    });
    document.querySelectorAll('.docs-nav-item').forEach(l => {
      l.classList.toggle('active', l.getAttribute('href') === `#${activeId}`);
    });
  });
}

// ════════════════════════════════════════════════════════════
// 중지
// ════════════════════════════════════════════════════════════
function stopSystem() {
  systemOn = false;
  simulator?.stop();
  simulator?.stopWebcam();
  sequencer?.reset();
  stopSeqLoop();

  setStatus('ready', '중지됨');
  setHUD('시스템 중지 — 재시작을 눌러주세요', 'info');
  setRobotState('idle');
  setSMState('idle');

  document.getElementById('stop-btn')?.classList.add('hidden');
  document.getElementById('restart-btn')?.classList.remove('hidden');
  document.getElementById('ctrl-info').textContent = '● 시스템 중지됨';
  serialLog('[SYSTEM] 시스템 중지', 'warn');
}

// ════════════════════════════════════════════════════════════
// 수동 트리거
// ════════════════════════════════════════════════════════════
function manualTrigger(motionId) {
  if (!sequencer || !systemOn) {
    setHUD('⚠️ 시스템이 실행 중이 아닙니다', 'error'); return;
  }
  const ok = sequencer.trigger(motionId);
  if (ok) {
    // 수동 트리거 성공 시도 쿨다운 초기화
    _lastTriggeredAt    = performance.now();
    _lastTriggeredLabel = `__manual_${motionId}`;  // 자동 감지와 구분
    setHUD(`▶ 수동 트리거: Motion #${motionId} (${MOTION_NAMES[motionId]||''})`, 'success');
    serialLog(`[MANUAL] trigger(${motionId}) → 패킷 전송`, 'rx');
  } else {
    setHUD(`⚠️ BUSY(${sequencer.state}) — 모션 완료 후 재시도`, 'info');
  }
}

// ════════════════════════════════════════════════════════════
// 설정 적용
// ════════════════════════════════════════════════════════════
function applyConfig() {
  if (!sequencer) return;
  sequencer.actionHoldSec = parseInt(document.getElementById('cfg-action-hold').value)   || 7;
  sequencer.returnHoldSec = parseInt(document.getElementById('cfg-return-hold').value)   || 3;
  sequencer.returnMotion  = parseInt(document.getElementById('cfg-return-motion').value) || 1;
  serialLog(`[CONFIG] 업데이트 — ACTION ${sequencer.actionHoldSec}s / RETURN ${sequencer.returnHoldSec}s / 복귀M ${sequencer.returnMotion}`, 'sys');
}

// ════════════════════════════════════════════════════════════
// 매핑 관리
// ════════════════════════════════════════════════════════════
function getMappingObj() {
  const obj = {};
  currentMappings.forEach(m => { obj[m.label] = m.motionId; });
  return obj;
}

function addMappingFromModal() {
  const label    = document.getElementById('mapping-label-input').value.trim().toLowerCase();
  const motionId = parseInt(document.getElementById('mapping-motion-input').value);
  if (!label)                                         { alert('라벨을 입력하세요'); return; }
  if (isNaN(motionId) || motionId < 1 || motionId > 30) { alert('모션 번호 1~30 입력'); return; }

  const existing = currentMappings.findIndex(m => m.label === label);
  if (existing >= 0) {
    currentMappings[existing] = { ...currentMappings[existing], motionId };
  } else {
    currentMappings.push({ label, motionId, emoji: LABEL_EMOJI[label] || '📦' });
  }

  document.getElementById('mapping-modal').classList.add('hidden');
  renderMappings();
  renderTriggerGrid();
  if (simulator) simulator.updateLabelToMotion(getMappingObj());
  serialLog(`[CONFIG] 매핑: "${label}" → Motion #${motionId} (${MOTION_NAMES[motionId]||''})`, 'sys');
}

function renderMappings() {
  const list = document.getElementById('mapping-list');
  if (!list) return;
  list.innerHTML = currentMappings.map(m => `
    <div class="mapping-row" data-label="${m.label}">
      <span class="mapping-emoji">${m.emoji || '📦'}</span>
      <span class="mapping-label">"${m.label}"</span>
      <span class="mapping-arrow">→</span>
      <span class="mapping-motion">M #${m.motionId}</span>
      <span class="mapping-name">${MOTION_NAMES[m.motionId] || ''}</span>
      <button class="mapping-del" data-label="${m.label}" title="삭제"><i class="fas fa-times"></i></button>
    </div>
  `).join('');
  list.querySelectorAll('.mapping-del').forEach(btn => {
    btn.addEventListener('click', e => {
      const lbl = e.currentTarget.dataset.label;
      currentMappings = currentMappings.filter(m => m.label !== lbl);
      renderMappings();
      renderTriggerGrid();
      if (simulator) simulator.updateLabelToMotion(getMappingObj());
      serialLog(`[CONFIG] 매핑 삭제: "${lbl}"`, 'warn');
    });
  });
}

function highlightMapping(label) {
  const el = document.querySelector(`.mapping-row[data-label="${label}"]`);
  if (!el) return;
  el.classList.add('triggered-mapping');
  setTimeout(() => el.classList.remove('triggered-mapping'), 1500);
}

function renderTriggerGrid() {
  const grid = document.getElementById('manual-trigger-grid');
  if (!grid) return;
  const fixed = [
    {id:1,  n:'기본자세', e:'🧍'}, {id:18, n:'손흔들기', e:'👋'},
    {id:19, n:'인사',     e:'🙇'}, {id:20, n:'커스텀',   e:'💃'},
  ];
  const extra = currentMappings
    .filter(m => ![1,18,19,20].includes(m.motionId))
    .slice(0,2)
    .map(m => ({ id:m.motionId, n:MOTION_NAMES[m.motionId]||'', e:m.emoji||'📦' }));
  const btns = [...fixed, ...extra];

  grid.innerHTML = btns.map(b => `
    <button class="motion-btn" data-id="${b.id}">
      <span>${b.e}</span>
      <span class="motion-btn-num">#${b.id}</span>
      <span class="motion-btn-name">${b.n}</span>
    </button>
  `).join('');
  grid.querySelectorAll('.motion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      manualTrigger(parseInt(btn.dataset.id));
      btn.classList.add('firing');
      setTimeout(() => btn.classList.remove('firing'), 500);
    });
  });
}

// ════════════════════════════════════════════════════════════
// 탐지 결과 로그 UI
// ════════════════════════════════════════════════════════════
function updateDetectionLog(detections) {
  const log = document.getElementById('detection-log');
  if (!log || detections.length === 0) return;

  const map = getMappingObj();
  const now = new Date().toLocaleTimeString('ko-KR',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});

  log.querySelector('.log-empty')?.remove();

  detections.forEach(det => {
    const motionId  = map[det.label];
    const triggered = motionId !== undefined;
    const conf      = (det.conf * 100).toFixed(0);

    let el = log.querySelector(`[data-label="${det.label}"]`);
    if (!el) {
      el = document.createElement('div');
      el.dataset.label = det.label;
      log.insertBefore(el, log.firstChild);
    }
    el.className = `log-entry ${triggered ? 'triggered' : 'detected'}`;
    el.innerHTML = `
      <span class="log-emoji">${LABEL_EMOJI[det.label] || '📦'}</span>
      <span class="log-label">${det.label}</span>
      <span class="log-conf">${conf}%</span>
      ${triggered
        ? `<span class="log-motion">▶ M#${motionId} ${MOTION_NAMES[motionId]||''}</span>`
        : `<span class="log-nomatch">매핑없음</span>`}
      <span class="log-time">${now}</span>
    `;
    while (log.children.length > 15) log.removeChild(log.lastChild);
  });
}

// ════════════════════════════════════════════════════════════
// 로봇 SVG 상태 표시
// ════════════════════════════════════════════════════════════
function setRobotState(state) {
  const svg = document.getElementById('robot-svg');
  if (!svg) return;
  // 기존 robot-* 클래스 제거 후 새 클래스 추가
  svg.className.baseVal = svg.className.baseVal.replace(/robot-\S+/g, '').trim();
  svg.classList.add(`robot-${state}`);

  const screenMap = { idle:['IDLE','대기 중'], action:['RUN','실행 중'], return:['RTN','복귀 중'] };
  const [l1, l2] = screenMap[state] || ['IDLE',''];
  updateRobotScreen(l1, l2);

  const eyeColor = state === 'action' ? 'var(--yellow)' : 'var(--cyan)';
  ['rp-pupil-l','rp-pupil-r'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.fill = eyeColor;
  });
}

function updateRobotScreen(l1, l2) {
  const t1 = document.getElementById('rp-screen-text');
  const t2 = document.getElementById('rp-screen-sub');
  if (t1) t1.textContent = l1;
  if (t2) t2.textContent = l2;
}

// ════════════════════════════════════════════════════════════
// 상태 머신 UI
// ════════════════════════════════════════════════════════════
function setSMState(stateLow) {
  document.querySelectorAll('.sm-state').forEach(el => el.classList.remove('active-state'));
  const map = { idle:'sm-idle', action:'sm-action', return:'sm-return' };
  document.getElementById(map[stateLow])?.classList.add('active-state');
}

// ════════════════════════════════════════════════════════════
// HUD / 헤더 상태
// ════════════════════════════════════════════════════════════
function setHUD(msg, type = 'info') {
  const panel = document.getElementById('hud-panel');
  const text  = document.getElementById('hud-text');
  if (!panel || !text) return;
  panel.className = `hud-panel hud-${type}`;
  text.textContent = msg;
}

function setStatus(cls, txt) {
  const dot  = document.getElementById('system-status-dot');
  const text = document.getElementById('system-status-text');
  dot?.classList.remove('ready','running','error','loading');
  dot?.classList.add(cls);
  if (text) text.textContent = txt;
}

// ════════════════════════════════════════════════════════════
// 초기화 오버레이
// ════════════════════════════════════════════════════════════
function setInitFill(pct) {
  const el = document.getElementById('init-fill');
  if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
function setInitMsg(msg) {
  const el = document.getElementById('init-msg');
  if (el) el.textContent = msg;
}
function hideInitOverlay() {
  document.getElementById('init-overlay')?.classList.add('hidden');
}

// ════════════════════════════════════════════════════════════
// 시리얼 로그 패널
// ════════════════════════════════════════════════════════════
function serialLog(msg, cls = 'sys') {
  const out = document.getElementById('serial-output');
  if (!out) return;
  const line = document.createElement('div');
  line.className = `serial-line ${cls}`;
  const t = new Date().toLocaleTimeString('ko-KR',{hour12:false});
  line.textContent = `[${t}] ${msg}`;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
  while (out.children.length > 300) out.removeChild(out.firstChild);
}

// ════════════════════════════════════════════════════════════
// 탭 초기화
// ════════════════════════════════════════════════════════════
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`)?.classList.add('active');
    });
  });
}

// ─── 유틸 ───
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
