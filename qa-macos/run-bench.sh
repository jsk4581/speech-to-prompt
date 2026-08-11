#!/usr/bin/env bash
# STT bench for the transcription findings (M14 · M16 · M17).
#
# Runs whisper-cli over the built cases with the exact arguments the helper uses
# (audio.ts: -m -f -l auto -nt [-t N]) and then with each candidate mitigation,
# so the difference is attributable. Prints what was observed on macOS 26.3.1 /
# M4 / whisper-cpp 1.8.3 / ggml-large-v3-turbo-q8_0 next to each result.
#
#   WHISPER_MODEL=~/.stp/models/ggml-large-v3-turbo-q8_0.bin ./run-bench.sh
#
# Needs: whisper-cli on PATH (macOS: brew install whisper-cpp) and a turbo model.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CASES="$HERE/cases"
MODEL="${WHISPER_MODEL:-}"
THREADS="${THREADS:-5}"

# The repo identifiers STP would have on hand — it already reads the repository,
# so this is material it can supply for free.
PROMPT="fuser, lsof, /proc, whisper-cli, STP_PORT, launch.sh, EADDRINUSE, retry, exponential backoff, upload handler, unit test"

if ! command -v whisper-cli >/dev/null 2>&1; then
  echo "whisper-cli not on PATH — macOS: brew install whisper-cpp" >&2
  exit 1
fi
if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
  echo "set WHISPER_MODEL to a ggml model file (turbo tier for a like-for-like run)" >&2
  exit 1
fi
if [ ! -d "$CASES" ]; then
  echo "cases/ missing — run: python3 \"$HERE/build-cases.py\"" >&2
  exit 1
fi

run() { # run <case> [extra args…]
  local c="$1"; shift
  whisper-cli -m "$MODEL" -f "$CASES/$c.wav" -l auto -nt -t "$THREADS" "$@" 2>/dev/null \
    | tr -d '\n' | sed 's/^ *//'
  echo
}

rule() { printf '\n── %s ─────────────────────────────────\n' "$1"; }

rule "M17 · 한국어 옆의 영어가 얼마나 살아남는가 (헬퍼 기본 인자)"
printf '%-22s ' "ctl_ko_ko";           run ctl_ko_ko
echo   '   기대: 두 한국어 문장 모두 전사 — 클립을 이어 붙인 것 자체는 문제가 아님'
printf '%-22s ' "mix_word (0.5s)";     run mix_word
echo   '   관측: 영어 단어는 살아남음 ("Fuser")'
printf '%-22s ' "mix_phrase (1.6s)";   run mix_phrase
echo   '   관측: 영어 구간 소실'
printf '%-22s ' "mix_sentence (6.3s)"; run mix_sentence
echo   '   관측: 영어 구간 소실'
printf '%-22s ' "mix_reversed";        run mix_reversed
echo   '   관측: 순서를 바꿔도 영어가 소실'

rule "M17 완화 · 저장소 식별자를 초기 프롬프트로 주입"
printf '%-22s ' "mix_phrase +prompt";    run mix_phrase --prompt "$PROMPT"
printf '%-22s ' "mix_sentence +prompt";  run mix_sentence --prompt "$PROMPT"
echo   '   관측: 소실됐던 영어 구간이 되살아남. 대신 한국어 일부가 영어 표기로 바뀜'

rule "M16 · 영어 기술 용어의 한글 음차"
printf '%-22s ' "ko_with_terms";         whisper-cli -m "$MODEL" -f "$HERE/fixtures/ko_with_terms.wav" -l auto -nt -t "$THREADS" 2>/dev/null | tr -d '\n' | sed 's/^ *//'; echo
echo   '   관측: "맥퓨저 … 슬래시 프록도 없고"'
printf '%-22s ' "  +prompt";             whisper-cli -m "$MODEL" -f "$HERE/fixtures/ko_with_terms.wav" -l auto -nt -t "$THREADS" --prompt "$PROMPT" 2>/dev/null | tr -d '\n' | sed 's/^ *//'; echo
echo   '   관측: "… /proc도 없고"  ← 경로는 정확히 복원. 용어 자체(퓨저)는 프롬프트 구성에 따라 갈림'

rule "M14 · 발화 끝 잡음 꼬리에서의 환각 · 어떤 옵션이 듣는가"
printf '%-22s ' "tail_control";          run tail_control
echo   '   기대: 깨끗하게 끝남 (환각 없음)'
printf '%-22s ' "tail_over_boundary";    run tail_over_boundary
echo   '   관측: 끝에 "감사합니다." 가 생성됨  ← 이것이 재현 대상'
printf '%-22s ' "  +suppress-nst";       run tail_over_boundary --suppress-nst
echo   '   관측: 효과 없음 — 환각이 그대로 남음'
printf '%-22s ' "  +no-fallback";        run tail_over_boundary --no-fallback
echo   '   관측: 효과 없음'
printf '%-22s ' "  -lpt -0.4";           run tail_over_boundary -lpt -0.4
echo   '   관측: 효과 없음 (5회 반복 동일)'
printf '%-22s ' "  -et 1.8";             run tail_over_boundary -et 1.8
echo   '   관측: 효과 없음 — 디코더 임계값 조정으로는 잡히지 않음'
printf '%-22s ' "tail_digital_silence";  run tail_digital_silence
echo   '   기대: 완전한 0 무음으로는 재현되지 않음 — 트리거는 실제 노이즈 플로어'

rule "M14 해법 · VAD (silero 0.9MB)"
if [ -n "${VAD_MODEL:-}" ] && [ -f "${VAD_MODEL:-}" ]; then
  printf '%-22s ' "  --vad (기본 0.5)";   run tail_over_boundary --vad --vad-model "$VAD_MODEL"
  echo '   관측: 환각이 사라지고 발화는 그대로 — 기본 임계값으로 충분 (5회 반복 동일)'
  printf '%-22s ' "  --vad -vt 0.3";      run tail_over_boundary --vad --vad-model "$VAD_MODEL" -vt 0.3
  echo '   관측: 동일. 임계값을 낮춰도 발화 손실 없음'
  printf '%-22s ' "  --vad on en_sentence"
  whisper-cli -m "$MODEL" -f "$HERE/fixtures/en_sentence.wav" -l auto -nt -t "$THREADS" --vad --vad-model "$VAD_MODEL" 2>/dev/null | tr -d '\n' | sed 's/^ *//'; echo
  echo '   기대: 정상 발화는 기본 임계값에서도 온전히 전사됨'
  printf '%-22s ' "  --vad on mix_phrase"; run mix_phrase --vad --vad-model "$VAD_MODEL"
  echo '   관측: VAD는 M17(언어 혼합 소실)에는 듣지 않음 — 언어 선택은 디코딩 단계의 문제'
else
  echo "  VAD_MODEL 미설정 — 건너뜀. 받는 곳:"
  echo "  https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
fi

rule "언어 기본값 후보 · 순수 한국어를 -l en 으로 강제하면"
for l in ko auto en; do
  printf '%-22s ' "ko_pure  -l $l"
  whisper-cli -m "$MODEL" -f "$HERE/fixtures/ko_pure.wav" -l "$l" -nt -t "$THREADS" 2>/dev/null | tr -d '\n' | sed 's/^ *//'
  echo
done
echo '   원문: 이번 주에 로그인 화면을 다시 만들고, 실패했을 때 안내 문구도 같이 손봐 주세요. 급한 건 아니니까 천천히 해도 됩니다.'
echo '   관측: -l en 은 한국어를 통째로 버리고 무관한 영어 문장을 반복 생성 → 기본값 후보에서 탈락'
