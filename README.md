# Claude Code 사용량 대시보드

Flask(UI) + FastAPI(API) + Plotly.js로 Claude Code / Codex 등 사용량을 조회합니다.  
`ccusage` 조회는 API 백그라운드에서 실행되어 **조회 중에도 브라우저 UI는 계속 사용**할 수 있습니다.

## 요구 사항

- [Node.js](https://nodejs.org/) (npx로 `ccusage` 실행)
- Docker / Docker Compose (권장) 또는 Python 3.12+

터미널에서 동작 확인:

```bash
npx --yes ccusage daily -j
```

## 구조

```text
브라우저 → Flask (HTML + Plotly.js)
              ↓ fetch
         FastAPI → ccusage (npx)
```

| 경로 | 설명 |
|------|------|
| `services/` | ccusage CLI, Plotly JSON, 캐시 |
| `api/` | FastAPI REST |
| `web/` | Flask 템플릿 · 정적 파일 |

## 빠른 시작 (Docker Compose)

1. 환경 파일 준비

```bash
cp .env.example .env
```

2. `.env`에서 `CLAUDE_DATA_DIR`를 **본인 환경의 Claude 데이터 경로**로 설정

| OS | 예시 |
|----|------|
| Windows | `C:\Users\<사용자>\.claude` |
| macOS / Linux | `/home/<사용자>/.claude` |

3. 실행

```bash
docker compose up --build
```

스냅샷은 `data/timeline/`에 쌓입니다. 재배포 전에 백업하려면 이 폴더만 복사하면 됩니다.

4. 접속

- 대시보드: http://localhost:5000 (기본 `WEB_PORT`)
- API 문서: http://localhost:8000/docs (기본 `API_PORT`)

## 로컬 실행 (Docker 없이)

저장소 루트에서:

```bash
pip install -r requirements-api.txt -r requirements-web.txt
```

**API** (터미널 1):

```bash
export PYTHONPATH=.   # Windows PowerShell: $env:PYTHONPATH="."
uvicorn api.main:app --reload --port 8000
```

**Web** (터미널 2):

```bash
export API_BASE_URL=http://localhost:8000   # PowerShell: $env:API_BASE_URL="http://localhost:8000"
cd web && python app.py
```

브라우저: http://localhost:5000

## 환경 변수 (`.env`)

| 변수 | 설명 | 기본 |
|------|------|------|
| `CLAUDE_DATA_DIR` | 호스트의 `.claude` 디렉터리 (Compose 볼륨) | *(필수)* |
| `WEB_PORT` | 웹 UI 호스트 포트 | `5000` |
| `API_PORT` | API 호스트 포트 | `8000` |
| `CORS_ORIGINS` | 미설정 시 `http://localhost:<WEB_PORT>` 자동 | — |
| `API_BASE_URL` | 미설정 시 `http://localhost:<API_PORT>` 자동 | — |
| `HISTORY_TTL_SEC` | 기록 API 캐시 TTL(초) | `60` |
| `REALTIME_TTL_SEC` | 실시간 API 캐시 TTL(초) | `60` |
| `MINUTE_SNAPSHOT_ENABLED` | 분 단위 오늘 스냅샷 (시간별 차트) | `true` |
| `MINUTE_SNAPSHOT_INTERVAL_SEC` | 스냅샷 주기(초), 최소 30 | `60` |
| `USAGE_TIMELINE_HOST_DIR` | 스냅샷 **호스트** 폴더 (Compose 바인드 마운트) | `./data/timeline` |
| `USAGE_TIMELINE_DIR` | 컨테이너 내부 경로 (보통 변경 불필요) | `/data/timeline` |

### 스냅샷 데이터 보존

분 단위 스냅샷은 **프로젝트의 `data/timeline/`** 에 저장됩니다 (`docker compose` 바인드 마운트).  
`docker compose up --build`로 이미지를 다시 빌드해도 **파일은 호스트에 남습니다.**

- 저장 파일: `data/timeline/YYYYMMDD.jsonl`
- 데이터까지 지우려면: `docker compose down` (볼륨 삭제 옵션 `-v`는 named volume용 — 바인드 마운트는 **폴더를 직접 삭제**해야 함)
- 예전 `usage-timeline` named volume에 데이터가 있었다면, 한 번만 복사:

```bash
docker run --rm -v claude_check_usage-timeline:/from -v "%cd%/data/timeline":/to alpine cp -a /from/. /to/
```

(볼륨 이름은 `docker volume ls`로 확인)

### 포트 변경

| 변경 | CORS | 비고 |
|------|------|------|
| `WEB_PORT`만 변경 | **웹 포트와 맞춤** (Compose 기본값 자동) | Origin은 웹 주소 기준 |
| `API_PORT`만 변경 | 변경 불필요 | `API_BASE_URL`은 Compose 기본값 자동 |

`.env`에 `CORS_ORIGINS` / `API_BASE_URL`을 직접 적으면 그 값이 우선합니다.

## API

- `GET /health`
- `GET /api/v1/usage/history?since=&until=&force=&ttl=`
- `GET /api/v1/usage/realtime?force=&ttl=`

응답 `status`: `loading` | `ready` | `error` — 프론트는 `loading` 시 주기적으로 재요청합니다.

## 화면

- **기록·차트**: 기간별 사용량, 추이 / 일별 표 / 모델별 (시작·종료일 변경 시 자동 갱신)
- **실시간 (오늘)**: 당일 합계, 활성 세션 블록, **모델별**, 분 스냅샷 기반 **증분/누적 선·영역 차트** (시간별 / 최근 2시간·5분, 세션별은 접기)

활성 블록 시간은 API의 UTC 값을 **한국 시간(Asia/Seoul)** 으로 표시합니다.

## 문제 해결

- **API connection refused**: 브라우저의 API URL이 `http://localhost:<API_PORT>` 인지 확인
- **CORS 오류**: `CORS_ORIGINS`에 **웹 UI 주소**가 포함됐는지 확인 (API 포트 아님)
- **데이터 없음**: `CLAUDE_DATA_DIR`가 실제 `.claude` 경로와 일치하는지, 볼륨 마운트가 읽기 가능한지 확인
- **첫 조회가 느림**: `npx`가 `ccusage` 패키지를 받는 데 수십 초 걸릴 수 있음

## 라이선스

저장소에 LICENSE 파일이 없다면 사용 전 저장소 소유자에게 문의하세요.
