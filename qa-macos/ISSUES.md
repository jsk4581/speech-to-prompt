# 이슈 초안 — macOS QA

macOS 26.3.1 · Apple M4 · Node 22.23.1 · 커밋 `a1fbe57` 기준. 각 항목은 그대로
GitHub 이슈 본문으로 옮길 수 있게 썼습니다. `qa-macos/` 안의 픽스처와 스크립트로
Windows/Linux에서도 (whisper-cli만 있으면) 재현됩니다.

우선순위 제안: **M17 → M1 → M15 → M13 → M14 → M3** 순. M17은 제품 신뢰의 근간이고,
M15는 나머지 전사 수정의 효과를 측정할 도구입니다.

---

## M17 · 한 녹음에 두 언어가 섞이면 한쪽이 통째로, 조용히 사라진다

`blocker` `stt` `all-platforms`

**증상.** 한국어 발화 중간에 영어 문장이 들어가면 그 구간이 전사에서 사라집니다.
오류도 경고도 빈자리 표시도 없습니다.

**재현.**
```bash
cd qa-macos && python3 build-cases.py
whisper-cli -m <turbo-model> -f cases/mix_sentence.wav -l auto -nt -t 5
```

**관측.** 한국어 문장만 나오고 영어 6.3초는 없음. 영어를 앞에 두어도(`mix_reversed`),
`-l ko`로 고정해도 동일. 대조군 `ctl_ko_ko`(한국어 2문장)는 둘 다 정상 전사되므로
클립 연결 자체는 무관합니다. 경계는 영어 0.5초(살아남음)와 1.6초(사라짐) 사이.

**기대.** 사용자가 말한 모든 구간이 전사에 남거나, 최소한 무언가 버려졌음을 알 수 있어야
합니다.

**영향.** "말한 것만, 말한 그대로 구조화한다"는 제품의 핵심 약속이 조용히 깨집니다.
한국어로 말하며 영어 용어·문장을 섞는 것은 대상 사용자의 예외가 아니라 기본 상황입니다.
실사용 검증에서도 사용자가 분명히 읽은 문장 하나(영어 용어가 가장 몰린 문장)가
전사에서 사라졌습니다.

**원인.** whisper는 파일당 언어를 하나로 고정해 디코딩합니다. `server.ts:430`이
`STP_LANG ?? "auto"`를 쓰고 `audio.ts:81`이 그대로 `-l`로 넘깁니다.

**제안.** `BENCH.md` 참조.
- `--prompt`에 저장소 식별자를 주입하면 사라졌던 영어 구간이 복구됩니다(측정 완료).
  STP는 이미 저장소를 읽으므로 재료가 있습니다. 부작용으로 한국어 일부가 영어 표기로
  바뀌는데, 코딩 프롬프트에서는 바람직할 수도 있어 판단이 필요합니다.
- `-l en` 기본값 전환은 **탈락**입니다 — 순수 한국어에서 내용이 통째로 날아가고 무관한
  영어 문장이 반복 생성됩니다.
- 팝업에 언어 선택(자동·한국어·영어)을 노출하고 `STP_LANG`을 문서화하는 것이 최소선.

---

## M1 · brew 없는 맥에는 음성 엔진이 없고, 그 사실을 녹음 후에야 알게 된다

`blocker` `macos` `first-run`

**증상.** Homebrew로 `whisper-cpp`를 설치하지 않은 맥에서 `/stp:voice`는 팝업까지
정상으로 열리지만, 녹음을 마치는 순간 실패합니다.

**재현.** PATH에서 Homebrew를 제외하고 빈 `CLAUDE_PLUGIN_DATA`로 헬퍼 실행 후
`/transcribe` 호출.

**관측.**
```
[stp] No prebuilt whisper-cli on macOS. Install it with `brew install whisper-cpp`…
POST /transcribe → 503 {"error":"BYOK cloud STT is not wired yet"}
```
팝업에는 `⚠ POST /transcribe → 503 …`이 전사 자리에 찍힙니다. 녹음 전 표시는
`· capture · (no model yet)` 뿐입니다.

**배경.** whisper.cpp는 macOS용 prebuilt CLI를 배포하지 않습니다 — v1.9.1 릴리스 에셋은
ubuntu(x64/arm64)·Windows 바이너리와 xcframework뿐입니다. 따라서
`bootstrap.ts:140-147`이 darwin에서 `null`을 반환하는 것은 정상이고, 문제는 그 뒤의
BYOK 분기가 미구현(`server.ts:570`)이라는 점입니다.

**제안.** (a) macOS 요구사항으로 `brew install whisper-cpp`를 명시하고 팝업이 **녹음
전에** 안내하도록 `ready` 이벤트 확장, (b) macOS용 whisper-cli 배포, (c) BYOK 구현.
최소한 (a)는 즉시 필요합니다.

---

## M15 · 전사 원본 오디오가 즉시 삭제돼 품질 문제를 사후 조사할 수 없다

`enhancement` `stt` `debuggability`

**증상.** `/transcribe`가 임시 WAV를 `finally`에서 바로 삭제합니다
(`server.ts:574`, `:595-598`). 나쁜 전사가 나와도 원본이 없어 대조할 수 없습니다.

**영향.** 이번 QA에서 실사용 녹음의 문장 소실을 확인하려 했으나 원본이 없어
합성 오디오로 우회해야 했고, **그 녹음에서 실제로 무슨 일이 있었는지는 끝내 확인하지
못했습니다.** M14·M17 수정의 효과 측정도 같은 이유로 막힙니다.

**제안.** 프라이버시 기본값은 지금이 맞으니 `STP_KEEP_AUDIO=1` 같은 옵트인으로 런
디렉터리에 WAV를 남기기. 몇 줄이면 되고, 다른 STT 수정의 선행 조건입니다.

---

## M13 · 미해결 질문 슬롯이 inject 게이트를 그대로 통과한다

`bug` `xml` `safety`

**증상.** `assertInjectable`은 미해결 질문 슬롯이 남은 드래프트를 거부하지만
(`xml.ts:287-289`), 팝업을 거친 XML에는 이 검사가 걸리지 않습니다. 확정 문서는
`parseXml`로 다시 읽히며 `source: "question"` 표식이 사라지고, 남는 평문은 게이트를
통과합니다.

**재현.** 질문 슬롯이 있는 라운드를 발행하고 팝업에서 Confirm.

**관측.** `{"status":"confirmed","ok":true}` 와 함께 `<objective>`에 질문 문구가 그대로
남고, `mode="?"`는 조용히 제거됩니다.

**영향.** 안전망이 "에이전트가 답변 접기 단계를 반드시 수행한다"는 가정 하나에만
걸려 있습니다. 건너뛰면 질문 문구가 코딩 에이전트에게 지시로 주입됩니다.

**제안.** 질문 슬롯을 `<?q1?>` 같은 텍스트 마커로 렌더링하고 `assertInjectable`이 그
패턴을 거부하게 하거나, `finalizeConfirmed`에 직전 라운드 draft를 넘겨 대조. 어느 쪽이든
`tests/xml.test.mjs`에 회귀 케이스를 추가할 수 있습니다.

---

## M14 · 발화 끝 잡음 꼬리에서 없는 문장이 생성된다

`bug` `stt`

**재현.**
```bash
cd qa-macos && python3 build-cases.py
whisper-cli -m <turbo-model> -f cases/tail_over_boundary.wav -l auto -nt -t 5
```

**관측.** 끝에 `감사합니다.` 가 붙습니다. 대조군 `tail_control`(꼬리 없음)은 깨끗하고,
`tail_digital_silence`(완전한 0 무음)로는 재현되지 않습니다 — 트리거는 마지막 30초
윈도우가 **실제 노이즈 플로어로만 채워질 때**입니다. 말을 마치고 Stop을 누르기까지의
공백이 정확히 그 조건이라 일상적으로 반복됩니다.

**옵션별 결과** (각 5회 반복, 자세히는 `BENCH.md`): `--suppress-nst`·`--no-fallback`·
`-lpt -0.4`·`-et 1.8` 모두 효과 없음. **`--vad`만이 환각을 제거하고 발화를 온전히
보존**하며, 기본 임계값(0.5)으로 충분합니다.

**제안.** silero VAD 모델(0.9MB)을 bootstrap에서 함께 받고 `--vad` 적용. 임계값 튜닝은
필요 없었습니다. `cases/tail_over_boundary.wav`가 그대로 회귀 테스트가 됩니다.

---

## M2 · 문서가 macOS에서 일어나지 않는 동작을 약속한다

`docs` `macos`

```
README.md:100-107  "downloads a prebuilt whisper.cpp CLI …"     → macOS는 받지 않음
README.md:106-107  "the downloaded whisper binary is unsigned,
                    so Gatekeeper may prompt"                    → 받는 바이너리 없음
                                                                   brew 안내는 부재
SKILL.md:189-191   "recommends a cloud speech provider you
                    supply a key for (configured in the popup)"  → BYOK 미구현(503)
hooks/ensure-model.sh:26  "or pick BYOK cloud STT in the popup"  → 동일
docs/architecture.md:24   "3 runtime deps"                       → 런타임 의존성 0개
```

**제안.** Requirements에 macOS = Node + `brew install whisper-cpp` 추가, Gatekeeper
문단은 삭제하거나 Linux/Windows 한정으로 이동, BYOK 언급은 "예정"으로 하향,
architecture.md 의존성 개수 수정.

---

## M3 · `STP_PORT` 고정 포트 승계 로직이 macOS에서 무동작

`bug` `macos` `launcher`

**재현.** 고정 포트로 헬퍼를 띄운 뒤 같은 `STP_PORT`로 `launch.sh` 실행.

**관측.** 약 16초 대기 후 `STP_LAUNCH_ERROR`, 이전 헬퍼는 그대로 생존, 새 헬퍼는
`EADDRINUSE`로 종료. `launch.sh:27-38`이 `fuser "<port>/tcp"`와 `/proc/<pid>/cmdline`에
의존하는데 macOS의 BSD `fuser`는 그 문법을 받지 않고 `/proc`도 없습니다.

**제안.** 리눅스 경로는 유지하고 darwin에서는 `lsof -ti tcp:$STP_PORT`로 PID를 찾은 뒤
`ps -o command= -p <pid>` 출력에서 `helper/dist/index.js`를 확인하고 종료 — 지금
리눅스 경로가 cmdline으로 하는 확인과 같은 수준.

---

## M4 · 녹음 전에 Confirm을 누르면 팝업의 샘플 XML이 확정 프롬프트로 나간다

`bug` `popup`

**증상.** `index.html:38-99`의 샘플(Google OAuth 예시)은 첫 Record에서 비워지지만,
팝업이 열린 직후·전사 중·드래프팅 중에는 그대로 남고 Confirm도 활성입니다. 이 상태의
Confirm은 사용자가 말한 적 없는 XML을 확정 프롬프트로 전달합니다. Q1 칩에
`class="chip sel"`·`aria-pressed="true"`가 하드코딩돼 있어 **답변까지 조작된 채로**
나갑니다.

**관측.** 갓 연 팝업에서 Confirm만 눌렀을 때
`{"status":"confirmed","xml":"…Add Google OAuth…","answers":[{"choice":"Implement it"}]}`.
이 XML은 불변식을 통과하므로 `inject.js`도 정상 출력합니다.

**제안.** 부팅 시 샘플을 비우거나, 실제 라운드 도착 전까지 Confirm을 `disabled`로.
샘플 칩의 선택 상태도 제거.

---

## M5 · 팝업이 열리는 순간 마이크를 열고 계속 점유한다

`bug` `privacy` `popup`

`record.js:65-69`의 `prewarm()`이 페이지 로드 시 `getUserMedia`로 스트림을 얻고
`stop()` 전까지 놓지 않습니다. 이미 권한이 있는 브라우저에서는 Record를 누르지 않아도
마이크가 열리고, macOS에서는 주황색 표시등이 팝업을 여는 즉시 켜져 탭을 닫을 때까지
유지됩니다(Safari에서 확인).

**제안.** prewarm 후 일정 시간 내 Record가 없으면 트랙을 `stop()`하고 첫 클릭에 다시 열기,
또는 옵션화. 최소한 README의 Permissions 절에 명시.

---

## M6 · 스레드 추천이 SMT를 가정한다 (Apple Silicon에는 없음)

`polish` `macos`

`bootstrap.ts:203-211`이 논리코어를 반으로 나눠 물리코어를 추정하는데 M4는
`hw.physicalcpu == hw.logicalcpu == 10`이라 `-t 5`가 나옵니다. 실측 성능 손해는
없었습니다(base 6.3초 클립에서 `-t 4/5/8/10` 모두 0.60초 — Metal이 일하므로 스레드
민감도가 낮음). 정확성 차원의 정리.

---

## M7 · 전사가 끝나도 STT 진행바가 100%인 채로 남는다

`polish` `popup` — SSE `transcript` 수신 시 `#stt-progress`가 숨겨지지 않음
(`app.js:134-141`).

## M8 · 드래프팅 중인데 상태 표시는 `transcribing… 100%`

`polish` `popup` — SSE 경로에서 stage 문자열이 갱신되지 않음. 커서로 Stop을 누른
경로(`app.js:454`)에서는 정상.

## M9 · Enhance / Grill 스위치의 접근성 이름이 툴팁 문장

`polish` `a11y` — Safari 접근성 트리에서 `Off = only your words, structured · …`로
읽힙니다. `<label title>`이 접근 이름을 덮어쓰는 케이스로, input에 `aria-label`을 주면
해결(`index.html:110-117`).

## M10 · 모델 다운로드 진행 이벤트에 스로틀이 없다

`polish` `perf` — HTTP 청크마다 SSE 브로드캐스트. base(141MB) 한 번에 진행 라인이 약
8천 건, turbo(834MB)는 그 6배. 200ms 또는 1% 단위로 묶으면 충분
(`bootstrap.ts:324-327`, `index.ts:18-23`).

## M11 · 망가진 draft.json의 오류가 원인을 알려주지 않는다

`polish` `dx` — 세그먼트에 `text`가 없으면
`grill: Cannot read properties of undefined (reading 'replace')`만 나옵니다. 이 JSON은
LLM 서브에이전트가 쓰는 파일이라 형태가 어긋날 여지가 실제로 있습니다. 어느 섹션·어느
세그먼트인지 짚어주는 검증 한 겹 필요(`xml.ts:305-307`).

## M12 · `run_dir` 경로에 슬래시가 겹친다

`polish` — macOS의 `$TMPDIR`이 슬래시로 끝나 `…/T//stp-voice.XXXX`가 출력됩니다
(`launch.sh:21`).

## M16 · 영어 기술 용어가 한글 음차로 뭉개진다

`polish` `stt` — "fuser"를 또렷이 발음해도 `퓨저`·`맥퓨저`로 나옵니다. M17과 같은
뿌리입니다. `--prompt`에 저장소 식별자를 주면 `슬래시 프록` → `/proc`이 정확히
복원됩니다(`BENCH.md` 3절). M17 조치에 함께 딸려 옵니다.

---

## 검증하지 못한 영역

이슈로 올리기 전에 누군가 확인해야 하는 빈칸입니다.

- **`/stp:voice` 슬래시 커맨드 경로 전체** — 플러그인 설치 → hooks 등록 →
  prompt-expansion 시점의 `launch.sh` 실행 → `allowed-tools` 게이트. 이번 QA는 헬퍼를
  직접 띄워 대체했으므로 이 경로는 통째로 미검증입니다.
- **진짜 clean Mac** — TCC 권한 프롬프트, `~/.stp` 최초 생성 포함. 이번에는 PATH
  시뮬레이션으로 대체했습니다.
- **Chrome 실제 마이크 캡처** — Safari만 실측(보안 컨텍스트·MediaRecorder 지원은 Chrome도 확인).
- **Intel Mac (darwin x64)** — `heuristicTier`가 Apple Silicon 분기를 타지 않는 경로.
- **Node 18** — CI 매트릭스에는 있으나 로컬은 22만.
- **장문·영어 발화·다른 저장소에서의 그라운딩** — 실사용은 한국어 61초 1회뿐입니다.
