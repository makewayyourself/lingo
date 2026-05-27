# 백엔드 배포 가이드 (Cloudflare Workers)

이 폴더의 `worker.js`를 Cloudflare에 올리면 회원들이 각자 폰에서 독립적으로 사용할 수 있어요.
무료 (월 10만 요청), 30~60분 소요.

---

## 방법 A: 대시보드(브라우저)로 배포 — 추천, CLI 불필요

### 1) Cloudflare 가입
- https://dash.cloudflare.com/sign-up 에서 계정 생성 (무료)
- 이메일 확인

### 2) Worker 생성
- 좌측 메뉴 **Workers & Pages** 클릭
- **Create application** → **Create Worker**
- 이름: `lingo-api` (또는 원하는 이름)
- **Deploy** 클릭 (일단 기본 hello world로 배포)

### 3) 코드 교체
- 배포된 Worker 페이지에서 **Edit code** 클릭
- 좌측 에디터의 모든 코드를 삭제하고 `worker.js` 전체 내용 붙여넣기
- 우측 상단 **Save and deploy** 클릭

### 4) KV 네임스페이스 연결
- Worker 페이지 → **Settings** 탭 → **Bindings** 섹션
- **Add binding** → **KV Namespace** 선택
  - Variable name: `LINGO_KV`
  - KV namespace: **Create new** → 이름 `lingo_kv` → Add
- **Deploy** 클릭

### 5) API 키 등록 (Secret)
- 같은 페이지 → **Settings** → **Variables and Secrets** 섹션
- **Add** → **Type: Secret**
  - Variable name: `ANTHROPIC_API_KEY`
  - Value: `sk-ant-...` (본인 Anthropic API 키)
- **Deploy** 클릭

### 6) Worker URL 복사
- Worker 페이지 상단의 URL (예: `https://lingo-api.YOUR-NAME.workers.dev`) 복사

### 7) 동작 확인
브라우저에서 `https://lingo-api.YOUR-NAME.workers.dev/health` 열면 아래처럼 표시되면 성공:
```json
{"ok":true,"members":0,"max":5,"apiKeyConfigured":true,"version":"1.0"}
```

### 8) Lingo 앱에 URL 등록
- 폰 또는 PC에서 `https://makewayyourself.github.io/lingo/` 접속
- 첫 화면 → **백엔드 연결** 입력란에 위 URL 붙여넣기
- 첫 가입자 = 자동으로 관리자가 됩니다 (이름 + 6자리 PIN 입력)
- 다른 회원에게 URL 공유 → 각자 폰에서 같은 URL 입력 → 회원 가입

---

## 방법 B: wrangler CLI로 배포 (개발자용)

### 사전 조건
- Node.js 18+ 설치 (https://nodejs.org)
- 터미널 사용 가능

### 단계
```bash
cd worker
npm install -g wrangler
wrangler login                                            # 브라우저로 인증
wrangler kv:namespace create LINGO_KV                     # 출력에서 id= 부분 복사
# wrangler.toml 의 REPLACE_WITH_YOUR_KV_ID 자리에 위 id 붙여넣기
wrangler secret put ANTHROPIC_API_KEY                      # 프롬프트에 키 붙여넣기
wrangler deploy                                            # 배포 (URL 출력됨)
```

---

## 비용 / 한도

- **Worker**: 무료 플랜 — 일 10만 요청 (회원 5명에 충분)
- **KV**: 무료 플랜 — 일 10만 read / 1k write
- **Anthropic API**: 본인 결제 (관리자 카드)
- 회원 1명당 평균 사용시 월 1,000~2,000원 수준 (Claude Haiku 4.5)

---

## 사용량 보기

관리자는 앱의 **관리자 페이지**에서 각 회원의 AI 호출 횟수를 확인할 수 있어요.
더 자세히 보려면:
- Cloudflare 대시보드 → Workers & Pages → lingo-api → **Metrics** 탭
- Anthropic Console → Usage

---

## 보안 체크리스트

- [x] API 키는 Cloudflare Secret에 저장 (코드/저장소에 없음)
- [x] 회원 PIN은 SHA-256으로 해시 저장
- [x] 세션 토큰 30일 자동 만료
- [x] 관리자 전용 엔드포인트는 토큰 role 검사
- [x] 최대 5명 강제
- [ ] 회원이 너무 자주 AI를 호출하면 rate limit 추가 (현재 없음)
- [ ] 더 강한 보안이 필요하면 CORS Origin을 GitHub Pages URL로 잠그기

---

## 문제 해결

- `/health` 가 404 → 코드가 제대로 저장 안 됨. Edit code 다시 확인
- `apiKeyConfigured: false` → ANTHROPIC_API_KEY Secret이 누락 또는 오타
- 앱에서 "로그인이 필요해요" → 세션 만료. 다시 로그인
- 앱에서 "관리자가 API 키를 아직 설정하지 않았어요" → Secret 미등록, 5번 단계 다시
- CORS 에러 → Worker 코드 최신인지 확인 (corsHeaders 함수 존재해야)
