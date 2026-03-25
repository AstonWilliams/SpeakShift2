# SpeakShift

A powerful, privacy-first desktop application for video conversion, audio transcription, and media processing. Built with local AI models and 100% offline capabilities.

## Description

SpeakShift is a comprehensive media processing tool that allows creators to convert videos, transcribe audio, and edit media files entirely on their local machine. Featuring advanced AI-powered features like automatic cropping, speaker diarization, and multilingual support, all while maintaining complete privacy and security.

## Features

- **Video Conversion**: High-speed video processing with smart cropping for social media platforms (TikTok, Instagram)
- **Audio Transcription**: State-of-the-art Whisper AI for accurate speech-to-text conversion
- **Multilingual Support**: Interface and processing support for Chinese, Arabic, German, French, Hindi, Spanish, English, Hebrew
- **Video Editing**: Basic editing capabilities including brightness, contrast, saturation adjustments, audio denoising, and dehumming
- **Speaker Identification**: AI-powered speaker diarization for multi-speaker audio with Parakeet models
- **Speakers Grouping & Filtering**: Group and filter transcription segments by identified speakers
- **SRT Export**: Generate perfectly timed subtitle files for videos
- **Multiple Export Formats**: Export transcriptions as TXT, JSON, VTT, WebVTT, and more
- **YouTube Video Transcription**: Direct transcription support for YouTube videos via URL input
- **Local AI Models**: All processing happens locally using Hugging Face Transformers and Whisper models
- **100% Offline**: Works without internet connection once models are downloaded
- **Native Performance**: Built with Tauri for native desktop performance across platforms
- **Cross-Platform**: Available for Mac, Linux, and Windows
- **Privacy First**: No data ever leaves your machine - 100% secure and local processing
- **Lightning Speed**: High-performance processing using local hardware acceleration

## System Requirements

### Minimum Requirements
- **Operating System**: 
  - Windows 10 or later
  - macOS 10.13 or later (supports macOS 10.3+)
  - Linux: Ubuntu 18.04+, CentOS 7+, or equivalent
- **RAM**: 4GB minimum, 8GB recommended
- **Storage**: 2GB free space for application, additional space for AI models
- **Processor**: Intel Core i3 or equivalent, Apple Silicon supported

### Recommended Requirements
- **Operating System**: Latest versions of Windows, macOS, or Linux
- **RAM**: 16GB or more
- **Storage**: SSD with 10GB+ free space
- **Processor**: Intel Core i5/AMD Ryzen 5 or better, Apple M1/M2 or later

## Installation

### Prerequisites

- Node.js 18 or higher
- Rust 1.70 or higher
- For Windows: Visual Studio Build Tools with C++ build tools
- For Mac: Xcode Command Line Tools
- For Linux: GCC and development libraries (build-essential on Ubuntu/Debian)

### Install Dependencies

```bash
npm install
```

### Development

To run in development mode:

```bash
npm run tauri dev
```

This will start the development server and open the Tauri application.

### Build for Production

To build installers for your current platform:

```bash
npm run tauri build
```

This will create platform-specific installers in `src-tauri/target/release/bundle/`.

## Building from Source for Specific Platforms

### Windows

```bash
npm run tauri build -- --target x86_64-pc-windows-msvc
```

### Mac (Intel)

```bash
npm run tauri build -- --target x86_64-apple-darwin
```

### Mac (Apple Silicon)

```bash
npm run tauri build -- --target aarch64-apple-darwin
```

### Linux

```bash
npm run tauri build -- --target x86_64-unknown-linux-gnu
```

## Usage

1. **Launch the Application**: Open SpeakShift after installation
2. **Choose Your Task**:
   - **Convert**: For video conversion and editing
   - **Transcribe**: For audio/video transcription
3. **Upload Media**:
   - Drag and drop files
   - Click to browse and select files
   - **Paste YouTube URLs**: Direct support for YouTube video transcription (videos are downloaded locally for processing)
   - Record audio directly
4. **Configure Options**:
   - Video: Choose output format, crop presets, adjust brightness/contrast/saturation
   - Audio: Select denoising options, volume adjustment
   - Transcription: Choose Whisper model size, enable speaker identification, select export format
5. **Process**: Click process and wait for completion
6. **Download Results**: Save converted files, transcriptions, or SRT subtitles in multiple formats

## Real-world Problems Solved

- **Privacy concerns with cloud transcription**: SpeakShift runs models locally, so no audio or video files leave your machine.
- **Pay-per-use / credits burden**: No credits or usage fees — process files offline without recurring costs.
- **Fragmented toolchains**: Convert, transcribe, and edit media in one app to reduce context switching and repetitive exports.
- **Slow turnaround for large files**: Local processing with hardware acceleration and batch workflows speeds delivery.
- **Multilingual and accessibility needs**: Built-in Whisper models and SRT/VTT export make content accessible across languages and platforms.
- **Speaker separation and editing**: Speaker diarization and segment grouping simplify multi-speaker workflows for editors and journalists.

## Productivity & Value

- **Cross-platform consistency**: Works on Windows, macOS (Intel & Apple Silicon), and Linux — same features and UX everywhere.
- **Time savings**: Batch processing, smart presets, and integrated FFmpeg pipelines reduce manual steps and save hours per project.
- **Zero vendor lock-in**: Local models and standard export formats (SRT, VTT, MP4, WebM) keep your data portable.
- **100% free & local**: No subscription, no credits, no cloud fees — one-time install, unlimited usage.
- **Lifetime support & updates**: Free updates and long-term support ensure the app stays current and secure.

## Licensing, Support & Privacy

- **License**: SpeakShift is free for personal and professional use. All processing and results remain on-device.
- **Support & Updates**: Ongoing maintenance, security patches, and feature updates are provided at no extra cost.
- **Privacy**: No telemetry or uploads during processing; model downloads occur locally and are cached per user.

## Supported Formats

### Input Formats
- Video: MP4, AVI, MOV, MKV, WebM, FLV, WMV
- Audio: MP3, WAV, FLAC, AAC, OGG, M4A
- URLs: YouTube video URLs (automatically downloaded and processed)

### Output Formats
- Video: MP4, WebM, AVI
- Audio: MP3, WAV, FLAC
- Subtitles: SRT, VTT, WebVTT
- Transcription: TXT, JSON, CSV

## AI Models

SpeakShift uses local AI models that are downloaded on first use:

- **Whisper Models**: tiny, base, small, medium, large (for transcription in multiple languages)
- **Speaker Diarization Models**: Parakeet models onnx (for speaker diarization and grouping)
- **Transformers**: For various AI processing tasks

All models run locally and never send data to external servers.
All hardware supported and fallback implemented : 
Burn,Metal,GPU(nvidia,amd,intel),CPUs(INtel,amd).
## Architecture

- **Frontend**: Next.js with React, TypeScript, Tailwind CSS
- **Backend**: Tauri (Rust) for native desktop integration
- **Media Processing**: FFmpeg WebAssembly for client-side processing
- **AI**: Hugging Face Transformers, OpenAI Whisper
- **Database**: SQLite for local data storage
- **Internationalization**: next-intl for multilingual support

## Technical Aspects

- **Local Processing**: All AI inference and media processing occurs on-device using WebAssembly and native libraries
- **Model Management**: Automatic download and caching of AI models with version control
- **Hardware Acceleration**: Utilizes GPU acceleration when available for faster processing
- **Memory Management**: Optimized memory usage for large file processing
- **Security**: Sandboxed execution environment with no network access during processing
- **Performance**: Multi-threaded processing with progress tracking and cancellation support
- **Compatibility**: Supports legacy macOS versions (10.3+) through compatibility layers
- **File Handling**: Robust error handling for corrupted files and unsupported formats
- **Audio Processing**: Advanced audio filtering including noise reduction and normalization

## Contributing

We welcome contributions! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

SpeakShift is licensed for professional and personal use. All local processing results belong 100% to the user. No data is harvested or transmitted.
No reselling or redistribution allowed, Only for purchase through official channels.Lifetime updates support is provided.

## Support

For support, feature requests, or bug reports:

- Visit our website: [www.maxinlabs.com](https://www.maxinlabs.com)
- Email: support@maxinlabs.com

## Publisher

**MaxinLabs**  
Building the future of local, privacy-first software.

Learn more at [www.maxinlabs.com](https://www.maxinlabs.com)

---

*SpeakShift - Zero Uploads. Studio Power. The ultimate desktop studio for creators.*
#   S p e a k S h i f t 2  
 