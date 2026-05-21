/**
 * yolo-simulator.js
 * TensorFlow.js COCO-SSD 실시간 객체 탐지 엔진
 *
 * ▶ 핵심 수정 사항:
 *   - 디바운싱 완전 제거 (매 프레임 탐지 결과를 그대로 전달)
 *   - MotionSequencer.isBusy 체크는 app.js onDetections에서 수행
 *   - 탐지 상태 변화(등장/사라짐)만 로그 출력, 매 프레임 콜백 호출
 */

class YoloSimulator {
  constructor(canvasId, videoId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    this.ctx    = this.canvas?.getContext('2d');
    this.video  = document.getElementById(videoId);

    this.confThreshold    = options.confThreshold  || 0.45;
    this.labelToMotion    = options.labelToMotion   || {};
    this.onDetection      = options.onDetection     || null;
    this.onModelLoaded    = options.onModelLoaded   || null;
    this.onModelProgress  = options.onModelProgress || null;

    this.model        = null;
    this.running      = false;
    this.webcamActive = false;
    this.detectionEnabled = true;

    this.fps       = 0;
    this.fpsCount  = 0;
    this.fpsTimer  = 0;
    this._lastTime = 0;
    this._raf      = null;

    // 이전 탐지 레이블 집합 (등장/사라짐 감지용 — 로그 전용)
    this._prevLabels = new Set();
  }

  // ────────────────────────────────────────────
  // 모델 로드
  // ────────────────────────────────────────────
  async loadModel() {
    try {
      if (this.onModelProgress) this.onModelProgress(10, 'TensorFlow.js 초기화 중...');
      await tf.ready();

      if (this.onModelProgress) this.onModelProgress(30, 'COCO-SSD 모델 다운로드 중... (첫 실행 시 수 초 소요)');
      this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });

      if (this.onModelProgress) this.onModelProgress(100, '✅ COCO-SSD 모델 로드 완료!');
      if (this.onModelLoaded)   this.onModelLoaded();
      return true;
    } catch (e) {
      console.error('[COCO-SSD] 모델 로드 실패:', e);
      if (this.onModelProgress) this.onModelProgress(-1, '모델 로드 실패: ' + e.message);
      return false;
    }
  }

  // ────────────────────────────────────────────
  // 웹캠 시작
  // ────────────────────────────────────────────
  async startWebcam() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
      });
      this.video.srcObject = stream;

      await new Promise((resolve, reject) => {
        this.video.onloadedmetadata = resolve;
        this.video.onerror = reject;
        setTimeout(() => reject(new Error('webcam timeout')), 12000);
      });

      await this.video.play();
      this.webcamActive = true;

      this.canvas.width  = this.video.videoWidth  || 640;
      this.canvas.height = this.video.videoHeight || 480;
      return true;
    } catch (e) {
      console.error('[CAM] 웹캠 오류:', e);
      this.webcamActive = false;
      return false;
    }
  }

  stopWebcam() {
    if (this.video?.srcObject) {
      this.video.srcObject.getTracks().forEach(t => t.stop());
      this.video.srcObject = null;
    }
    this.webcamActive = false;
  }

  // ────────────────────────────────────────────
  // 추론 루프 시작 / 중지
  // ────────────────────────────────────────────
  start() {
    if (this.running) return;
    this.running   = true;
    this._lastTime = performance.now();
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this._clearCanvas();
  }

  // ────────────────────────────────────────────
  // 메인 추론 루프 (requestAnimationFrame)
  // ────────────────────────────────────────────
  async _loop() {
    if (!this.running) return;

    const now = performance.now();
    const dt  = now - this._lastTime;
    this._lastTime = now;

    // FPS 계산
    this.fpsCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 1000) {
      this.fps      = this.fpsCount;
      this.fpsCount = 0;
      this.fpsTimer = 0;
      const el = document.getElementById('fps-counter');
      if (el) el.textContent = `${this.fps} FPS`;
    }

    // 캔버스 크기 동기화
    if (this.webcamActive && this.video.videoWidth > 0) {
      if (this.canvas.width  !== this.video.videoWidth ||
          this.canvas.height !== this.video.videoHeight) {
        this.canvas.width  = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
      }
    }

    const W = this.canvas.width  || 640;
    const H = this.canvas.height || 480;

    // 비디오 프레임 → 캔버스
    if (this.webcamActive && this.video.readyState >= 2) {
      this.ctx.drawImage(this.video, 0, 0, W, H);
    } else {
      this._drawNoCamera(W, H);
    }

    // ── COCO-SSD 추론 ──
    let predictions = [];
    if (this.model && this.detectionEnabled
        && this.webcamActive
        && this.video.readyState >= 2
        && !this.video.paused
        && !this.video.ended) {
      try {
        predictions = await this.model.detect(this.video);
      } catch (_) {
        // 추론 오류 무시
      }
    }

    // 신뢰도 필터링
    const above = predictions.filter(p => p.score >= this.confThreshold);

    // 박스 그리기
    above.forEach(p => this._drawBox(p, W, H));

    // 스캔라인
    this._drawScanLine(now, W, H);

    // ── 탐지 콜백 — 매 프레임 전달 ──
    // (시퀀서의 isBusy 체크는 app.js onDetections에서 처리)
    if (this.onDetection) {
      this.onDetection(above.map(p => ({
        label: p.class,
        conf:  p.score,
        bbox:  p.bbox,
      })));
    }

    // 다음 프레임 스케줄
    this._raf = requestAnimationFrame(() => this._loop());
  }

  // ────────────────────────────────────────────
  // 탐지 박스 그리기
  // ────────────────────────────────────────────
  _drawBox(pred, W, H) {
    const [x, y, w, h] = pred.bbox;
    const label  = pred.class;
    const conf   = pred.score;
    const mapped = this.labelToMotion[label] !== undefined;
    const color  = mapped ? '#00ff88' : '#00ccff';

    this.ctx.save();

    // 글로우 박스
    this.ctx.shadowColor = mapped ? 'rgba(0,255,136,0.5)' : 'rgba(0,200,255,0.3)';
    this.ctx.shadowBlur  = mapped ? 14 : 8;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth   = mapped ? 2.5 : 1.5;
    this.ctx.strokeRect(x, y, w, h);

    // 반투명 채우기
    this.ctx.shadowBlur = 0;
    this.ctx.fillStyle  = mapped ? 'rgba(0,255,136,0.06)' : 'rgba(0,200,255,0.03)';
    this.ctx.fillRect(x, y, w, h);

    // 모서리 마커 (매핑 객체만)
    if (mapped) {
      const cs = Math.min(14, w * 0.2, h * 0.2);
      this.ctx.strokeStyle = '#00ff88';
      this.ctx.lineWidth   = 3;
      this.ctx.shadowColor = '#00ff88';
      this.ctx.shadowBlur  = 10;
      [[0,0,cs,0,0,cs],[w,0,-cs,0,0,cs],[0,h,cs,0,0,-cs],[w,h,-cs,0,0,-cs]]
        .forEach(([ox,oy,dx1,dy1,dx2,dy2]) => {
          this.ctx.beginPath();
          this.ctx.moveTo(x+ox+dx1, y+oy+dy1);
          this.ctx.lineTo(x+ox,     y+oy);
          this.ctx.lineTo(x+ox+dx2, y+oy+dy2);
          this.ctx.stroke();
        });
    }
    this.ctx.shadowBlur = 0;

    // 라벨 텍스트
    const motionStr  = mapped ? ` ▶ M#${this.labelToMotion[label]}` : '';
    const labelText  = `${label}  ${(conf*100).toFixed(0)}%${motionStr}`;
    const fontSize   = mapped ? 13 : 11;
    this.ctx.font    = `bold ${fontSize}px 'JetBrains Mono', monospace`;
    const tw  = this.ctx.measureText(labelText).width;
    const lx  = Math.max(0, Math.min(x, W - tw - 16));
    const ly  = y > 26 ? y - 26 : y + h + 4;

    this.ctx.fillStyle = mapped ? 'rgba(0,255,136,0.9)' : 'rgba(0,200,255,0.8)';
    this._roundRect(lx, ly, tw + 14, 20, 4);
    this.ctx.fill();

    this.ctx.fillStyle = '#000';
    this.ctx.fillText(labelText, lx + 7, ly + 14);

    this.ctx.restore();
  }

  _roundRect(x, y, w, h, r) {
    this.ctx.beginPath();
    this.ctx.moveTo(x+r, y);
    this.ctx.lineTo(x+w-r, y);
    this.ctx.quadraticCurveTo(x+w, y, x+w, y+r);
    this.ctx.lineTo(x+w, y+h-r);
    this.ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
    this.ctx.lineTo(x+r, y+h);
    this.ctx.quadraticCurveTo(x, y+h, x, y+h-r);
    this.ctx.lineTo(x, y+r);
    this.ctx.quadraticCurveTo(x, y, x+r, y);
    this.ctx.closePath();
  }

  _drawNoCamera(W, H) {
    this.ctx.fillStyle = '#060a10';
    this.ctx.fillRect(0, 0, W, H);
    this.ctx.strokeStyle = 'rgba(0,245,255,0.04)';
    this.ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) {
      this.ctx.beginPath(); this.ctx.moveTo(x,0); this.ctx.lineTo(x,H); this.ctx.stroke();
    }
    for (let y = 0; y < H; y += 40) {
      this.ctx.beginPath(); this.ctx.moveTo(0,y); this.ctx.lineTo(W,y); this.ctx.stroke();
    }
    this.ctx.font = '13px JetBrains Mono, monospace';
    this.ctx.fillStyle = 'rgba(0,245,255,0.2)';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('NO CAMERA SIGNAL', W/2, H/2);
    this.ctx.textAlign = 'left';
  }

  _drawScanLine(now, W, H) {
    const y = ((now / 3500) % 1) * H;
    const g = this.ctx.createLinearGradient(0, y-24, 0, y+24);
    g.addColorStop(0,   'rgba(0,245,255,0)');
    g.addColorStop(0.5, 'rgba(0,245,255,0.04)');
    g.addColorStop(1,   'rgba(0,245,255,0)');
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, y-24, W, 48);
  }

  _clearCanvas() {
    if (this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const el = document.getElementById('fps-counter');
    if (el) el.textContent = '-- FPS';
  }

  updateLabelToMotion(map) { this.labelToMotion = map; }
  setConfThreshold(v)      { this.confThreshold = v;   }
}

window.YoloSimulator = YoloSimulator;
