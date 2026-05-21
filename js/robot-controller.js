/**
 * robot-controller.js
 * HumanoidRobot + MotionSequencer + SerialManager
 *
 * ▶ 버그 수정 이력
 *   - SerialManager: TextEncoderStream 제거 → WritableStreamDefaultWriter 단독 사용
 *     (이중 acquire 문제 해결 — writable.getWriter() 한 번만 호출)
 *   - MotionSequencer: 이중 로그 제거, serialManager.send() 결과만 처리
 */

// ─── COCO 80 클래스 ───
const COCO_CLASSES = [
  'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat',
  'traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat',
  'dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack',
  'umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball',
  'kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket',
  'bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple',
  'sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair',
  'couch','potted plant','bed','dining table','toilet','tv','laptop','mouse',
  'remote','keyboard','cell phone','microwave','oven','toaster','sink',
  'refrigerator','book','clock','vase','scissors','teddy bear','hair drier',
  'toothbrush'
];

// ─── 시퀀서 상태 상수 ───
const SEQ_STATE = { IDLE:'IDLE', ACTION:'ACTION', RETURN:'RETURN' };

// ══════════════════════════════════════════════════════════
// SerialManager — Web Serial API COM3 연결
// ══════════════════════════════════════════════════════════
class SerialManager {
  constructor({ baudRate = 115200, onLog = null, onStatusChange = null } = {}) {
    this.baudRate       = baudRate;
    this.onLog          = onLog;
    this.onStatusChange = onStatusChange;

    this.port      = null;
    this.writer    = null;   // WritableStreamDefaultWriter (단독 보유)
    this.connected = false;
    this.supported = ('serial' in navigator);

    this._sending  = false;  // 전송 직렬화용
  }

  isSupported() { return this.supported; }
  get isConnected() { return this.connected && this.writer !== null; }

  // ── 포트 연결 (사용자가 팝업에서 직접 선택) ──
  async connectCOM3() {
    if (!this.supported) {
      this._log('[SERIAL] Web Serial API 미지원 — 패킷 로그 모드', 'warn');
      this._status('unsupported');
      return false;
    }
    try {
      this._log('[SERIAL] 포트 연결 중... (팝업에서 포트 선택)', 'sys');
      this._status('connecting');

      // 항상 팝업을 띄워 사용자가 직접 포트를 선택
      this.port = await navigator.serial.requestPort();

      await this.port.open({ baudRate: this.baudRate });

      // ★ writable 스트림 Writer 한 번만 획득 (TextEncoderStream 사용 안 함)
      this.writer    = this.port.writable.getWriter();
      this.connected = true;

      this._log(`[SERIAL] ✅ 포트 연결 완료 · ${this.baudRate}bps`, 'rx');
      this._status('connected');
      return true;

    } catch (e) {
      const msg = (e.name === 'NotFoundError') ? '포트 선택 취소' : (e.message || String(e));
      this._log(`[SERIAL] 연결 실패: ${msg}`, 'warn');
      this.writer    = null;
      this.connected = false;
      this._status('disconnected');
      return false;
    }
  }

  // ── 연결 해제 ──
  async disconnect() {
    try {
      if (this.writer) {
        this.writer.releaseLock();
        this.writer = null;
      }
      if (this.port && this.port.readable === null) {
        await this.port.close();
      } else if (this.port) {
        await this.port.close().catch(() => {});
      }
      this.port = null;
    } catch (_) {}
    this.connected = false;
    this._status('disconnected');
    this._log('[SERIAL] 연결 해제', 'warn');
  }

  // ── 패킷 전송 (직렬화) ──
  async send(uint8Array) {
    const hexStr = SerialManager.toHex(uint8Array);

    if (!this.isConnected) {
      // 미연결 — 로그만 출력
      this._log(`[TX/SIM] ${hexStr}`, 'tx');
      return false;
    }

    // 동시 전송 방지 (앞 전송이 끝날 때까지 대기)
    while (this._sending) {
      await new Promise(r => setTimeout(r, 5));
    }
    this._sending = true;
    try {
      await this.writer.write(uint8Array);
      this._log(`[TX] ${hexStr}`, 'tx');
      return true;
    } catch (e) {
      this._log(`[SERIAL] 전송 오류: ${e.message}`, 'error');
      this.connected = false;
      this.writer    = null;
      this._status('disconnected');
      return false;
    } finally {
      this._sending = false;
    }
  }

  static toHex(arr) {
    return Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
  }

  _log(msg, cls = 'sys') {
    if (this.onLog) this.onLog(msg, cls); else console.log(msg);
  }
  _status(s) {
    if (this.onStatusChange) this.onStatusChange(s);
  }
}

// ══════════════════════════════════════════════════════════
// HumanoidRobot — 15바이트 패킷 빌더
// 구조: FF FF 4C 53 00 00 | 00 00 30 0C 03 [MOT] 00 64 | [CRC]
// CRC  = sum(byte[6]~byte[13]) & 0xFF
// ══════════════════════════════════════════════════════════
class HumanoidRobot {
  static buildPacket(motionId) {
    const pkt = new Uint8Array(15);
    pkt[0]=0xFF; pkt[1]=0xFF; pkt[2]=0x4C; pkt[3]=0x53;
    pkt[4]=0x00; pkt[5]=0x00;
    pkt[6]=0x00; pkt[7]=0x00;
    pkt[8]=0x30; pkt[9]=0x0C; pkt[10]=0x03;
    pkt[11] = motionId & 0xFF;
    pkt[12]=0x00; pkt[13]=0x64;
    let sum = 0;
    for (let i = 6; i <= 13; i++) sum += pkt[i];
    pkt[14] = sum & 0xFF;
    return pkt;
  }

  static packetToHex(pkt) {
    return Array.from(pkt).map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
  }

  static packetToArray(pkt) {
    return Array.from(pkt).map(b => b.toString(16).toUpperCase().padStart(2,'0'));
  }
}

// ══════════════════════════════════════════════════════════
// MotionSequencer — IDLE → ACTION → RETURN → IDLE
// ══════════════════════════════════════════════════════════
class MotionSequencer {
  constructor({
    returnMotion  = 1,
    actionHoldSec = 7,
    returnHoldSec = 3,
    serialManager = null,
    onSendMotion  = null,
    onStateChange = null,
    onLog         = null,
  } = {}) {
    this.returnMotion  = returnMotion;
    this.actionHoldSec = actionHoldSec;
    this.returnHoldSec = returnHoldSec;
    this.serialManager = serialManager;
    this.onSendMotion  = onSendMotion;
    this.onStateChange = onStateChange;
    this.onLog         = onLog;

    this.state         = SEQ_STATE.IDLE;
    this.currentMotion = null;
    this.stateTimer    = 0;
    this.totalTime     = 0;
    this.lastTick      = null;
    this.packetCount   = 0;
  }

  get isBusy() { return this.state !== SEQ_STATE.IDLE; }

  // ── 트리거 — IDLE일 때만 수락 ──
  trigger(motionId) {
    if (this.isBusy) {
      this._log(`[SEQ] BUSY(${this.state}) — Motion ${motionId} 무시됨`);
      return false;
    }
    this._log(`[SEQ] ▶ trigger(${motionId}) 수락 → ACTION`);
    this.currentMotion = motionId;
    this._enterState(SEQ_STATE.ACTION, this.actionHoldSec);
    this._sendMotion(motionId);
    return true;
  }

  _enterState(newState, duration) {
    this.state      = newState;
    this.stateTimer = duration;
    this.totalTime  = duration;
    this.lastTick   = performance.now();
    this._log(`[SEQ] 상태: ${newState} (${duration}s)`);
    if (this.onStateChange) this.onStateChange(newState, this.currentMotion);
  }

  // ── 패킷 생성 + 시리얼 전송 ──
  _sendMotion(id) {
    const pkt = HumanoidRobot.buildPacket(id);
    this.packetCount++;
    // 시리얼 전송 (SerialManager가 성공/실패 로그 처리)
    if (this.serialManager) {
      this.serialManager.send(pkt);   // async — 논블로킹
    }
    // UI 콜백
    if (this.onSendMotion) this.onSendMotion(id, pkt, this.packetCount);
  }

  _log(msg) { if (this.onLog) this.onLog(msg); }

  // ── RAF 루프에서 매 프레임 호출 ──
  update(now) {
    if (this.state === SEQ_STATE.IDLE || this.lastTick === null) return;

    const dt = (now - this.lastTick) / 1000;
    this.lastTick    = now;
    this.stateTimer -= dt;

    if (this.stateTimer > 0) return;

    if (this.state === SEQ_STATE.ACTION) {
      // ACTION 완료 → RETURN
      this._enterState(SEQ_STATE.RETURN, this.returnHoldSec);
      this._sendMotion(this.returnMotion);

    } else if (this.state === SEQ_STATE.RETURN) {
      // RETURN 완료 → IDLE
      this.state         = SEQ_STATE.IDLE;
      this.stateTimer    = 0;
      this.currentMotion = null;
      if (this.onStateChange) this.onStateChange(SEQ_STATE.IDLE, null);
      this._log('[SEQ] ✅ IDLE 복귀 — 재감지 준비 완료');
    }
  }

  stop() {
    this.state = SEQ_STATE.IDLE; this.stateTimer = 0; this.currentMotion = null;
    if (this.onStateChange) this.onStateChange(SEQ_STATE.IDLE, null);
  }

  reset() { this.stop(); this.packetCount = 0; }
}

// 전역 export
window.HumanoidRobot   = HumanoidRobot;
window.MotionSequencer = MotionSequencer;
window.SerialManager   = SerialManager;
window.SEQ_STATE       = SEQ_STATE;
window.COCO_CLASSES    = COCO_CLASSES;
