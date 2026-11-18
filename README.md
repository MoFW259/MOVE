# MOVE

웹캠 앞에서 몸과 손의 움직임에 반응하는 WebGL 시각 작품 모음집입니다. 카메라 영상은 기기 안에서 MediaPipe로 처리하며, 카메라를 사용하지 않아도 마우스와 터치로 모든 작품을 체험할 수 있습니다.

## 주요 기능

- 손, 포즈, 얼굴, 세그멘테이션 입력을 활용한 인터랙티브 WebGL 작품
- 포스터 그리드에서 작품을 선택하는 해시 라우팅 UI
- 핀치, 손바닥, 주먹, 가리키기, 스와이프 제스처 지원
- 카메라 권한 거절 시 자동으로 포인터 모드 전환
- MediaPipe 모델의 로컬 호스팅 및 브라우저 내 처리
- 디버그 오버레이와 녹화 영상 fixture 지원

## 실행 방법

```sh
npm install
npm run dev
```

개발 서버를 실행한 뒤 브라우저에서 표시된 주소를 엽니다. `npm install` 과정에서 필요한 MediaPipe 모델도 `public/models/`에 내려받습니다.

## 명령어

```sh
npm run dev        # 개발 서버
npm run typecheck  # TypeScript 검사
npm test           # 입력 및 제스처 테스트
npm run build      # 프로덕션 빌드
npm run preview    # 빌드 결과 미리보기
```

## 입력 모드

- 카메라 모드: 손의 위치와 제스처로 작품을 조작합니다.
- 포인터 모드: 마우스와 터치를 가짜 손 입력으로 변환해 동일한 인터페이스를 사용합니다.
- fixture 모드: 개발 중 녹화 영상을 입력으로 사용할 수 있습니다.

예시:

```text
#!/main
#!/exp/blackhole
#!/exp/ripple?src=fixture:sample&debug
```

## 프로젝트 구조

```text
src/
  core/                 공통 라우터, 입력 계층, 제스처, 렌더링 셸
  experiences/          개별 WebGL 작품
  main/                 메인 포스터 화면과 전환 효과
  main.ts               앱 진입점
public/
  models/               설치 시 내려받는 MediaPipe 모델
scripts/                모델 다운로드 스크립트
fixtures/               로컬 개발용 테스트 영상
```

새 작품은 `src/experiences/<id>/` 아래에 `index.ts`와 선택적인 `meta.ts`를 추가하는 방식으로 만듭니다. 자세한 인터페이스와 개발 규칙은 [`AGENTS.md`](./AGENTS.md)와 [`PRD.md`](./PRD.md)를 참고하세요.

## 개인정보 보호

카메라 프레임은 서버로 전송하거나 저장하지 않습니다. MediaPipe 추론은 브라우저에서 수행되며, 사용자가 카메라 권한을 거부하면 포인터 모드로 계속 사용할 수 있습니다.

## 기술 스택

- Vite
- TypeScript
- three.js
- MediaPipe Tasks Vision

