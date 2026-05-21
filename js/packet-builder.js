/**
 * packet-builder.js
 * 패킷 빌더 탭 UI 로직
 */

class PacketBuilderUI {
  constructor() {
    this.history = [];

    this._bindEvents();
    this._buildPacket(19); // 기본값
  }

  _bindEvents() {
    document.getElementById('pkt-build-btn')?.addEventListener('click', () => {
      const id = parseInt(document.getElementById('pkt-motion-id').value) || 19;
      this._buildAndAnimate(id);
    });

    document.getElementById('pkt-motion-id')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const id = parseInt(e.target.value) || 19;
        this._buildAndAnimate(id);
      }
    });

    // 빠른 선택 버튼
    document.querySelectorAll('.pkt-quick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.motion);
        document.getElementById('pkt-motion-id').value = id;
        this._buildAndAnimate(id);
      });
    });
  }

  _buildAndAnimate(motionId) {
    this._buildPacket(motionId);
    this._addHistory(motionId);
    this._animateBytes();
  }

  _buildPacket(motionId) {
    const pkt = HumanoidRobot.buildPacket(motionId);
    const hexArr = HumanoidRobot.packetToArray(pkt);

    // 바이트 타입 분류
    const types = [
      'header','header','header','header',    // 0-3
      'reserved','reserved',                  // 4-5
      'cmd','cmd','cmd','cmd','cmd',           // 6-10
      'motion',                               // 11
      'extra','extra',                        // 12-13
      'crc'                                   // 14
    ];

    // 바이트 시각화
    const container = document.getElementById('pkt-bytes');
    if (!container) return;
    container.innerHTML = '';

    hexArr.forEach((hex, i) => {
      const div = document.createElement('div');
      div.className = `pkt-byte byte-${types[i]}`;
      div.id = `pkt-byte-${i}`;
      div.innerHTML = `
        <div class="pkt-byte-idx">[${i}]</div>
        <div class="pkt-byte-val">${hex}</div>
        <div class="pkt-byte-idx">${this._byteName(i)}</div>
      `;
      container.appendChild(div);
    });

    // HEX 출력
    const hexOut = document.getElementById('pkt-hex-output');
    if (hexOut) hexOut.textContent = HumanoidRobot.packetToHex(pkt);

    // 체크섬 계산 상세
    const csDetail = document.getElementById('pkt-checksum-detail');
    if (csDetail) {
      let csBytes = [];
      let csSum = 0;
      for (let i = 6; i <= 13; i++) {
        csBytes.push(`${hexArr[i]}`);
        csSum += pkt[i];
      }
      csDetail.textContent = `(${csBytes.join(' + ')}) & 0xFF = ${(csSum & 0xFF).toString(16).toUpperCase().padStart(2,'0')} (0x${(csSum & 0xFF).toString(16).toUpperCase()})`;
    }

    // 바이트 맵 업데이트
    const bmMotion = document.getElementById('bm-motion');
    const bmCrc    = document.getElementById('bm-crc');
    if (bmMotion) bmMotion.textContent = hexArr[11];
    if (bmCrc)    bmCrc.textContent    = hexArr[14];

    this._currentPkt = pkt;
    this._currentMotion = motionId;
  }

  _byteName(i) {
    const names = ['HDR','HDR','HDR','HDR','RSV','RSV','CMD','CMD','CMD','CMD','CMD','MOT','RSV','SPD','CRC'];
    return names[i] || '';
  }

  _animateBytes() {
    const all = document.querySelectorAll('.pkt-byte');
    all.forEach((el, i) => {
      setTimeout(() => {
        el.classList.add('highlighted');
        setTimeout(() => el.classList.remove('highlighted'), 400);
      }, i * 40);
    });

    // 모션 & CRC 바이트 강조
    setTimeout(() => {
      const motionByte = document.getElementById('pkt-byte-11');
      const crcByte    = document.getElementById('pkt-byte-14');
      if (motionByte) { motionByte.classList.add('highlighted'); setTimeout(() => motionByte.classList.remove('highlighted'), 1000); }
      if (crcByte)    { crcByte.classList.add('highlighted');    setTimeout(() => crcByte.classList.remove('highlighted'), 1000); }
    }, 200);
  }

  _addHistory(motionId) {
    if (!this._currentPkt) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('ko-KR', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });

    this.history.unshift({
      motionId,
      hex: HumanoidRobot.packetToHex(this._currentPkt),
      time: timeStr
    });

    if (this.history.length > 20) this.history.pop();
    this._renderHistory();
  }

  _renderHistory() {
    const container = document.getElementById('pkt-history');
    if (!container) return;

    if (this.history.length === 0) {
      container.innerHTML = '<div class="pkt-history-empty">아직 패킷을 전송하지 않았습니다</div>';
      return;
    }

    const names = { 1:'기본자세', 17:'모션17', 18:'손흔들기', 19:'인사', 20:'커스텀' };

    container.innerHTML = this.history.map(h => `
      <div class="pkt-history-entry">
        <span class="pkt-h-motion">Motion #${h.motionId} ${names[h.motionId] ? `<span style="color:var(--text-muted)">(${names[h.motionId]})</span>` : ''}</span>
        <span class="pkt-h-hex">${h.hex}</span>
        <span class="pkt-h-time">${h.time}</span>
      </div>
    `).join('');
  }

  // 외부에서 시뮬레이터가 패킷 전송할 때 호출
  addFromSimulator(motionId) {
    this._buildPacket(motionId);
    this._addHistory(motionId);
  }
}

window.PacketBuilderUI = PacketBuilderUI;
