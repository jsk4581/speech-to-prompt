#!/usr/bin/env python3
"""Build the derived STT test cases from the source fixtures.

Every case is deterministic: same inputs, same bytes out. Only the seven WAVs in
fixtures/ are real recordings (macOS `say`, 16 kHz mono 16-bit) — everything the
bench measures is assembled here, so a machine without `say` can still reproduce
the whole suite.

    python3 build-cases.py            # writes cases/*.wav
"""

import os
import random
import struct
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
OUT = os.path.join(HERE, "cases")

RATE = 16000


def read(name):
    with wave.open(os.path.join(FIX, name), "rb") as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1 and w.getsampwidth() == 2, name
        return w.readframes(w.getnframes())


def write(name, data):
    os.makedirs(OUT, exist_ok=True)
    with wave.open(os.path.join(OUT, name + ".wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data)
    print(f"  {name}.wav  {len(data) / (RATE * 2):5.1f}s")


def silence(seconds):
    return b"\x00" * int(RATE * 2 * seconds)


def noise(seconds, amplitude=40, seed=11):
    """Low-level noise standing in for a microphone's floor. Digital silence does
    not trigger the tail hallucination; this does."""
    rnd = random.Random(seed)
    return b"".join(
        struct.pack("<h", rnd.randint(-amplitude, amplitude))
        for _ in range(int(RATE * seconds))
    )


def main():
    ko_one = read("ko_one.wav")
    ko_pure = read("ko_pure.wav")
    ko_multi = read("ko_multi.wav")
    en_sentence = read("en_sentence.wav")
    en_phrase = read("en_phrase.wav")
    en_word = read("en_word.wav")
    gap = silence(1)

    print("language mix (M17) — how much English survives beside Korean:")
    write("mix_word", ko_one + gap + en_word)          # 0.5s of English
    write("mix_phrase", ko_one + gap + en_phrase)      # 1.6s
    write("mix_sentence", ko_one + gap + en_sentence)  # 6.3s
    write("mix_reversed", en_sentence + gap + ko_one)  # English first
    write("ctl_ko_ko", ko_one + gap + ko_pure)         # control: one language, two clips

    print("tail hallucination (M14) — a nearly empty final window:")
    speech = ko_multi + ko_one + en_sentence
    pad = max(0.5, 30.8 - len(speech) / (RATE * 2))
    write("tail_over_boundary", speech + noise(pad))   # crosses the 30s window edge
    write("tail_control", speech)                      # same speech, no tail
    write("tail_digital_silence", ko_one + silence(6)) # zeros do NOT trigger it


if __name__ == "__main__":
    main()
