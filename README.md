# SpeakShift

Private, local-first desktop studio for media conversion, transcription, diarization, translation, and batch pipelines.

SpeakShift runs as a Tauri desktop app with a Next.js UI and Rust backend. The core processing path is local sidecar tooling (FFmpeg, whisper-cli, NLLB translator, yt-dlp), with local SQLite persistence and offline Pro licensing.

## Product Pitch

Most creator tools force a cloud tradeoff: upload speed limits, recurring usage pricing, and compliance risk.

SpeakShift is designed to remove that tradeoff:

- Keep sensitive media local.
- Run production workflows on-device.
- Export in practical formats for editors, subtitlers, and localization teams.
- Unlock Pro permanently on a machine with signed offline licenses.

## What SpeakShift Does

### Core Capabilities

- Video and audio conversion with FFmpeg controls.
- Local Whisper transcription from file, path, YouTube source, and recordings.
- Speaker diarization workflows with Sortformer/Parakeet models.
- NLLB-based translation for transcription text.
- Batch transcription with queue orchestration and runtime memory analysis.
- Multi-format export across subtitles, text, structured data, and documents.

### Local-First by Design

- Media processing is executed locally via sidecars.
- Data is stored in local SQLite.
- Pro activation supports offline key verification.

Network is still required for:

- Downloading AI models.
- Processing remote links (for example YouTube/Drive inputs in batch workflows).

## Free vs Pro

The app enforces access in both frontend routing and backend command guards.

| Area | Free | Pro |
|---|---|---|
| Home, Convert, Transcribe, Transcriptions, Settings, Profile | Yes | Yes |
| Batch transcription | Locked | Yes |
| Diarization workflows | Locked | Yes |
| Translation workflows | Locked | Yes |

## UI and Feature Walkthrough

### Home (/)

- Product entry point and onboarding cards.
- Quick navigation to Convert and Transcribe.
- Privacy-first positioning and local-processing messaging.

### Convert (/convert)

Input:

- Video file drop/pick (mp4, mov, mkv, webm, avi, m4v).

Controls:

- Output type: video or audio-only.
- Video output formats: mp4, webm, mov.
- Audio output formats: mp3, wav, aac.
- Quality profiles: low, medium, high.
- Resolution targets: original, 1080p, 720p, 480p.
- Aspect/crop presets: original, 9:16, 1:1, 16:9.
- Visual controls: brightness, contrast, saturation, grayscale/sepia/vignette.
- Audio controls: volume, denoise, dehummer.
- Creative overlays: text/emoji placement, color, and sizing.

Processing:

- Real FFmpeg render pipeline via Rust command `process_ffmpeg`.
- Optional compatibility preview generation (`create_video_preview`).

### Transcribe (/transcribe)

Input:

- File picker, browser drop, or native path drag-drop.
- Supported UI extensions include audio and video formats such as mp3, wav, m4a, ogg, flac, aac, opus, wma, aif/aiff, mp4, mkv, webm, mov, avi, m4v, wmv, mpeg/mpg, 3gp.

Controls:

- Whisper model selection (tiny -> large-v3-turbo).
- Language auto-detect or explicit code.

Runtime behavior:

- Size guards in UI and transcriber component (up to 8 GB hard guard in current frontend checks).
- Backend RAM-aware safety checks before transcription.
- Progress events from backend to UI.

Exports from transcribe workspace:

- srt, vtt, txt, json, csv, md.

### Transcriptions (/transcriptions)

- Library of saved transcription records.
- Search, sort, source filtering, inline rename, delete.
- Create from:
   - File transcription workflow.
   - YouTube URL transcription workflow.
   - Live recording workflow.

### Transcription Detail (/transcriptions/detail/[id])

- Waveform playback, scrubbing, timeline sync.
- Full-text copy, search/highlight.
- Speaker rename and speaker-turn persistence.
- Create diarization entries from existing transcript/audio.
- Export formats:
   - json, srt, vtt, txt, csv, tsv, md, pdf, docx.

### Diarization List (/diarization)

- Shows entries with existing diarization timestamps.
- Search, sort, rename, delete.

### Diarization Detail (/diarization/detail?id=...)

- Waveform + speaker timeline.
- Auto-run pipeline support (`run=true`) with model selection.
- Speaker filter and global rename.
- Export formats:
   - json, srt, vtt, txt, pdf.

### Translations List (/translations)

- Lists transcriptions with translation records.
- Shows target language set per transcription.
- Rename and navigation to detail view.

### Translation Detail (/translations/detail?id=...)

- Source/target language selection using NLLB language keys.
- Chunked translation execution via backend `translate_text`.
- Edit and save translated text.
- Export options shown in UI:
   - txt, vtt, srt, csv, json.

### Batch (/batch)

Source types:

- zip
- folder
- drive-link (remote URL bucket, including social/download links)

Queue system:

- Queue creation from drops, pickers, or pasted links.
- Queue ordering, naming, per-queue or global config.
- Process modes: single or sequential queue groups.
- Runtime analyzer for RAM/CPU recommendations.
- Configurable parallelism and item limits.

Batch exports:

- srt, vtt, json, pdf, docx, txt.

### Settings (/settings)

- Theme and locale controls.
- Whisper model download/delete.
- Diarization model download/select/delete.
- NLLB variant download/select/delete.
- Qwen model status/download/delete controls.
- Parakeet TDT model status/download/load/delete controls.
- Entitlement visibility (free vs pro).

### Profile (/profile)

- Local account/license status view.
- Offline Pro activation form (name, email, signed key).
- Pro purchase/activation links.

### Dubbings (/dubbings)

- Current UI is archived placeholder.
- Detail route is also archived placeholder.

## Supported Formats

### Convert Input

- mp4, mov, mkv, webm, avi, m4v.

### Convert Output

- Video: mp4, webm, mov.
- Audio: mp3, wav, aac.

### Transcribe Input (UI)

- Audio/video extensions listed in Transcribe page and transcriber component (broad set including common AAC/OPUS/WMV/MPEG families).

### Batch Input Discovery

- Media file discovery in backend currently accepts:
   - mp3, wav, m4a, ogg, flac, mp4, mkv, webm, mov.

### Subtitle/Text Exports Across Pages

- srt, vtt, txt, json are broadly available.
- Additional exports vary by page (csv/tsv/md/pdf/docx as implemented in detail and batch flows).

## Architecture and Tech Stack

| Layer | Stack |
|---|---|
| Desktop shell | Tauri v2 (Rust) |
| Frontend | Next.js App Router, React, TypeScript, Tailwind |
| UI tooling | Radix UI primitives, Framer Motion, Lucide |
| Audio waveform | wavesurfer.js |
| Data | SQLite via tauri-plugin-sql |
| Media processing | FFmpeg sidecar |
| ASR | whisper-cli sidecar (whisper.cpp models) |
| Translation | nllb-translation sidecar |
| Remote media fetch | yt-dlp sidecar |
| Diarization | parakeet-rs + Sortformer model paths |
| Document export | jsPDF, docx |
| i18n | next-intl |

## Local Data and State

### Database

- SQLite database path is created under app data directory:
   - `speakShift-transcriptions.db`

Tables include:

- `transcriptions`
- `asr_segments`
- `speaker_turns`
- `translations`

### Cached Artifacts

- Whisper models
- Diarization models
- NLLB model folders
- Temp converted audio and preview outputs

### License State

- Offline activation file stored in user-scoped folder:
   - `~/.speakshift/license/offline_license.json`

## Offline Pro Licensing Security (How It Works)

SpeakShift uses signed offline licenses, verified locally.

### Security Flow

1. Seller generates Ed25519 keypair with the `license-tools` utility.
2. Public key is embedded into app build through `SPEAKSHIFT_LICENSE_PUBLIC_KEY_B64`.
3. Buyer receives an `SS1-...` signed token.
4. App parses and base64-decodes token payload.
5. App verifies Ed25519 signature over payload bytes.
6. App enforces payload checks:
    - `perpetual` must be `true`.
    - `plan` must be `pro`.
    - entered name/email must match payload.
7. Valid license is persisted locally and entitlement becomes Pro.

### Enforcement Layers

- Frontend route lock overlay blocks non-Pro pages.
- Backend commands call entitlement checks (`ensure_feature_unlocked`) for Batch, Diarization, and Translation commands.

### Operational Notes

- If the private key leaks, key rotation requires issuing a new public key and rebuilding app binaries.
- If the build-time public key is left as placeholder, offline activation cannot succeed.

## System Requirements

These are practical recommendations derived from current code paths and model sizes.

### Minimum (Practical)

| Component | Minimum |
|---|---|
| OS | Windows x64, Linux x64, macOS (Apple Silicon target in current CI) |
| CPU | 4 logical cores |
| RAM | 8 GB |
| Storage | 10 GB free (app + models + temp media) |

### Recommended

| Component | Recommended |
|---|---|
| CPU | 8+ logical cores |
| RAM | 16-32 GB (especially for medium/large Whisper and batch parallelism) |
| Storage | SSD with 30+ GB free |
| GPU | Optional but beneficial for CUDA/ROCm/CoreML optimized builds |

### Model Footprint Guidance

- Whisper: tiny/base/small/medium/large variants (from tens of MB to multi-GB).
- NLLB variants in settings include approximate sizes from ~2.2 GB to ~6.5 GB.

## Speed and Performance (1 Hour Audio)

The table below gives practical planning estimates for a 60-minute speech file.

Assumptions:

- Models are already downloaded and warmed.
- Input is typical mono speech (not music-heavy or noisy multi-track).
- No heavy competing workloads on the machine.
- Translation timing is measured from transcript text produced from the same 1-hour audio (roughly 9k-13k words).

### Transcription Time (Whisper)

| Platform Profile | Base Model | Medium Model |
|---|---:|---:|
| RTX workstation (CUDA build) | 4-10 min | 12-30 min |
| macOS Apple Silicon (M-series build) | 10-24 min | 28-65 min |
| Linux x64 (CPU baseline) | 30-75 min | 80-180 min |

### Translation Time (NLLB Variants)

| Platform Profile | nllb_int8_float16 | nllb_float16 | nllb_int8_float32 | nllb_float32 |
|---|---:|---:|---:|---:|
| RTX workstation (CUDA build) | 4-9 min | 6-12 min | 8-16 min | 12-28 min |
| macOS Apple Silicon (M-series build) | 8-18 min | 11-24 min | 14-30 min | 22-45 min |
| Linux x64 (CPU baseline) | 16-35 min | 22-48 min | 30-65 min | 45-95 min |

### Throughput Notes

- `base` is usually the best speed/quality default for fast turnaround.
- `medium` significantly improves difficult speech accuracy but increases runtime and RAM pressure.
- `nllb_int8_float16` is generally the fastest NLLB option for large batches.
- `nllb_float32` is the most expensive in memory and time, and is best reserved for quality-critical localization passes.
- Batch mode can reduce overall wall-clock time when RAM/CPU analyzer recommends safe parallelism.

## Platform Support and macOS Version Notes

### Build Targets in Current Repository

- Windows: `x86_64-pc-windows-msvc` (CUDA and ROCm workflows).
- Linux: `x86_64-unknown-linux-gnu` (CUDA and ROCm workflows).
- macOS: `aarch64-apple-darwin` workflows (`macos-14` runners, CPU/CoreML variants).

### macOS Min/Max Version

- Hardcoded minimum/maximum macOS versions are not explicitly defined in current Tauri JSON config files.
- Current CI evidence validates Apple Silicon builds on `macos-14` runners.
- Practical statement for this repo state:
   - Minimum validated in CI: macOS 14 (Sonoma, Apple Silicon).
   - Maximum: no explicit upper bound configured in repository.

## Known Limitations (Current State)

1. Batch source file discovery currently recognizes a narrower extension set than the Transcribe UI.
2. Batch archive expansion only extracts `.zip` files, even though UI picker lists additional archive extensions.
3. Translation detail UI lists VTT export, but VTT generation is not fully implemented in the current export function.
4. Dubbings pages are archived placeholders in current frontend routes.
5. Feature access is Pro-gated for Batch, Diarization, and Translation.
6. Very large files may still be constrained by RAM and model size despite frontend high-size guards.

## Use Cases

- Podcasters and interview editors needing local transcript + speaker separation.
- Agencies producing subtitles and translated text deliverables.
- Compliance-sensitive teams that cannot upload media to third-party clouds.
- Video teams needing quick conversion + subtitle-ready outputs in one toolchain.
- Researchers processing long recordings with queue-based local batch runs.

## Build and Run

### Prerequisites

- Node.js 20+
- Rust stable toolchain
- Platform build prerequisites for Tauri and sidecar compilation

### Install

```bash
npm ci
```

### Development

```bash
npm run tauri -- dev
```

### Production Build

```bash
npm run tauri -- build
```

Platform-specific workflow YAML files are in `.github/workflows`.

## Repository Components of Interest

- `src/app` - Next.js routes and page-level UI.
- `src/components` - Core processing clients and detail views.
- `src/lib/transcriptionDb.ts` - local SQLite schema and CRUD helpers.
- `src-tauri/src/main.rs` - Tauri commands, sidecar orchestration, licensing guards.
- `license-tools` - offline key generation and license issuing utility.

## Security and Privacy Summary

- Processing is local for core conversion/transcription/diarization/translation tasks.
- Local DB and file-based license state are used instead of remote account dependency.
- Signed offline license verification uses Ed25519 signatures and payload validation.

## License

See repository licensing terms and product distribution terms for current commercial usage policy.

## Support

- Website: https://www.maxinlabs.com
- Profile page includes Pro purchase and activation entry points.

---

SpeakShift: local studio power for private media workflows.