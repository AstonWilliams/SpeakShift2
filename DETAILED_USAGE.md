# qwen3tts-cli Detailed Usage Guide

This guide explains how to build, run, and reuse voice profiles with qwen3tts-cli.

## 1. Project Paths

- CLI project folder: F:\qwen3tts\qwen3tts-cli
- Model folder: F:\qwen3tts\Qwen3-TTS-12Hz-0.6B-Base
- Example reference audio: F:\qwen3tts\karoline.mp3

## 2. Build

### 2.1 Recommended CUDA build (stable, low RAM)

Run from the CLI folder:

    build_cuda_safe.bat

What this does:

- Initializes Visual Studio C++ toolchain
- Limits build parallelism to reduce RAM pressure
- Builds with CUDA enabled (without flash-attn and cuDNN dependency)

### 2.2 CPU-only build

    cargo build --release --features "audio-loading"

### 2.3 Direct CUDA build

    cargo build --release --features "audio-loading,cuda"

## 3. Basic Voice Clone Run

Generate speech from text using reference audio:

    target\release\qwen3tts-cli.exe --model-dir ..\Qwen3-TTS-12Hz-0.6B-Base --text "Human rights belong to every person, everywhere." --ref-audio ..\karoline.mp3 --ref-text "Reference transcript for ICL mode." --language english --output ..\human_rights.wav --device cuda --dtype bf16

## 4. Save and Reuse Voice Profile

### 4.1 First run: save profile

    target\release\qwen3tts-cli.exe --model-dir ..\Qwen3-TTS-12Hz-0.6B-Base --text "This run saves a reusable voice profile." --ref-audio ..\karoline.mp3 --ref-text "Reference transcript for ICL mode." --save-prompt ..\karoline_prompt.safetensors --output ..\karoline_first.wav --device cuda --dtype bf16

### 4.2 Later run: load profile (no source audio required)

    target\release\qwen3tts-cli.exe --model-dir ..\Qwen3-TTS-12Hz-0.6B-Base --text "This run uses the saved profile only." --load-prompt ..\karoline_prompt.safetensors --language english --output ..\karoline_reuse.wav --device cuda --dtype bf16

## 5. Arguments

### Required for standard clone flow

- --model-dir
- --text
- --ref-audio (unless --load-prompt is used)

### Reusable profile flow

- --save-prompt <path>: saves voice profile file
- --load-prompt <path>: loads existing voice profile and skips reference audio

### Generation and runtime

- --language english (default)
- --output <path>
- --device cpu|cuda
- --dtype f32|f16|bf16
- --x-vector-only
- --max-tokens <number>
- --temperature <value>
- --top-k <value>
- --top-p <value>
- --greedy
- --flash-attn

## 6. Text Length and Limits

Text length is constrained by generated audio token budget, not character count.

Approximate duration:

- duration_seconds ~= max_tokens / 12

Examples:

- 2048 tokens ~= 170 seconds (~2.8 min)
- 8192 tokens ~= 682 seconds (~11.4 min)

Your model generation config contains max_new_tokens 8192, but CLI default max-tokens is 2048 unless overridden.

## 7. Output Files

- Main speech output is always WAV at --output path
- Profile output is .safetensors when --save-prompt is used

Typical reusable assets:

- karoline_prompt.safetensors
- karoline_reuse.wav

## 8. Troubleshooting

### 8.1 cl.exe not found

Use build_cuda_safe.bat or run inside Visual Studio Developer Command Prompt.

### 8.2 cudnn.lib not found

Build with audio-loading,cuda only unless cuDNN is installed and configured.

### 8.3 Path with spaces breaks command

Quote paths or use files without spaces (example: karoline.mp3).

### 8.4 High RAM usage/freezing during build

Use build_cuda_safe.bat; it enforces low-memory settings and avoids heavier optional features.

## 9. Verified Working Artifacts (Current Workspace)

- F:\qwen3tts\karoline_prompt.safetensors
- F:\qwen3tts\karoline_save_test.wav
- F:\qwen3tts\karoline_load_test.wav
