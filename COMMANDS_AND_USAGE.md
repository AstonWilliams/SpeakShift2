# qwen3tts-cli Commands and Usage

This guide covers build commands, runtime usage, CUDA setup, and model capabilities.

## 1) Project Scope

This CLI is built for:

- Qwen3-TTS Base model voice cloning from reference audio
- CPU and CUDA execution paths
- WAV output generation

Tested local model path:

- `..\Qwen3-TTS-12Hz-0.6B-Base`

## 2) Build Commands

### CPU build (works in current shell)

```powershell
cargo build --release --features "audio-loading"
```

### CUDA build (requires MSVC toolchain in PATH)

```powershell
cargo build --release --features "audio-loading,cuda,cudnn,flash-attn"
```

If build fails with `Cannot find compiler 'cl.exe' in PATH`:

1. Install Visual Studio Build Tools with C++ workload (Desktop development with C++).
2. Open `x64 Native Tools Command Prompt for VS`.
3. Re-run the CUDA build command from that shell.

## 3) Run Commands

### Voice cloning with reference transcript (best quality)

```powershell
cargo run --release --features "audio-loading" -- \
  --model-dir ..\Qwen3-TTS-12Hz-0.6B-Base \
  --text "Human rights are the foundation of a just society. Every person deserves dignity, equality before the law, and the freedom to speak, learn, and live without fear." \
  --ref-audio ..\karoline.mp3 \
  --ref-text "Reference transcript for better style transfer." \
  --language english \
  --output ..\human_rights_karoline.wav \
  --device cpu \
  --dtype f32
```

### CUDA runtime (after successful CUDA build)

```powershell
cargo run --release --features "audio-loading,cuda,cudnn,flash-attn" -- \
  --model-dir ..\Qwen3-TTS-12Hz-0.6B-Base \
  --text "Human rights belong to every person, everywhere." \
  --ref-audio ..\karoline.mp3 \
  --ref-text "Reference transcript for ICL mode." \
  --language english \
  --output ..\human_rights_karoline_cuda.wav \
  --device cuda \
  --dtype bf16 \
  --flash-attn
```

### Fast x-vector-only clone (no ref-text)

```powershell
cargo run --release --features "audio-loading" -- \
  --model-dir ..\Qwen3-TTS-12Hz-0.6B-Base \
  --text "This is a faster clone path using x-vector only mode." \
  --ref-audio ..\karoline.mp3 \
  --x-vector-only \
  --language english \
  --output ..\karoline_fast.wav \
  --device cpu \
  --dtype f32
```

### Save reusable voice prompt (first run)

```powershell
cargo run --release --features "audio-loading,cuda" -- \
  --model-dir ..\Qwen3-TTS-12Hz-0.6B-Base \
  --text "This run creates and saves a reusable voice prompt." \
  --ref-audio ..\karoline.mp3 \
  --ref-text "Reference transcript for ICL mode." \
  --save-prompt ..\karoline_prompt.safetensors \
  --output ..\karoline_first.wav \
  --device cuda \
  --dtype bf16
```

### Reuse saved prompt (no source audio needed)

```powershell
cargo run --release --features "audio-loading,cuda" -- \
  --model-dir ..\Qwen3-TTS-12Hz-0.6B-Base \
  --text "This uses the saved prompt, so no reference audio is required." \
  --load-prompt ..\karoline_prompt.safetensors \
  --language english \
  --output ..\karoline_reuse.wav \
  --device cuda \
  --dtype bf16
```

### Deterministic generation (greedy)

```powershell
cargo run --release --features "audio-loading" -- \
  --model-dir ..\Qwen3-TTS-12Hz-0.6B-Base \
  --text "Equal rights and human dignity must be protected." \
  --ref-audio ..\karoline.mp3 \
  --language english \
  --greedy \
  --output ..\karoline_greedy.wav \
  --device cpu \
  --dtype f32
```

## 4) CLI Options Summary

Required:

- `--model-dir <PATH>`
- `--text <TEXT>`
- `--ref-audio <PATH>`

Common optional:

- `--ref-text <TEXT>`
- `--language <LANG>` (default `english`)
- `--output <PATH>` (default `output_cloned.wav`)
- `--save-prompt <PATH>`
- `--load-prompt <PATH>`
- `--device <cpu|cuda>`
- `--dtype <f32|f16|bf16>`
- `--x-vector-only`
- `--max-tokens <N>` (default `2048`)
- `--temperature <F64>`
- `--top-k <N>`
- `--top-p <F64>`
- `--greedy`
- `--flash-attn`

## 5) Model Capabilities

General qwen_tts crate capabilities:

- VoiceClone mode (Base model)
- CustomVoice preset speakers (CustomVoice model variants)
- VoiceDesign from natural-language description (VoiceDesign model variants)
- Prompt creation/save/load for clone reuse
- Batch and tokenizer utilities in upstream ecosystem
- CPU/CUDA/cuDNN/FlashAttention acceleration paths

Capabilities for `Qwen3-TTS-12Hz-0.6B-Base` specifically:

- Voice cloning from reference audio: Yes
- Preset speaker voices: No (requires CustomVoice model)
- Voice design prompts: No (requires VoiceDesign model)
- Reference transcript conditioning: Yes (`--ref-text`)
- Streaming output: not primary path; generation is effectively non-streaming full output

## 6) Troubleshooting

### `unexpected argument 'Leavitt.mp3' found`

Cause: path with spaces not quoted correctly.

Fix options:

- Use quoted path: `--ref-audio "..\Karoline Leavitt.mp3"`
- Or rename/copy to no-space filename, e.g. `karoline.mp3`

### CUDA build fails with `cl.exe` missing

Use Visual Studio Native Tools shell and ensure C++ build tools are installed.

### Very short or empty audio output

Try:

- longer text
- provide `--ref-text`
- increase `--max-tokens`
- avoid overly aggressive greedy settings for some prompts
