# qa-macos — macOS QA 산출물

2026-08-12 macOS 검증에서 나온 재현 자산입니다. 발견 17건 중 전사 관련 3건
(M14 · M16 · M17)은 여기 있는 오디오로 언제든 다시 확인할 수 있습니다.

**커밋 여부는 판단이 필요합니다.** 저장소가 지금까지 바이너리를 두지 않았습니다.
회귀 테스트로 쓸 생각이면 두는 편이 낫고, 그렇지 않다면 이슈에 첨부하고 여기서 지워도
됩니다. 커밋 대상은 `fixtures/` 1.3MB + 문서뿐입니다 — 파생 케이스(`cases/`, 3.7MB)와
받아오는 VAD 모델은 `.gitignore` 처리돼 있고 `build-cases.py`로 언제든 복원됩니다.

## 구성

```
human/             사람 음성 1개 — 아래 "사람 음성" 절 참조
fixtures/          합성 음성 7개 (macOS `say`, 16 kHz mono 16-bit — 사람 녹음 아님)
  ko_one.wav         한국어 1문장
  ko_pure.wav        한국어 2문장 — 영어 단어 없음 (언어 기본값 실험용)
  ko_multi.wav       한국어 3문장
  ko_with_terms.wav  한국어 문장 + 영어 기술 용어 (fuser, /proc)
  en_sentence.wav    영어 1문장 (6.3초)
  en_phrase.wav      영어 짧은 구 (1.6초)
  en_word.wav        영어 단어 1개 (0.5초)

build-cases.py     위 7개로 파생 케이스 8개 생성 (cases/) — 결정적, `say` 불필요
run-bench.sh       전체 실험 실행 + 각 줄 아래에 이번에 관측된 값
BENCH.md           측정 결과와 결론 — 무엇이 통하고 무엇이 안 통했는지
ISSUES.md          이슈 초안 17건 + 검증하지 못한 영역
```

`fixtures/`의 7개만 음성 파일이고 나머지는 전부 `build-cases.py`가 조립합니다. 그래서
`say`가 없는 Windows/Linux에서도 whisper-cli만 있으면 동일한 케이스로 재현됩니다.

**`fixtures/`는 전부 TTS입니다.** 사람이 말한 것이 아니고, 언어 혼합 케이스는 한국어
클립과 영어 클립을 무음으로 이어 붙인 것이라 실제 코드 스위칭과 다릅니다. 그래서 사람
음성을 하나 따로 두었습니다.

## 사람 음성 — `human/take3-38s.wav`

한국어 문장 사이에 영어 식별자를 섞어 말한 38초입니다. `STP_KEEP_AUDIO=1` 로 헬퍼가
남긴 캡처를 그대로 옮겼습니다.

말한 내용(전부 이 저장소 이야기):

> 어, 맥에서는 fuser가 안 돼서 lsof로 바꿔야 되는데, 음… lsof -ti tcp 이렇게 포트로
> 찾고, 그다음에 그 프로세스 command line 확인해서 우리 helper 맞으면 kill 하는
> 식으로. 아 그리고 /proc은 맥에 없으니까 ps로 봐야 돼. 지금은 그냥 EADDRINUSE 나면서
> 죽고, launch.sh가 STP_PORT 고정일 때만 그래. 그 부분 좀 봐줘.

이 파일 하나로 확인되는 것 (`BENCH.md` 4절):

- 식별자 11개 중 기본 설정에서 온전한 것은 3개뿐
- `launch.sh` → `f.sh` — 철자로 읽은 것도 안전하지 않음
- `--prompt` 로 `/proc` 과 `command line` 은 복원되지만, `launch.sh` 는 `lsof.sh` 로
  바뀜 (프롬프트 어휘가 엉뚱한 자리에 끼어드는 부작용)
- 꼬리 정적이 1.5초뿐이라 환각 조건은 성립하지 않음 (RMS 분석)

```bash
whisper-cli -m <turbo-model> -f human/take3-38s.wav -l auto -nt -t 5
whisper-cli -m <turbo-model> -f human/take3-38s.wav -l auto -nt -t 5 \
  --prompt "fuser, lsof, /proc, ps, kill, whisper-cli, STP_PORT, launch.sh, EADDRINUSE, helper, command line, tcp"
```

## 실행

```bash
python3 build-cases.py

WHISPER_MODEL=~/.stp/models/ggml-large-v3-turbo-q8_0.bin \
VAD_MODEL=~/.stp/models/ggml-silero-v5.1.2.bin \
  ./run-bench.sh
```

- `WHISPER_MODEL` — turbo 티어여야 이번 결과와 같은 조건입니다(맥 기본 티어).
- `VAD_MODEL` — 선택. 없으면 VAD 절만 건너뜁니다. 0.9MB:
  <https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin>
- macOS에 whisper-cli가 없으면 `brew install whisper-cpp` (M1 참조).

각 결과 줄 아래에 이번에 관측된 값이 주석으로 붙어 있어, 다른 기기에서 돌렸을 때
차이가 바로 보입니다.

## 이번 실행 환경

macOS 26.3.1 (25D771280a) · Apple M4 10코어 · Node 22.23.1 · npm 10.9.8 ·
whisper-cpp 1.8.3 (Metal, MTLGPUFamilyApple9) · `ggml-large-v3-turbo-q8_0` ·
저장소 커밋 `a1fbe57`.
