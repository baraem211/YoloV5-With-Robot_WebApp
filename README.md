# 🤖 YOLOv5 + Humanoid Robot Control WebApp

COCO-SSD (TensorFlow.js) 로 실시간 객체를 탐지하고, 탐지된 객체에 따라 휴머노이드 로봇에 모션 패킷을 전송하는 웹 애플리케이션입니다.

---

## ✅ 현재 구현된 기능

### 🎯 핵심 기능
- **COCO-SSD 실시간 탐지** — 웹캠 영상에서 80가지 객체 클래스 실시간 인식
- **LABEL_TO_MOTION 매핑** — 특정 객체 감지 시 지정된 모션 번호 자동 실행
- **MotionSequencer 상태 머신** — IDLE → ACTION(N초) → RETURN(N초) → IDLE 순환
- **15바이트 패킷 전송** — `FF FF 4C 53 ...` 형식 로봇 제어 패킷 빌드 및 전송

### 🔑 권한 & 포트 개선 (v2.0)
- **카메라 권한 요청 오버레이** — 시작 전 사용자에게 명시적 안내 화면 표시
  - 카메라 / 시리얼 포트 권한 상태를 실시간 뱃지로 표시
  - Chrome/Edge 미지원 브라우저 자동 감지 및 안내
  - 권한 거부 시 재시도 안내 메시지 표시
- **COM 포트 사용자 선택** — 기존 COM3 강제 설정 제거
  - 헤더의 "포트 선택·연결" 버튼 클릭 → 브라우저 팝업에서 원하는 포트 직접 선택
  - 시리얼 로그 패널 하단의 "포트 선택하여 로봇 연결하기" 버튼 추가
  - 연결된 포트 이름을 상태 뱃지 / 로봇 상태 패널 / 시리얼 로그 배지에 실시간 반영

### 🔌 Web Serial 연결
- Chrome / Edge 전용 Web Serial API 사용
- 연결 / 해제 토글 (헤더 + 시리얼 로그 패널 두 곳)
- 미연결 시 시뮬레이션 모드 (`[TX/SIM]` 로그 출력)
- 연결 시 실제 패킷 전송 (`[TX/PORT]` 로그 출력)

### 🛠 기타 UI
- 신뢰도 임계값 슬라이더
- 탐지 ON/OFF 토글
- LABEL_TO_MOTION 매핑 추가/삭제
- 수동 모션 트리거 (버튼 그리드 + 번호 직접 입력)
- 패킷 빌더 탭 (HEX 시각화, 전송 기록)
- 문서 탭 (동작 흐름, 매핑, 하드웨어 규격, 트러블슈팅)

---

## 📁 파일 구조

```
index.html              메인 페이지
css/
  style.css             전체 스타일시트 (웰컴 오버레이 포함)
js/
  robot-controller.js   SerialManager · HumanoidRobot · MotionSequencer
  yolo-simulator.js     COCO-SSD 탐지 엔진 (YoloSimulator)
  packet-builder.js     패킷 빌더 UI (PacketBuilderUI)
  app.js                메인 제어 로직 (showWelcomeOverlay · bootSystem)
```

---

## 🔄 동작 흐름

```
[1] 페이지 로드 → 웰컴 오버레이 표시 (카메라/포트 권한 안내)
[2] "카메라 권한 허용 후 시작" 버튼 클릭 → getUserMedia() 권한 요청
[3] 권한 허용 → COCO-SSD 모델 로드 (AI 모델 로딩 오버레이)
[4] 웹캠 스트림 시작 → 실시간 추론 루프 돌입
[5] 매 프레임: model.detect(video) → predictions[]
[6] confidence ≥ threshold 인 객체만 필터링
[7] LABEL_TO_MOTION에 매핑된 객체 발견 시 MotionSequencer.trigger(motionId)
[8] 시퀀서: ACTION(N초) → RETURN(N초) → IDLE
[9] 각 단계마다 HumanoidRobot.buildPacket(id) → SerialManager.send() 전송
```

---

## 📡 하드웨어 통신 규격

| 항목 | 값 |
|------|-----|
| 포트 | **사용자 팝업 선택** (COM3 고정 제거) |
| Baudrate | `115200 bps` |
| 패킷 크기 | `15 bytes` |
| 헤더 | `FF FF 4C 53` |
| 모션 인덱스 | `byte[11]` |
| 체크섬 | `byte[6]~byte[13] 합산 & 0xFF` |

---

## ⚠️ 미구현 / 향후 개선 사항

- [ ] Baud Rate 사용자 변경 UI (현재 115200 고정)
- [ ] 포트 목록 자동 스캔 및 드롭다운 선택 (Web Serial 확장)
- [ ] 모션 이름 커스텀 편집
- [ ] 매핑 설정 localStorage 저장/불러오기
- [ ] 모바일 반응형 UI 개선
- [ ] 실제 YOLOv5 모델(.onnx/.tflite) 교체 (현재 COCO-SSD 사용)

---

## 🌐 권장 브라우저

| 브라우저 | 카메라 탐지 | 로봇 시리얼 연결 |
|---------|-----------|--------------|
| **Chrome** | ✅ | ✅ |
| **Edge** | ✅ | ✅ |
| Firefox | ✅ | ❌ (Web Serial 미지원) |
| Safari | ✅ | ❌ (Web Serial 미지원) |
