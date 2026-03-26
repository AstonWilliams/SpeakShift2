// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::Result;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::StreamExt;
use hound::{SampleFormat, WavReader};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use serde_json::Value;
use std::env;
use std::fs;
use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::io::Cursor;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tauri::{command, AppHandle};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tempfile::NamedTempFile;
use tokio::fs::File as TokioFile;
use tokio::io::AsyncWriteExt;
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as TokioMutex;
use uuid::Uuid;
use walkdir::WalkDir;
use zip::ZipArchive;

#[derive(serde::Serialize)]
struct Segment {
    start_ms: i64,
    end_ms: i64,
    text: String,
}

#[derive(serde::Serialize)]
struct TranscriptionResult {
    segments: Vec<Segment>,
    detected_language: Option<String>,
    language: Option<String>,
    error: Option<String>,
    full_text: String,
    audio_path: String,
}

#[derive(serde::Serialize)]
struct BatchRuntimeLimits {
    os: String,
    total_ram_mib: u64,
    free_ram_mib: u64,
    logical_cores: u16,
    model_estimated_ram_mib: u64,
    reserve_ram_mib: u64,
    recommended_parallel_items: u16,
    max_parallel_items: u16,
    recommended_threads_per_item: u16,
    acceleration_mode: String,
    notes: Vec<String>,
}

#[derive(serde::Serialize)]
struct BatchSourceExpandResult {
    items: Vec<String>,
    warnings: Vec<String>,
    extracted_dir: Option<String>,
}

fn is_supported_media_ext(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "mp3" | "wav" | "m4a" | "ogg" | "flac" | "mp4" | "mkv" | "webm" | "mov"
    )
}

fn estimate_whisper_ram_mib(model_name: &str) -> u64 {
    let m = model_name.to_ascii_lowercase();
    if m.contains("large") {
        10_500
    } else if m.contains("medium") {
        6_200
    } else if m.contains("small") {
        3_000
    } else if m.contains("base") {
        1_400
    } else {
        900
    }
}

fn sanitize_queue_name(input: &str) -> String {
    let cleaned: String = input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "queue".to_string()
    } else {
        trimmed.to_string()
    }
}

fn collect_media_files(root: &Path) -> Vec<String> {
    if root.is_file() {
        return if is_supported_media_ext(root) {
            vec![root.to_string_lossy().to_string()]
        } else {
            Vec::new()
        };
    }

    let mut out = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if p.is_file() && is_supported_media_ext(p) {
            out.push(p.to_string_lossy().to_string());
        }
    }
    out
}

async fn download_remote_media_with_ytdlp(
    app: &AppHandle,
    url: &str,
    download_dir: &Path,
) -> Result<Vec<String>, String> {
    let yt_dlp = get_yt_dlp_path(app)?;
    fs::create_dir_all(download_dir)
        .map_err(|e| format!("Cannot create remote download dir {}: {}", download_dir.display(), e))?;

    let before: HashSet<String> = collect_media_files(download_dir).into_iter().collect();
    let output_template = download_dir.join("%(extractor)s_%(id)s.%(ext)s");

    let mut cmd = TokioCommand::new(&yt_dlp);
    if let Some(parent) = yt_dlp.parent() {
        cmd.current_dir(parent);
    }

    let output = cmd
        .arg("--force-overwrites")
        .arg("--no-warnings")
        .arg("--no-part")
        .arg("--yes-playlist")
        .arg("--ignore-errors")
        .arg("-f")
        .arg("bestaudio/best")
        .arg("-o")
        .arg(output_template.to_string_lossy().to_string())
        .arg(url)
        .output()
        .await
        .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp failed for {} (code {:?}): {}",
            url,
            output.status.code(),
            err.trim()
        ));
    }

    let mut downloaded = collect_media_files(download_dir);
    downloaded.retain(|item| !before.contains(item));

    if downloaded.is_empty() {
        return Ok(collect_media_files(download_dir));
    }

    Ok(downloaded)
}

fn extract_zip(zip_path: &Path, target_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open zip archive {}: {}", zip_path.display(), e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Cannot read zip entry {}: {}", i, e))?;

        let Some(rel) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };

        let out_path = target_dir.join(rel);
        if entry.name().ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Cannot create dir {}: {}", out_path.display(), e))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create dir {}: {}", parent.display(), e))?;
        }

        let mut outfile = fs::File::create(&out_path)
            .map_err(|e| format!("Cannot create file {}: {}", out_path.display(), e))?;
        std::io::copy(&mut entry, &mut outfile)
            .map_err(|e| format!("Cannot extract {}: {}", out_path.display(), e))?;
    }

    Ok(())
}

#[tauri::command]
async fn batch_get_runtime_limits(
    app: AppHandle,
    model_name: String,
    acceleration: Option<String>,
    requested_parallel: Option<u16>,
) -> Result<BatchRuntimeLimits, String> {
    ensure_feature_unlocked(&app, "Batch transcription")?;
    let mut sys = System::new_all();
    sys.refresh_memory();

    let total_ram_mib = sys.total_memory() / (1024 * 1024);
    let free_ram_mib = sys.available_memory() / (1024 * 1024);
    let logical_cores = std::thread::available_parallelism()
        .map(|n| n.get() as u16)
        .unwrap_or(2);

    let model_estimated_ram_mib = estimate_whisper_ram_mib(&model_name);
    let reserve_ram_mib = 1_024u64;
    let per_worker_mib = model_estimated_ram_mib.saturating_add(450);

    let max_by_mem = if free_ram_mib <= reserve_ram_mib {
        1
    } else {
        ((free_ram_mib - reserve_ram_mib) / per_worker_mib).max(1)
    } as u16;

    let max_by_cpu = logical_cores.clamp(1, 8);
    let mut max_parallel_items = max_by_mem.min(max_by_cpu).max(1);

    let acceleration_mode = acceleration.unwrap_or_else(|| {
        if cfg!(target_os = "macos") {
            "metal-auto".to_string()
        } else if cfg!(target_os = "windows") {
            "dml-or-cpu-auto".to_string()
        } else {
            "cuda-or-cpu-auto".to_string()
        }
    });

    let accel = acceleration_mode.to_ascii_lowercase();
    if accel.contains("cpu") && max_parallel_items > 2 {
        max_parallel_items = 2;
    }
    if accel.contains("aggressive") {
        max_parallel_items = (max_parallel_items + 1).min(logical_cores.clamp(1, 12));
    }

    let mut recommended_parallel_items = max_parallel_items;
    if free_ram_mib <= 4_096 {
        recommended_parallel_items = 1;
    } else if free_ram_mib <= 8_192 {
        recommended_parallel_items = recommended_parallel_items.min(2);
    } else {
        recommended_parallel_items = recommended_parallel_items.min(4);
    }

    if let Some(requested) = requested_parallel {
        recommended_parallel_items = requested.clamp(1, max_parallel_items);
    }

    if accel.contains("cpu-safe") {
        max_parallel_items = max_parallel_items.min(2);
        recommended_parallel_items = 1;
    } else if accel.contains("balanced") {
        recommended_parallel_items = recommended_parallel_items.min(3);
    }

    let recommended_threads_per_item = (logical_cores / recommended_parallel_items.max(1))
        .clamp(1, 8)
        .max(1);

    let mut notes = Vec::new();
    if free_ram_mib <= 4_096 {
        notes.push("Low available RAM detected; forcing single-item processing".to_string());
    }
    if model_estimated_ram_mib >= 6_000 {
        notes.push("Large Whisper model selected; conservative parallelism applied".to_string());
    }
    if total_ram_mib <= 8_192 {
        notes.push("Host appears to be low-memory; close other apps for stability".to_string());
    }
    if accel.contains("cpu-safe") {
        notes.push("CPU-safe profile enabled: lower parallelism and lower threads applied".to_string());
    } else if accel.contains("aggressive") {
        notes.push("Aggressive profile enabled: increased throughput targets when resources allow".to_string());
    }

    Ok(BatchRuntimeLimits {
        os: std::env::consts::OS.to_string(),
        total_ram_mib,
        free_ram_mib,
        logical_cores,
        model_estimated_ram_mib,
        reserve_ram_mib,
        recommended_parallel_items,
        max_parallel_items,
        recommended_threads_per_item,
        acceleration_mode,
        notes,
    })
}

#[tauri::command]
async fn batch_expand_source(
    app: AppHandle,
    value: String,
    source_type: String,
    download_dir: Option<String>,
) -> Result<BatchSourceExpandResult, String> {
    ensure_feature_unlocked(&app, "Batch transcription")?;
    let source = source_type.to_ascii_lowercase();
    let mut warnings = Vec::new();

    if source == "drive-link" {
        let mut remote_root = if let Some(custom) = download_dir
            .clone()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
        {
            custom
        } else {
            let mut root = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("Cannot resolve app local data dir: {}", e))?;
            root.push("batch_remote_media");
            root
        };

        remote_root.push(Uuid::new_v4().to_string());
        fs::create_dir_all(&remote_root)
            .map_err(|e| format!("Cannot create remote download directory: {}", e))?;

        let items = download_remote_media_with_ytdlp(&app, value.trim(), &remote_root).await?;
        if items.is_empty() {
            warnings.push("No downloadable media files were resolved from this link".to_string());
        }

        return Ok(BatchSourceExpandResult {
            items,
            warnings,
            extracted_dir: Some(remote_root.to_string_lossy().to_string()),
        });
    }

    let path = PathBuf::from(value.clone());
    if !path.exists() {
        return Err(format!("Source not found: {}", value));
    }

    if source == "zip" {
        let ext = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        if ext != "zip" {
            warnings.push("Only .zip extraction is supported currently".to_string());
            return Ok(BatchSourceExpandResult {
                items: Vec::new(),
                warnings,
                extracted_dir: None,
            });
        }

        let mut extract_root = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("Cannot resolve app local data dir: {}", e))?;
        extract_root.push("batch_extract");
        extract_root.push(Uuid::new_v4().to_string());
        fs::create_dir_all(&extract_root)
            .map_err(|e| format!("Cannot create extraction directory: {}", e))?;

        extract_zip(&path, &extract_root)?;
        let items = collect_media_files(&extract_root);

        if items.is_empty() {
            warnings.push("No supported media files were found inside the zip".to_string());
        }

        return Ok(BatchSourceExpandResult {
            items,
            warnings,
            extracted_dir: Some(extract_root.to_string_lossy().to_string()),
        });
    }

    if source == "folder" {
        let items = collect_media_files(&path);
        if items.is_empty() {
            warnings.push("No supported media files found in folder".to_string());
        }

        return Ok(BatchSourceExpandResult {
            items,
            warnings,
            extracted_dir: None,
        });
    }

    Err(format!("Unsupported source type: {}", source_type))
}

#[tauri::command]
fn batch_prepare_queue_output(app: AppHandle, base_output: String, queue_name: String) -> Result<String, String> {
    ensure_feature_unlocked(&app, "Batch transcription")?;
    let safe_name = sanitize_queue_name(&queue_name);
    let queue_dir = PathBuf::from(base_output).join(safe_name);
    fs::create_dir_all(&queue_dir)
        .map_err(|e| format!("Failed to create queue output directory: {}", e))?;
    Ok(queue_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn batch_write_text_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    ensure_feature_unlocked(&app, "Batch transcription")?;
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }
    fs::write(&target, content).map_err(|e| format!("Failed writing text file: {}", e))
}

#[tauri::command]
fn batch_write_bytes_file(app: AppHandle, path: String, bytes: Vec<u8>) -> Result<(), String> {
    ensure_feature_unlocked(&app, "Batch transcription")?;
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }
    fs::write(&target, bytes).map_err(|e| format!("Failed writing binary file: {}", e))
}

fn get_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Cannot get app local data dir: {}", e))?;

    dir.push("whisper_models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create models dir: {}", e))?;

    Ok(dir)
}

fn normalize_whisper_model_filename(model_name: &str) -> String {
    let trimmed = model_name.trim().to_ascii_lowercase();

    if trimmed.starts_with("ggml-") {
        if trimmed.ends_with(".bin") {
            trimmed
        } else {
            format!("{}.bin", trimmed)
        }
    } else if trimmed.ends_with(".bin") {
        format!("ggml-{}", trimmed)
    } else {
        format!("ggml-{}.bin", trimmed)
    }
}

async fn download_model(app: AppHandle, model_name: &str) -> Result<PathBuf, String> {
    let models_dir = get_models_dir(&app).map_err(|e| e.to_string())?;

    let filename = normalize_whisper_model_filename(model_name);

    let target_path = models_dir.join(&filename);

    if target_path.exists() {
        println!(
            "[MODEL] Using already downloaded file: {}",
            target_path.display()
        );
        return Ok(target_path);
    }

    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
        filename
    );

    println!("[MODEL] Downloading from: {}", url);
    let client = Client::builder()
        .user_agent("SpeakShift-Tauri/0.1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    // Get total content length for progress calculation
    let total_size = response.content_length().unwrap_or(0);

    let mut file = TokioFile::create(&target_path)
        .await
        .map_err(|e| e.to_string())?;

    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;

    let mut stream = response.bytes_stream();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| format!("Failed to read chunk: {}", e))?;
        let chunk_len = chunk.len() as u64;

        file.write_all(&chunk).await.map_err(|e| e.to_string())?;

        downloaded += chunk_len;

        // Emit progress every ~5% or at least every 1MB to avoid spamming
        if total_size > 0 {
            let percentage = ((downloaded as f64 / total_size as f64) * 100.0) as u64;
            if percentage >= last_emitted + 5 || downloaded - last_emitted > 1_000_000 {
                let _ = app.emit(
                    "download-model-progress",
                    json!({
                        "model": model_name,
                        "percentage": percentage,
                        "total": total_size,
                        "downloaded": downloaded
                    }),
                );
                last_emitted = percentage;
            }
        }
    }

    // Final 100% emit
    let _ = app.emit(
        "download-model-progress",
        json!({
            "model": model_name,
            "percentage": 100u64,
            "total": total_size,
            "downloaded": downloaded
        }),
    );

    Ok(target_path)
}

#[command]
async fn ensure_whisper_model(app: AppHandle, model_name: String) -> Result<String, String> {
    let path = download_model(app, &model_name).await?;
    Ok(path.to_string_lossy().to_string())
}

#[command]
async fn list_downloaded_models(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = get_models_dir(&app).map_err(|e| e.to_string())?;
    let mut models = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("bin") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if stem.starts_with("ggml-") {
                        models.push(stem.replace("ggml-", ""));
                    }
                }
            }
        }
    }

    Ok(models)
}

fn get_ffmpeg_path(app: &AppHandle) -> Result<PathBuf, String> {
    get_sidecar_path(
        app,
        "ffmpeg",
        "x86_64-pc-windows-msvc.exe",
        "x86_64-unknown-linux-gnu",
        "x86_64-apple-darwin",
    )
}


#[tauri::command]
async fn download_youtube_video(url: String) -> Result<String, String> {
    Ok(format!("Downloaded video from: {}", url))
}

#[tauri::command]
async fn delete_whisper_model(app: AppHandle, model_name: String) -> Result<(), String> {
    let models_dir = get_models_dir(&app).map_err(|e| e.to_string())?;
    let file_path = models_dir.join(normalize_whisper_model_filename(&model_name));

    if !file_path.exists() {
        return Err("Model file not found".to_string());
    }

    fs::remove_file(&file_path).map_err(|e| format!("Failed to delete model file: {}", e))?;

    Ok(())
}

fn get_whisper_cli_path(app: &AppHandle) -> Result<PathBuf, String> {
    get_sidecar_path(
        app,
        "whisper-cli",
        "x86_64-pc-windows-msvc.exe",
        "x86_64-unknown-linux-gnu",
        "x86_64-apple-darwin",
    )
}

fn parse_whisper_cli_json(json: &Value, audio_path: String) -> TranscriptionResult {
    let mut segments = Vec::new();
    let mut full_text = String::new();

    if let Some(trans) = json["transcription"].as_array() {
        for seg in trans {
            let from_ms = seg["offsets"]["from"].as_i64().unwrap_or(0);
            let to_ms = seg["offsets"]["to"].as_i64().unwrap_or(0);
            let text = seg["text"].as_str().unwrap_or("").trim().to_string();

            if !text.is_empty() {
                segments.push(Segment {
                    start_ms: from_ms,
                    end_ms: to_ms,
                    text: text.clone(),
                });
                full_text.push_str(&text);
                full_text.push(' ');
            }
        }
    }

    let detected_lang = json["result"]["language"].as_str().map(|s| s.to_string());

    TranscriptionResult {
        segments,
        detected_language: detected_lang,
        language: None, // can be set from input if needed
        error: None,
        full_text: full_text.trim().to_string(),
        audio_path,
    }
}

// =====================================================
// transcribe_media – file → ffmpeg → whisper_cli
// =====================================================
#[tauri::command]
async fn transcribe_media(
    app: AppHandle,
    file_path: String,
    model_name: String,
    language: Option<String>,
) -> Result<TranscriptionResult, String> {
    let whisper_cli_path = get_whisper_cli_path(&app)?;

    println!("[WHISPER] Using binary: {}", whisper_cli_path.display());

    // 1. Convert to 16kHz mono WAV
    let temp_wav = NamedTempFile::new().map_err(|e| format!("Cannot create temp file: {}", e))?;
    let temp_wav_path = temp_wav.path().to_string_lossy().to_string();

    let ffmpeg_bin = get_ffmpeg_path(&app)?;

    let ffmpeg_output = tokio::process::Command::new(&ffmpeg_bin)
        .args([
            "-y",
            "-i",
            &file_path,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            &temp_wav_path,
        ])
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed: {}", e))?;

    if !ffmpeg_output.status.success() {
        let err = String::from_utf8_lossy(&ffmpeg_output.stderr);
        return Err(format!("FFmpeg conversion failed:\n{}", err.trim()));
    }

    // 2. Run whisper-cli using tokio::process::Command
    let model_path = get_models_dir(&app)?
        .join(normalize_whisper_model_filename(&model_name))
        .to_string_lossy()
        .to_string();

    if !Path::new(&model_path).exists() {
        return Err(format!("Model not found: {}", model_path));
    }

    let lang = language.clone().unwrap_or_else(|| "auto".to_string());

    let mut cmd = tokio::process::Command::new(&whisper_cli_path);

    // Very important for DLL loading on Windows
    cmd.current_dir(whisper_cli_path.parent().unwrap_or(Path::new(".")));

    cmd.args([
        "-m",
        &model_path,
        "-f",
        &temp_wav_path,
        "--language",
        &lang,
        "--output-json",
    ]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to spawn whisper-cli: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "whisper-cli failed (exit code {:?}):\n{}",
            output.status.code(),
            err.trim()
        ));
    }

    // 3. Read result JSON
    let json_path = Path::new(&temp_wav_path).with_extension("json");

    if !json_path.exists() {
        return Err("No JSON output generated by whisper-cli".to_string());
    }

    let json_content =
        fs::read_to_string(&json_path).map_err(|e| format!("Cannot read JSON: {}", e))?;

    let parsed: Value =
        serde_json::from_str(&json_content).map_err(|e| format!("Invalid JSON: {}", e))?;

    // 4. Parse
    let mut result = parse_whisper_cli_json(&parsed, temp_wav_path.clone());

    // 5. Emit event
    let _ = app.emit(
        "transcription-completed",
        json!({
            "audioPath": temp_wav_path,
            "segments": &result.segments,
            "fullText": &result.full_text,
            "detectedLanguage": result.detected_language,
            "sourceType": "file",
        }),
    );

    // Cleanup
    let _ = fs::remove_file(json_path);

    Ok(result)
}

// =====================================================
// transcribe_wav – already WAV → whisper_cli
// =====================================================
#[tauri::command]
async fn transcribe_wav(
    app: AppHandle,
    wav_path: String,
    model_name: String,
    language: Option<String>,
) -> Result<TranscriptionResult, String> {
    let whisper_cli_path = get_whisper_cli_path(&app)?;

    // Validate input is likely a wav
    if !wav_path.to_lowercase().ends_with(".wav") {
        return Err("File must be a .wav file".to_string());
    }

    // Ensure model exists for recording workflows as well (auto-download if missing).
    let model_path = ensure_whisper_model(app.clone(), model_name.clone()).await?;

    if !Path::new(&model_path).exists() {
        return Err(format!("Model not found: {}", model_path));
    }

    let lang = language.clone().unwrap_or_else(|| "auto".to_string());

    // ── Use tokio::process::Command with current_dir ──
    let mut cmd = TokioCommand::new(&whisper_cli_path);

    // Very important: set current directory so DLLs are found
    if let Some(parent) = whisper_cli_path.parent() {
        cmd.current_dir(parent);
    }

    cmd.args([
        "-m",
        &model_path,
        "-f",
        &wav_path,
        "--language",
        &lang,
        "--output-json",
    ]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to spawn whisper-cli: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "whisper-cli failed (exit code {:?}):\n{}",
            output.status.code(),
            err.trim()
        ));
    }

    let json_path = Path::new(&wav_path).with_extension("json");

    if !json_path.exists() {
        return Err("No JSON output generated".to_string());
    }

    let json_content =
        fs::read_to_string(&json_path).map_err(|e| format!("Cannot read JSON: {}", e))?;

    let parsed: Value =
        serde_json::from_str(&json_content).map_err(|e| format!("Invalid JSON: {}", e))?;

    let mut result = parse_whisper_cli_json(&parsed, wav_path.clone());

    let _ = app.emit(
        "transcription-completed",
        json!({
            "audioPath": wav_path,
            "segments": &result.segments,
            "fullText": &result.full_text,
            "detectedLanguage": result.detected_language,
            "sourceType": "wav",
        }),
    );

    let _ = fs::remove_file(json_path);

    Ok(result)
}

// =====================================================
// transcribe_youtube – download + convert + transcribe
// =====================================================

#[tauri::command]
async fn transcribe_youtube(
    app: AppHandle,
    url: String,
    model_name: String,
    language: Option<String>,
) -> Result<TranscriptionResult, String> {
    println!("[YT-CMD] START | url = {}", url);
    println!("[YT-CMD] model = {}", model_name);
    println!(
        "[YT-CMD] language = {:?}",
        language.as_deref().unwrap_or("auto")
    );

    let whisper_cli_path = get_whisper_cli_path(&app).map_err(|e| {
        println!("[YT-CMD] ERROR: Failed to locate whisper-cli binary: {}", e);
        e
    })?;
    println!(
        "[YT-CMD] whisper-cli found at: {}",
        whisper_cli_path.display()
    );

    // Prepare persistent directories
    let app_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Cannot get app data dir: {}", e))?;

    let temp_audio_dir = app_data_dir.join("temp_audio");
    let json_dir = app_data_dir.join("json_files");

    std::fs::create_dir_all(&temp_audio_dir)
        .map_err(|e| format!("Cannot create temp_audio dir: {}", e))?;
    std::fs::create_dir_all(&json_dir)
        .map_err(|e| format!("Cannot create json_files dir: {}", e))?;

    // 1. Download audio (already saved in temp_audio)
    println!("[YT-CMD] Starting YouTube audio download...");
    let raw_path_str = download_youtube_audio(url.clone(), app.clone())
        .await
        .inspect_err(|e| println!("[YT-CMD] DOWNLOAD FAILED: {}", e))?;

    let raw_path = PathBuf::from(&raw_path_str);
    println!(
        "[YT-CMD] Download completed → raw file: {}",
        raw_path.display()
    );

    if let Ok(metadata) = std::fs::metadata(&raw_path) {
        println!("[YT-CMD] Raw audio file size: {} bytes", metadata.len());
    } else {
        println!("[YT-CMD] WARNING: Could not read metadata of raw file");
    }

    // 2. Convert to 16kHz mono wav → save permanently in temp_audio
    let unique_id = Uuid::new_v4().to_string();
    let wav_filename = format!("conv_{}.wav", unique_id);
    let final_wav_path_buf = temp_audio_dir.join(&wav_filename);
    let final_wav_path = final_wav_path_buf.to_string_lossy().to_string();

    println!("[YT-CMD] Starting ffmpeg conversion → {}", final_wav_path);

    convert_to_whisper_wav(&app, &raw_path, &final_wav_path_buf)
        .await
        .inspect_err(|e| println!("[YT-CMD] FFMPEG FAILED: {}", e))?;

    println!("[YT-CMD] Conversion completed successfully");

    // Verify output file
    if let Ok(metadata) = std::fs::metadata(&final_wav_path) {
        println!("[YT-CMD] Converted WAV size: {} bytes", metadata.len());
        if metadata.len() < 10000 {
            println!("[YT-CMD] WARNING: Converted file is very small — may be corrupted");
        }
    } else {
        println!(
            "[YT-CMD] ERROR: Converted WAV file not found at {}",
            final_wav_path
        );
        return Err("Converted WAV file was not created".to_string());
    }

    // 3. Ensure model
    println!("[YT-CMD] Ensuring model exists: {}", model_name);
    let model_path = ensure_whisper_model(app.clone(), model_name.clone())
        .await
        .inspect_err(|e| println!("[YT-CMD] MODEL ERROR: {}", e))?;

    println!("[YT-CMD] Model ready → path: {}", model_path);

    if !Path::new(&model_path).exists() {
        let msg = format!("Model file not found: {}", model_path);
        println!("[YT-CMD] ERROR: {}", msg);
        return Err(msg);
    }

    // 4. Prepare whisper-cli command
    let lang = language.unwrap_or_else(|| "auto".to_string());
    println!("[YT-CMD] Language set to: {}", lang);

    let mut cmd = TokioCommand::new(&whisper_cli_path);

    if let Some(parent) = whisper_cli_path.parent() {
        println!(
            "[YT-CMD] Setting working directory to: {}",
            parent.display()
        );
        cmd.current_dir(parent);
    }

    println!(
        "[YT-CMD] Running whisper-cli with args: -m {:?} -f {:?} --language {:?} --output-json",
        model_path, final_wav_path, lang
    );

    cmd.args([
        "-m",
        &model_path,
        "-f",
        &final_wav_path,
        "--language",
        &lang,
        "--output-json",
    ]);

    println!("[YT-CMD] Executing whisper-cli...");
    let output = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| {
            let msg = format!("Failed to spawn whisper-cli: {}", e);
            println!("[YT-CMD] SPAWN ERROR: {}", msg);
            msg
        })?;

    println!(
        "[YT-CMD] whisper-cli finished | exit code: {:?}",
        output.status.code()
    );

    let stdout_str = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();

    if !stdout_str.is_empty() {
        println!("[WHISPER STDOUT]\n{}", stdout_str.trim());
    }
    if !stderr_str.is_empty() {
        println!("[WHISPER STDERR]\n{}", stderr_str.trim());
    }

    if !output.status.success() {
        let err = stderr_str;
        println!("[YT-CMD] WHISPER-CLI FAILED");
        return Err(format!(
            "whisper-cli failed (exit code {:?}):\n{}",
            output.status.code(),
            err.trim()
        ));
    }

    println!("[YT-CMD] whisper-cli succeeded");

    // ────────────────────────────────────────────────
    // JSON is saved as <wav-filename>.json in json_files folder
    // ────────────────────────────────────────────────
    let json_filename = format!("{}.json", wav_filename);
    let json_path_buf = temp_audio_dir.join(&json_filename);
    let json_path = json_path_buf.to_string_lossy().to_string();

    println!("[YT-CMD] Expecting JSON output at: {}", json_path);

    // Because whisper-cli may write to working directory instead of next to input file
    // Try both locations
    let mut actual_json_path = PathBuf::from(&json_path);

    if !actual_json_path.exists() {
        // Fallback: check in working directory (where whisper-cli was run)
        let working_dir_json = whisper_cli_path
            .parent()
            .unwrap_or(&PathBuf::from("."))
            .join(&json_filename);

        if working_dir_json.exists() {
            println!(
                "[YT-CMD] JSON found in working directory instead: {}",
                working_dir_json.display()
            );
            actual_json_path = working_dir_json;
        }
    }

    if !actual_json_path.exists() {
        let msg = "No JSON output generated by whisper-cli".to_string();
        println!("[YT-CMD] ERROR: {}", msg);

        // Debug: list files in json_dir
        if let Ok(entries) = std::fs::read_dir(&json_dir) {
            println!("[YT-CMD] Files in json_files dir:");
            for entry in entries.flatten() {
                println!("  - {}", entry.path().display());
            }
        }

        return Err(msg);
    }

    println!(
        "[YT-CMD] Reading JSON output from: {}",
        actual_json_path.display()
    );
    let json_content = fs::read_to_string(&actual_json_path).map_err(|e| {
        let msg = format!("Cannot read JSON: {}", e);
        println!("[YT-CMD] JSON READ ERROR: {}", msg);
        msg
    })?;

    println!("[YT-CMD] Parsing JSON...");
    let parsed: Value = serde_json::from_str(&json_content).map_err(|e| {
        let msg = format!("Invalid JSON: {}", e);
        println!("[YT-CMD] JSON PARSE ERROR: {}", msg);
        msg
    })?;

    println!("[YT-CMD] Converting whisper JSON to result struct...");
    let mut result = parse_whisper_cli_json(&parsed, final_wav_path.clone());

    println!("[YT-CMD] Emitting transcription-completed event...");
    let _ = app.emit(
        "transcription-completed",
        json!({
            "audioPath": final_wav_path,
            "segments": &result.segments,
            "fullText": &result.full_text,
            "detectedLanguage": result.detected_language,
            "sourceUrl": url,
            "sourceType": "youtube",
        }),
    );

    println!("[YT-CMD] FINISH → success");
    Ok(result)
}
// =====================================================
// transcribe_path – file → ffmpeg → whisper_cli
// =====================================================
#[tauri::command]
async fn transcribe_path(
    file_path: String,
    file_name: String,
    model_name: String,
    app: tauri::AppHandle,
    language: Option<String>,
    threads: Option<u16>,
    acceleration: Option<String>,
) -> Result<TranscriptionResult, String> {
    let whisper_cli_path = get_whisper_cli_path(&app)?;

    println!("[DEBUG] transcribe_path STARTED | file_path: {}", file_path);
    println!("[DEBUG] model: {}", model_name);

    let mut sys = System::new_all();
    sys.refresh_memory();

    let free_ram_mib = sys.available_memory() / (1024 * 1024);
    let model_estimated_ram_mib = estimate_whisper_ram_mib(&model_name);
    let reserve_ram_mib = 1_024u64;
    let logical_cores = std::thread::available_parallelism()
        .map(|n| n.get() as u16)
        .unwrap_or(2)
        .max(1);
    let recommended_threads_per_item = logical_cores.clamp(1, 8);

    if free_ram_mib <= reserve_ram_mib + model_estimated_ram_mib / 2 {
        return Err(format!(
            "Not enough free RAM for safe transcription. Free: {} MiB, required estimate: {} MiB",
            free_ram_mib,
            model_estimated_ram_mib
        ));
    }

    // 1. Ensure model exists
    let model_path_str = ensure_whisper_model(app.clone(), model_name.clone()).await?;

    // 2. Convert input to 16kHz mono WAV using ffmpeg
    let ffmpeg_bin = get_ffmpeg_path(&app)?;

    let converted_temp =
        NamedTempFile::new().map_err(|e| format!("Temp file creation failed: {}", e))?;
    let converted_path = format!("{}.wav", converted_temp.path().to_str().unwrap());
    let accel_mode = acceleration
        .clone()
        .unwrap_or_else(|| "auto".to_string())
        .to_ascii_lowercase();

    let mut worker_threads = threads
        .unwrap_or(recommended_threads_per_item)
        .clamp(1, logical_cores.max(1));

    if accel_mode.contains("cpu-safe") {
        worker_threads = worker_threads.min(2);
    } else if accel_mode.contains("balanced") {
        worker_threads = worker_threads.min(4);
    } else if accel_mode.contains("aggressive") {
        worker_threads = worker_threads.max((logical_cores / 2).max(1));
    }

    let ffmpeg_output = Command::new(&ffmpeg_bin)
        .args([
            "-y",
            "-threads",
            &worker_threads.to_string(),
            "-i",
            &file_path,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            &converted_path,
        ])
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("FFmpeg spawn failed: {}", e))?;

    if !ffmpeg_output.status.success() {
        let err_msg = String::from_utf8_lossy(&ffmpeg_output.stderr).to_string();
        return Err(format!("FFmpeg conversion failed:\n{}", err_msg.trim()));
    }

    // 3. Run whisper-cli with tokio::process::Command
    let lang = language.clone().unwrap_or_else(|| "auto".to_string());

    let mut cmd = TokioCommand::new(&whisper_cli_path);

    if let Some(parent) = whisper_cli_path.parent() {
        cmd.current_dir(parent);
    }

    cmd.args([
        "-m",
        &model_path_str,
        "-f",
        &converted_path,
        "--language",
        &lang,
        "--output-json",
    ]);

    cmd.args(["-t", &worker_threads.to_string()]);
    cmd.env("OMP_NUM_THREADS", worker_threads.to_string());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to spawn whisper-cli: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "whisper-cli failed (exit code {:?}):\n{}",
            output.status.code(),
            err.trim()
        ));
    }

    // 4. Read JSON
    let json_path = format!("{}.json", converted_path);

    let json_content = fs::read_to_string(&json_path)
        .map_err(|e| format!("Cannot read whisper-cli JSON: {}", e))?;

    let parsed: Value = serde_json::from_str(&json_content)
        .map_err(|e| format!("Invalid JSON from whisper-cli: {}", e))?;

    // 5. Convert to TranscriptionResult
    let mut segments = Vec::new();
    let mut full_text = String::new();

    if let Some(trans) = parsed["transcription"].as_array() {
        for seg in trans {
            let from_ms = seg["offsets"]["from"].as_i64().unwrap_or(0);
            let to_ms = seg["offsets"]["to"].as_i64().unwrap_or(0);
            let text = seg["text"].as_str().unwrap_or("").trim().to_string();

            if !text.is_empty() {
                segments.push(Segment {
                    start_ms: from_ms,
                    end_ms: to_ms,
                    text: text.clone(),
                });
                full_text.push_str(&text);
                full_text.push(' ');
            }
        }
    }

    let detected_lang = parsed["result"]["language"].as_str().map(|s| s.to_string());

    let result = TranscriptionResult {
        segments,
        detected_language: detected_lang,
        language,
        error: None,
        full_text: full_text.trim().to_string(),
        audio_path: converted_path.clone(),
    };

    // Emit event
    let _ = app.emit(
        "transcription-completed",
        json!({
            "audioPath": converted_path,
            "segments": &result.segments,
            "fullText": &result.full_text,
            "detectedLanguage": result.detected_language,
            "sourceType": "file",
            "fileName": file_name,
        }),
    );

    let _ = fs::remove_file(json_path);

    Ok(result)
}

// YOUTUBE WORKFLOW

// ──────────────────────────────────────────────────────────────
// Progress payload for frontend
// ──────────────────────────────────────────────────────────────
#[derive(serde::Serialize, Clone)]
struct DownloadProgress {
    percentage: f32,
    message: String,
}

fn get_yt_dlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    get_sidecar_path(
        app,
        "yt-dlp",
        "x86_64-pc-windows-msvc.exe",     // most yt-dlp Windows builds use .exe
        "x86_64-unknown-linux-gnu",
        "x86_64-apple-darwin",
    )
}

// ──────────────────────────────────────────────────────────────
// Create safe temporary path in app local data (async)
// ──────────────────────────────────────────────────────────────
async fn create_temp_path(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Cannot get app data dir: {}", e))?;

    dir.push("temp_audio");

    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create temp_audio dir: {}", e))?;

    let path = dir.join(filename);
    println!("[TEMP] Using path: {}", path.display());
    Ok(path)
}

// ──────────────────────────────────────────────────────────────
// Download best audio (raw - usually webm/opus)
// ──────────────────────────────────────────────────────────────
#[tauri::command]
async fn download_youtube_audio(url: String, app: AppHandle) -> Result<String, String> {
    let yt_dlp = get_yt_dlp_path(&app)?;

    // ─── Normalize URL first ───
    let normalized_url = normalize_youtube_url(&url);
    println!("[YT-DLP] Original URL: {}", url);
    println!("[YT-DLP] Normalized URL: {}", normalized_url);

    let video_id = extract_video_id(&normalized_url)
        .ok_or_else(|| "Could not extract video ID from normalized URL".to_string())?;

    let temp_filename = format!("raw_{}.webm", video_id);
    let output_path = create_temp_path(&app, &temp_filename).await?;

    let exe_dir = env::current_exe()
        .map_err(|e| format!("Cannot get exe path: {}", e))?
        .parent()
        .ok_or("No exe parent dir".to_string())?
        .to_path_buf();

    println!("[YT] Downloading to: {}", output_path.display());

    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found".to_string())?;

    let mut cmd = TokioCommand::new(&yt_dlp)
        .current_dir(&exe_dir)
        .env(
            "PATH",
            format!(
                "{};{}",
                exe_dir.display(),
                env::var("PATH").unwrap_or_default()
            ),
        )
        .arg("--force-overwrites")
        .arg("--no-warnings")
        .arg("-f")
        .arg("bestaudio/best")
        .arg("--no-playlist")
        .arg("-o")
        .arg(output_path.to_str().unwrap())
        .arg(&url)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn yt-dlp: {}", e))?;

    // Progress monitoring (simple version)
    let window_clone = window.clone();
    if let (Some(mut stdout), Some(mut stderr)) = (cmd.stdout.take(), cmd.stderr.take()) {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = String::new();
            let _ = stdout.read_to_string(&mut buf).await;
            let _ = stderr.read_to_string(&mut buf).await;

            if let Some(pos) = buf.rfind("[download]") {
                if let Some(end) = buf[pos..].find('%') {
                    let slice = &buf[pos..pos + end];
                    if let Some(perc_str) = slice.split_whitespace().last() {
                        if let Ok(perc) = perc_str.trim_end_matches('%').parse::<f32>() {
                            let _ = window_clone.emit(
                                "download-progress",
                                DownloadProgress {
                                    percentage: perc.clamp(0.0, 100.0),
                                    message: buf.clone(),
                                },
                            );
                        }
                    }
                }
            }
        });
    }

    let output = cmd
        .wait_with_output()
        .await
        .map_err(|e| format!("yt-dlp failed to complete: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp error (code {:?}):\n{}",
            output.status.code(),
            err.trim()
        ));
    }

    let size = fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);

    if size < 4096 {
        return Err(format!("Downloaded file too small ({} bytes)", size));
    }

    println!("[YT] Download complete: {} bytes", size);
    Ok(output_path.to_string_lossy().to_string())
}

// ──────────────────────────────────────────────────────────────
// Convert downloaded audio → 16kHz mono 16-bit PCM WAV
// ──────────────────────────────────────────────────────────────
async fn convert_to_whisper_wav(
    app: &AppHandle,
    input_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let ffmpeg = get_ffmpeg_path(app)?;

    println!(
        "[FFMPEG] Converting {} → {}",
        input_path.display(),
        output_path.display()
    );

    let output = TokioCommand::new(&ffmpeg)
        .args([
            "-y",
            "-i",
            input_path.to_str().unwrap_or(""),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            output_path.to_str().unwrap_or(""),
        ])
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("ffmpeg spawn failed: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffmpeg failed (code {:?}):\n{}",
            output.status.code(),
            err.trim()
        ));
    }

    Ok(())
}

// ──────────────────────────────────────────────────────────────
// Video ID extraction (only once!)
// ──────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────
// Video ID extraction (only once!)
// ──────────────────────────────────────────────────────────────
fn extract_video_id(url: &str) -> Option<String> {
    if let Some(pos) = url.find("v=") {
        let start = pos + 2;
        let end = url[start..]
            .find(&['&', '?', '#'][..])
            .map(|i| start + i)
            .unwrap_or(url.len());
        let id = &url[start..end];
        if id.len() == 11
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Some(id.to_string());
        }
    }

    if let Some(pos) = url.rfind("youtu.be/") {
        let start = pos + 9;
        let end = url[start..]
            .find(&['?', '&', '#'][..])
            .map(|i| start + i)
            .unwrap_or(url.len());
        let id = &url[start..end];
        if id.len() >= 11 {
            return Some(id[..11].to_string());
        }
    }

    let patterns = ["/shorts/", "/embed/", "/v/", "/live/", "/e/"];
    for pattern in patterns {
        if let Some(pos) = url.find(pattern) {
            let start = pos + pattern.len();
            let end = url[start..]
                .find(&['?', '&', '#'][..])
                .map(|i| start + i)
                .unwrap_or(url.len());
            let id = &url[start..end];
            if id.len() == 11 {
                return Some(id.to_string());
            }
        }
    }

    None
}

fn normalize_youtube_url(url: &str) -> String {
    let mut url = url.to_string();

    // Remove si= parameter and anything after it
    if let Some(pos) = url.find("?si=") {
        url.truncate(pos);
    }
    if let Some(pos) = url.find("&si=") {
        url.truncate(pos);
    }

    // Convert shorts URL to watch?v= format (most reliable)
    if url.contains("/shorts/") {
        if let Some(id_start) = url.rfind("/shorts/") {
            let id_part = &url[id_start + 8..];
            let id_end = id_part.find(&['?', '&', '#'][..]).unwrap_or(id_part.len());
            let video_id = &id_part[..id_end];
            if video_id.len() >= 11 {
                return format!("https://www.youtube.com/watch?v={}", &video_id[..11]);
            }
        }
    }

    // Convert youtu.be links
    if url.contains("youtu.be/") {
        if let Some(id_start) = url.rfind("youtu.be/") {
            let id_part = &url[id_start + 9..];
            let id_end = id_part.find(&['?', '&', '#'][..]).unwrap_or(id_part.len());
            let video_id = &id_part[..id_end];
            if video_id.len() >= 11 {
                return format!("https://www.youtube.com/watch?v={}", &video_id[..11]);
            }
        }
    }

    // Already in good format → return as-is
    url
}

// ──────────────────────────────────────────────────────────────
// WAV → f32 samples (16kHz mono expected)
// ──────────────────────────────────────────────────────────────
fn wav_bytes_to_f32_samples(wav_bytes: &[u8]) -> Result<Vec<f32>, String> {
    let cursor = Cursor::new(wav_bytes);
    let mut reader =
        hound::WavReader::new(cursor).map_err(|e| format!("Invalid WAV format: {}", e))?;

    let spec = reader.spec();

    if spec.channels != 1 {
        return Err(format!("Expected mono, found {} channels", spec.channels));
    }
    if spec.sample_rate != 16000 {
        return Err(format!("Expected 16kHz, found {}", spec.sample_rate));
    }
    if spec.bits_per_sample != 16 || spec.sample_format != hound::SampleFormat::Int {
        return Err("Expected 16-bit signed integer PCM".to_string());
    }

    let samples: Vec<f32> = reader
        .samples::<i16>()
        .map(|s| s.unwrap_or(0) as f32 / 32768.0)
        .collect();

    Ok(samples)
}

//
//  DIARIZATION — Parakeet-rs + NVIDIA Sortformer v2.1
//

use once_cell::sync::Lazy;
use parakeet_rs::{
    ExecutionConfig as ParakeetExecutionConfig,
    ExecutionProvider as ParakeetExecutionProvider,
    ParakeetTDT, TimestampMode as ParakeetTimestampMode, Transcriber as ParakeetTranscriber,
};
use parakeet_rs::sortformer::{
    DiarizationConfig, Sortformer, SpeakerSegment as ParakeetSpeakerSegment,
};
use std::sync::{Arc, Mutex};

// Keep the same output format for frontend compatibility
#[derive(serde::Serialize)]
struct DiarizedSegment {
    start_ms: i64,
    end_ms: i64,
    speaker: String, // "SPEAKER_00", "SPEAKER_01", ...
}

fn normalize_diarized_segments(mut segments: Vec<DiarizedSegment>) -> Vec<DiarizedSegment> {
    segments.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then_with(|| a.end_ms.cmp(&b.end_ms))
    });

    let mut normalized: Vec<DiarizedSegment> = Vec::new();

    for mut seg in segments {
        if seg.end_ms <= seg.start_ms {
            continue;
        }

        if let Some(last) = normalized.last_mut() {
            // Enforce monotonic, non-overlapping turns for frontend timeline consistency.
            if seg.start_ms < last.end_ms {
                if seg.end_ms <= last.end_ms {
                    continue;
                }
                seg.start_ms = last.end_ms;
            }

            // Merge tiny gaps from the same speaker to reduce fragmentation.
            if seg.speaker == last.speaker && seg.start_ms - last.end_ms <= 80 {
                last.end_ms = last.end_ms.max(seg.end_ms);
                continue;
            }
        }

        if seg.end_ms > seg.start_ms {
            normalized.push(seg);
        }
    }

    normalized
}

// Global lazy-initialized diarizer
static DIARIZER: Lazy<Arc<Mutex<Option<Sortformer>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

// Current selected diarization model (default value)
static CURRENT_DIAR_MODEL: Lazy<Arc<Mutex<String>>> = Lazy::new(|| {
    Arc::new(Mutex::new(
        "diar_streaming_sortformer_4spk-v2.1.onnx".to_string(),
    ))
});

// Prevent concurrent heavy dubbing synthesis jobs from exhausting GPU memory.
static QWEN_SYNTH_LOCK: Lazy<Arc<TokioMutex<()>>> = Lazy::new(|| Arc::new(TokioMutex::new(())));
static QWEN_DUBBINGS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static CANCELLED_QWEN_TASKS: Lazy<Arc<TokioMutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(TokioMutex::new(HashSet::new())));
// Track running child PIDs and generated temporary files per task for hard cancellation cleanup.
static QWEN_TASK_CHILD_PIDS: Lazy<Arc<TokioMutex<HashMap<String, HashSet<u32>>>>> =
    Lazy::new(|| Arc::new(TokioMutex::new(HashMap::new())));
static QWEN_TASK_PARTIAL_FILES: Lazy<Arc<TokioMutex<HashMap<String, HashSet<PathBuf>>>>> =
    Lazy::new(|| Arc::new(TokioMutex::new(HashMap::new())));

#[tauri::command]
fn set_active_diar_model(model_name: String) -> Result<(), String> {
    if model_name.is_empty() || !model_name.ends_with(".onnx") {
        return Err("Invalid model name".to_string());
    }

    let mut guard = CURRENT_DIAR_MODEL.lock().unwrap();
    *guard = model_name.clone();
    println!("[DIAR] Active diarization model changed → {}", model_name);

    // Force next diarization to reload the model
    let mut diar_guard = DIARIZER.lock().unwrap();
    *diar_guard = None;

    Ok(())
}

fn get_diar_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Cannot get app local data dir: {}", e))?;

    dir.push("diarization_models");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create diarization models dir: {}", e))?;

    Ok(dir)
}

async fn ensure_sortformer_model(app: AppHandle) -> Result<PathBuf, String> {
    let models_dir = get_diar_models_dir(&app)?;
    let model_name = "diar_streaming_sortformer_4spk-v2.1.onnx";
    let target_path = models_dir.join(model_name);

    if target_path.exists() {
        return Ok(target_path);
    }

    let url = format!(
        "https://huggingface.co/altunenes/parakeet-rs/resolve/main/{}",
        model_name
    );

    println!("[DIAR] Downloading Sortformer v2.1 from: {}", url);

    let client = reqwest::Client::builder()
        .user_agent("SpeakShift-Tauri/0.1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to start model download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "HTTP error downloading model: {}",
            response.status()
        ));
    }

    let mut file = tokio::fs::File::create(&target_path)
        .await
        .map_err(|e| format!("Cannot create model file: {}", e))?;

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }

    let size = target_path.metadata().map(|m| m.len()).unwrap_or(0);
    println!("[DIAR] Model downloaded: {} bytes", size);

    Ok(target_path)
}

// Helper: Load audio file → Vec<f32> at 16kHz (mono expected)
fn load_audio_to_f32_samples(path: &str) -> Result<Vec<f32>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open audio file: {}", e))?;
    let reader = BufReader::new(file);
    let mut wav_reader =
        WavReader::new(reader).map_err(|e| format!("Invalid WAV format: {}", e))?;

    let spec = wav_reader.spec();

    if spec.channels != 1 {
        return Err(format!(
            "Expected mono audio, found {} channels",
            spec.channels
        ));
    }
    if spec.sample_rate != 16000 {
        return Err(format!(
            "Expected 16kHz sample rate, found {}",
            spec.sample_rate
        ));
    }
    let samples: Vec<f32> = match spec.sample_format {
        SampleFormat::Int => wav_reader
            .samples::<i16>()
            .map(|s: Result<i16, hound::Error>| s.unwrap_or(0) as f32 / 32768.0f32)
            .collect(),
        SampleFormat::Float => wav_reader
            .samples::<f32>()
            .map(|s: Result<f32, hound::Error>| s.unwrap_or(0.0))
            .collect(),
        _ => return Err("Unsupported sample format (need i16 or f32)".to_string()),
    };

    Ok(samples)
}

#[tauri::command]
async fn diarize_speakers(
    app: AppHandle,
    audio_path: String,
) -> Result<Vec<DiarizedSegment>, String> {
    ensure_feature_unlocked(&app, "Diarization")?;
    println!("[DIARIZE] Starting on: {}", audio_path);

    // Get current model name
    let model_name = {
        let guard = CURRENT_DIAR_MODEL.lock().unwrap();
        guard.clone()
    };

    let model_path_str = ensure_diarization_model(app.clone(), model_name.clone()).await?;
    let model_path = PathBuf::from(model_path_str);

    println!("[DIAR] Model path: {}", model_path.display());

    // 2. Lazy init / re-init diarizer if needed
    let mut guard = DIARIZER.lock().unwrap();
    if guard.is_none() {
        let config = DiarizationConfig::default();

        println!("[DIAR] Loading model: {}", model_name);

        let mut used_provider = "CPU".to_string();
        let mut provider_details = "CPU (default)".to_string();

        // ──────────────────────────────────────────────────────────────
        // Try to initialize with GPU if enabled, fallback to CPU
        // ──────────────────────────────────────────────────────────────

        let sortformer = if cfg!(feature = "cuda") {
            println!("[DIAR] Attempting CUDA (NVIDIA GPU) ...");

            match Sortformer::with_config(
                model_path.to_str().ok_or("Model path not UTF-8")?,
                None,
                config.clone(),
            ) {
                Ok(model) => {
                    used_provider = "CUDA".to_string();
                    provider_details = "NVIDIA GPU (CUDA) initialized successfully".to_string();
                    println!("[DIAR] → CUDA initialized successfully");
                    model
                }
                Err(e) => {
                    println!("[DIAR] → CUDA failed: {}", e);
                    println!("[DIAR] Falling back to CPU ...");

                    Sortformer::with_config(
                        model_path.to_str().ok_or("Model path not UTF-8")?,
                        None,
                        config.clone(),
                    )
                    .map_err(|e| format!("CPU fallback after CUDA failed: {}", e))?
                }
            }
        } else if cfg!(feature = "directml") {
            println!("[DIAR] Attempting DirectML (Windows GPU) ...");

            match Sortformer::with_config(
                model_path.to_str().ok_or("Model path not UTF-8")?,
                None,
                config.clone(),
            ) {
                Ok(model) => {
                    used_provider = "DirectML".to_string();
                    provider_details =
                        "Windows GPU (DirectML) initialized successfully".to_string();
                    println!("[DIAR] → DirectML initialized successfully");
                    model
                }
                Err(e) => {
                    println!("[DIAR] → DirectML failed: {}", e);
                    println!("[DIAR] Falling back to CPU ...");

                    Sortformer::with_config(
                        model_path.to_str().ok_or("Model path not UTF-8")?,
                        None,
                        config.clone(),
                    )
                    .map_err(|e| format!("CPU fallback after DirectML failed: {}", e))?
                }
            }
        } else {
            // No GPU support compiled in
            println!("[DIAR] Using CPU (no GPU features enabled at compile time)");
            Sortformer::with_config(
                model_path.to_str().ok_or("Model path not UTF-8")?,
                None,
                config,
            )
            .map_err(|e| format!("CPU initialization failed: {}", e))?
        };

        // Final initialization summary
        println!(
            "[DIAR] Sortformer initialized → Provider: {} | Details: {}",
            used_provider, provider_details
        );

        *guard = Some(sortformer);
    }

    let diarizer = guard.as_mut().unwrap();

    println!("[DIAR] Loading audio file...");
    let audio_samples = load_audio_to_f32_samples(&audio_path)
        .map_err(|e| format!("Failed to load audio: {}", e))?;

    println!("[DIAR] Audio loaded ({} samples)", audio_samples.len());

    println!("[DIAR] Starting speaker diarization...");
    let segments = diarizer
        .diarize(audio_samples, 16000, 1)
        .map_err(|e| format!("Diarization failed: {}", e))?;

    let raw_result: Vec<DiarizedSegment> = segments
        .into_iter()
        .map(|seg: ParakeetSpeakerSegment| DiarizedSegment {
            start_ms: (seg.start * 1000.0) as i64,
            end_ms: (seg.end * 1000.0) as i64,
            speaker: format!("SPEAKER_{:02}", seg.speaker_id),
        })
        .collect();

    let result = normalize_diarized_segments(raw_result);

    println!("[DIARIZE] Found {} speaker turns", result.len());

    Ok(result)
}

#[tauri::command]
fn list_downloaded_diar_models(app: AppHandle) -> Result<Vec<String>, String> {
    let models_dir = get_diar_models_dir(&app)?;

    let entries = fs::read_dir(&models_dir)
        .map_err(|e| format!("Cannot read diarization models dir: {}", e))?;

    let mut models = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                if file_name.ends_with(".onnx") {
                    models.push(file_name.to_string());
                }
            }
        }
    }

    Ok(models)
}

#[tauri::command]
async fn ensure_diarization_model(app: AppHandle, model_name: String) -> Result<String, String> {
    if model_name.is_empty() || !model_name.ends_with(".onnx") {
        return Err("Invalid model name".to_string());
    }

    let models_dir = get_diar_models_dir(&app)?;
    let target_path = models_dir.join(&model_name);

    if target_path.exists() {
        return Ok(target_path.to_string_lossy().into_owned());
    }

    let url = format!(
        "https://huggingface.co/altunenes/parakeet-rs/resolve/main/{}",
        model_name
    );

    println!("[DIAR] Downloading model: {} from {}", model_name, url);

    let client = Client::builder()
        .user_agent("SpeakShift-Tauri/0.1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "HTTP error {} when downloading {}",
            response.status(),
            model_name
        ));
    }

    // ──── Very important change ────
    let mut file = TokioFile::create(&target_path)
        .await
        .map_err(|e| format!("Cannot create file {}: {}", model_name, e))?;

    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded = 0u64;

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        downloaded += chunk.len() as u64;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error for {}: {}", model_name, e))?;

        if total_size > 0 {
            let percent = (downloaded as f64 / total_size as f64 * 100.0) as u32;
            // This should now work after adding use tauri::Manager;
            let _ = app.emit(
                "download-diar-model-progress",
                serde_json::json!({
                    "model": model_name,
                    "percentage": percent
                }),
            );
        }
    }

    let size = target_path.metadata().map(|m| m.len()).unwrap_or(0);
    println!("[DIAR] Downloaded {} ({} bytes)", model_name, size);

    Ok(target_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn delete_diarization_model(app: AppHandle, model_name: String) -> Result<(), String> {
    if model_name.is_empty() || !model_name.ends_with(".onnx") {
        return Err("Invalid model name".to_string());
    }

    let models_dir = get_diar_models_dir(&app)?;
    let target_path = models_dir.join(&model_name);

    if !target_path.exists() {
        return Err(format!("Model {} not found", model_name));
    }

    if !target_path.is_file() {
        return Err(format!("{} is not a file", model_name));
    }

    fs::remove_file(&target_path).map_err(|e| format!("Failed to delete {}: {}", model_name, e))?;

    println!("[DIAR] Deleted model: {}", model_name);

    Ok(())
}

#[tauri::command]
async fn serve_audio_file(path: String) -> Result<String, String> {
    use std::fs::File;
    use std::io::Read;

    fn decode_percent(input: &str) -> String {
        let bytes = input.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;

        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let hi = bytes[i + 1] as char;
                let lo = bytes[i + 2] as char;
                if let (Some(h), Some(l)) = (hi.to_digit(16), lo.to_digit(16)) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
            }

            out.push(bytes[i]);
            i += 1;
        }

        String::from_utf8_lossy(&out).into_owned()
    }

    fn strip_wrapping_quotes(input: &str) -> &str {
        let trimmed = input.trim();
        if trimmed.len() >= 2 {
            let first = trimmed.as_bytes()[0];
            let last = trimmed.as_bytes()[trimmed.len() - 1];
            if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
                return &trimmed[1..trimmed.len() - 1];
            }
        }
        trimmed
    }

    let raw_path = strip_wrapping_quotes(&path).to_string();

    // Already-servable URL formats should be passed through.
    if raw_path.starts_with("data:")
        || raw_path.starts_with("blob:")
        || raw_path.starts_with("http://")
        || raw_path.starts_with("https://")
    {
        return Ok(raw_path);
    }

    let mut candidate = if let Some(raw) = raw_path.strip_prefix("file://") {
        raw.to_string()
    } else {
        raw_path.clone()
    };

    candidate = decode_percent(&candidate);

    // Windows file URI may begin with /C:/...
    if cfg!(target_os = "windows")
        && candidate.len() > 3
        && candidate.as_bytes()[0] == b'/'
        && candidate.as_bytes()[2] == b':'
        && (candidate.as_bytes()[1] as char).is_ascii_alphabetic()
    {
        candidate = candidate[1..].to_string();
    }

    let mut tried_paths = Vec::new();
    let mut resolved_path = candidate.clone();

    let path_variants = [
        candidate.clone(),
        candidate.replace('/', "\\"),
        candidate.replace('\\', "/"),
    ];

    let mut found = false;
    for variant in path_variants {
        if variant.is_empty() {
            continue;
        }
        tried_paths.push(variant.clone());
        if std::path::Path::new(&variant).exists() {
            resolved_path = variant;
            found = true;
            break;
        }
    }

    if !found {
        return Err(format!(
            "Audio file not found. input='{}', normalized='{}', tried={:?}",
            path, candidate, tried_paths
        ));
    }

    let mut file = File::open(&resolved_path)
        .map_err(|e| format!("Failed to open audio file '{}': {}", resolved_path, e))?;

    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)
        .map_err(|e| format!("Failed to read audio file: {}", e))?;

    // Return the file as a base64 data URL (safe for browser)
    let lower = resolved_path.to_lowercase();
    let mime = if lower.ends_with(".wav") {
        "audio/wav"
    } else if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".webm") {
        "audio/webm"
    } else if lower.ends_with(".ogg") {
        "audio/ogg"
    } else if lower.ends_with(".m4a") {
        "audio/mp4"
    } else {
        "audio/wav" // fallback
    };

    // let base64 = base64::encode(&buffer);
    let base64 = base64::engine::general_purpose::STANDARD.encode(&buffer);
    let data_url = format!("data:{};base64,{}", mime, base64);

    Ok(data_url)
}

#[tauri::command]
async fn save_temp_audio(app: AppHandle, blob: Vec<u8>) -> Result<String, String> {
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::PathBuf;
    use uuid::Uuid;

    // 1. Get the app-local-data directory (cross-platform, e.g. %LOCALAPPDATA%\com.speakShift.app on Windows)
    let mut dir: PathBuf = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get app local data dir: {}", e))?;

    // 2. Create subfolder "Recorded_audio" if it doesn't exist
    dir.push("Recorded_audio");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create Recorded_audio dir: {}", e))?;

    // 3. Generate unique filename with .webm extension (since your blob is webm/opus)
    let filename = format!("recording-{}.webm", Uuid::new_v4());
    let full_path = dir.join(filename);

    // 4. Write the blob
    let mut file = File::create(&full_path).map_err(|e| format!("Failed to create file: {}", e))?;

    file.write_all(&blob)
        .map_err(|e| format!("Failed to write audio data: {}", e))?;

    let path_str = full_path
        .to_str()
        .ok_or_else(|| "Path is not valid UTF-8".to_string())?
        .to_string();

    println!("[RECORD] Saved persistent audio to: {}", path_str);

    Ok(path_str)
}

#[tauri::command]
async fn normalize_audio_for_preview(app: AppHandle, input_path: String) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(format!("Input file not found: {}", input_path));
    }

    let ffmpeg_bin = get_ffmpeg_path(&app)?;

    let mut output_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get app local data dir: {}", e))?;
    output_dir.push("voice_previews");
    fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create voice_previews dir: {}", e))?;

    let output_path = output_dir.join(format!("voice_preview_{}.wav", Uuid::new_v4()));

    let ffmpeg_output = TokioCommand::new(&ffmpeg_bin)
        .arg("-y")
        .arg("-i")
        .arg(&input_path)
        .arg("-af")
        .arg("loudnorm=I=-15:TP=-1.5:LRA=11")
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output_path.to_string_lossy().to_string())
        .output()
        .await
        .map_err(|e| format!("Failed to run ffmpeg for preview normalization: {}", e))?;

    if !ffmpeg_output.status.success() {
        return Err(format!(
            "ffmpeg normalize failed: {}",
            String::from_utf8_lossy(&ffmpeg_output.stderr)
        ));
    }

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn transcribe_recording(
    app: AppHandle,
    webm_path: String,
    model_name: String,
    language: Option<String>,
    translate_to_english: bool,
) -> Result<String, String> {
    println!("[RECORD] Starting transcription for: {}", webm_path);

    let parent_dir = std::path::Path::new(&webm_path)
        .parent()
        .ok_or("Invalid webm path – no parent directory")?
        .to_path_buf();

    let wav_filename = format!("converted-{}.wav", uuid::Uuid::new_v4());
    let wav_path = parent_dir.join(wav_filename);
    let wav_path_str = wav_path.to_string_lossy().to_string();

    println!("[RECORD] Converting to persistent WAV: {}", wav_path_str);

    let ffmpeg_path = get_ffmpeg_path(&app)?;

    let output = tokio::process::Command::new(&ffmpeg_path)
        .args([
            "-y",
            "-i",
            &webm_path,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_f32le",
            &wav_path_str,
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed to start: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let err_msg = format!("ffmpeg conversion failed:\n{}", stderr);

        // Emit error event
        let _ = app.emit(
            "transcription-completed",
            json!({
                "error": err_msg,
                "sourceType": "recording",
                "sourcePath": webm_path,
            }),
        );

        return Err(err_msg);
    }

    println!("[RECORD] ffmpeg conversion succeeded → {}", wav_path_str);

    println!("[RECORD] Delegating to transcribe_wav: {}", wav_path_str);

    let transcription_result =
        match transcribe_wav(app.clone(), wav_path_str.clone(), model_name, language).await {
            Ok(result) => result,
            Err(e) => {
                let err_msg = format!("transcribe_wav failed: {}", e);

                // Emit error
                let _ = app.emit(
                    "transcription-completed",
                    json!({
                        "error": err_msg,
                        "sourceType": "recording",
                        "sourcePath": webm_path,
                    }),
                );

                return Err(err_msg);
            }
        };

    // Success emit
    let emit_payload = json!({
        "audioPath": transcription_result.audio_path,
        "segments": transcription_result.segments,
        "fullText": transcription_result.full_text,
        "detectedLanguage": transcription_result.detected_language,
        "sourceType": "recording",
        "sourcePath": webm_path,
    });

    println!("[RECORD] Emitting transcription-completed event");
    let _ = app.emit("transcription-completed", emit_payload);

    // Cleanup
    let _ = std::fs::remove_file(&wav_path);
    println!("[RECORD] Removed converted WAV");

    Ok("Transcription completed".to_string())
}

// ──────────────────────────────────────────────────────────────
// Struct for all command arguments with defaults
// ──────────────────────────────────────────────────────────────
#[derive(Deserialize)]
struct ProcessFfmpegArgs {
    input_bytes: Vec<u8>,
    output_type: String, // "video" | "audio"
    format: String,      // mp4, webm, mov, gif, mp3, wav, aac
    #[serde(default = "default_quality")]
    quality: String, // high | medium | low
    #[serde(default = "default_resolution")]
    resolution: String, // original | 1080p | 720p | 480p
    #[serde(default = "default_aspect_ratio")]
    aspect_ratio: String, // original | 9:16 | 1:1 | 16:9
    #[serde(default)]
    brightness: f64, // -1.0 .. 1.0
    #[serde(default = "default_contrast")]
    contrast: f64, // 0.0 .. 2.0
    #[serde(default = "default_saturation")]
    saturation: f64, // 0.0 .. 2.0
    #[serde(default = "default_volume")]
    volume: f64, // 0.0 .. 2.0
    #[serde(default)]
    denoise: bool,
    #[serde(default)]
    dehummer: bool,
    #[serde(default = "default_color_filter")]
    color_filter: String, // none | grayscale | sepia | vignette
}

// Default value functions
fn default_quality() -> String {
    "medium".to_string()
}
fn default_resolution() -> String {
    "original".to_string()
}
fn default_aspect_ratio() -> String {
    "original".to_string()
}
fn default_contrast() -> f64 {
    1.0
}
fn default_saturation() -> f64 {
    1.0
}
fn default_volume() -> f64 {
    1.0
}
fn default_color_filter() -> String {
    "none".to_string()
}

// ──────────────────────────────────────────────────────────────
// The actual command
// ──────────────────────────────────────────────────────────────
#[tauri::command]
async fn process_ffmpeg(app: AppHandle, payload: ProcessFfmpegArgs) -> Result<String, String> {
    let ProcessFfmpegArgs {
        input_bytes,
        output_type,
        format,
        quality,
        resolution,
        aspect_ratio,
        brightness,
        contrast,
        saturation,
        volume,
        denoise,
        dehummer,
        color_filter,
    } = payload;

    // 1. Create temp directory
    let mut dir: PathBuf = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Cannot get app data dir: {}", e))?;
    dir.push("temp_ffmpeg");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create temp_ffmpeg dir: {}", e))?;

    // 2. Save input file
    let input_filename = format!("input-{}.tmp", Uuid::new_v4());
    let input_path = dir.join(&input_filename);
    fs::write(&input_path, &input_bytes)
        .map_err(|e| format!("Failed to write input file: {}", e))?;

    let output_filename = format!("output-{}.{}", Uuid::new_v4(), format);
    let output_path = dir.join(&output_filename);
    let output_path_str = output_path.to_string_lossy().to_string();

    // 3. Get FFmpeg binary path
    let ffmpeg_bin = get_ffmpeg_path(&app)?;

    // 4. Get duration with ffprobe for accurate progress
    let ffprobe_output = Command::new(&ffmpeg_bin)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            input_path.to_str().unwrap(),
        ])
        .output()
        .map_err(|e| format!("ffprobe failed: {}", e))?;

    let duration_str = String::from_utf8_lossy(&ffprobe_output.stdout)
        .trim()
        .to_string();
    let total_duration: f64 = duration_str.parse().unwrap_or(0.0);

    // 5. Build FFmpeg arguments
    let mut args: Vec<String> = vec![
        "-y".to_string(),
        "-i".to_string(),
        input_path.to_string_lossy().into(),
    ];

    let mut vf: Vec<String> = Vec::new();
    let mut af: Vec<String> = Vec::new();

    // ── Visual Filters ──
    // Color adjustments
    if brightness != 0.0 || contrast != 1.0 || saturation != 1.0 {
        vf.push(format!(
            "eq=brightness={}:contrast={}:saturation={}",
            brightness, contrast, saturation
        ));
    }

    // Color profiles
    match color_filter.as_str() {
        "grayscale" => vf.push("format=gray".to_string()),
        "sepia" => vf
            .push("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131".to_string()),
        "vignette" => vf.push("vignette=PI/4".to_string()),
        _ => {}
    }

    // Resolution scaling
    if resolution != "original" {
        let res = match resolution.as_str() {
            "1080p" => "1920:1080",
            "720p" => "1280:720",
            "480p" => "854:480",
            _ => "1920:1080",
        };
        vf.push(format!(
            "scale={}:force_original_aspect_ratio=decrease,pad={}: (ow-iw)/2:(oh-ih)/2",
            res, res
        ));
    }

    // Aspect Ratio / Crop
    if aspect_ratio != "original" {
        let ratio = match aspect_ratio.as_str() {
            "9:16" => "9/16",
            "1:1" => "1/1",
            "16:9" => "16/9",
            _ => "iw/ih",
        };
        vf.push(format!("crop=ih*({}):ih", ratio));
    }

    // ── Audio Filters ──
    if volume != 1.0 {
        af.push(format!("volume={}", volume));
    }
    if denoise {
        af.push("afftdn=nr=12:nf=-30".to_string()); // stronger noise reduction
    }
    if dehummer {
        af.push("highpass=f=120,lowpass=f=3000".to_string());
    }

    if !vf.is_empty() {
        args.push("-vf".to_string());
        args.push(vf.join(","));
    }
    if !af.is_empty() {
        args.push("-af".to_string());
        args.push(af.join(","));
    }

    // ── Codec & Quality ──
    if output_type == "audio" {
        args.push("-vn".to_string()); // no video
        match format.as_str() {
            "mp3" => {
                args.extend([
                    "-c:a".to_string(),
                    "libmp3lame".to_string(),
                    "-q:a".to_string(),
                    if quality == "high" {
                        "0"
                    } else if quality == "medium" {
                        "2"
                    } else {
                        "5"
                    }
                    .to_string(),
                ]);
            }
            "wav" => {
                args.extend(["-c:a".to_string(), "pcm_s16le".to_string()]);
            }
            "aac" => {
                args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    if quality == "high" {
                        "192k"
                    } else if quality == "medium" {
                        "128k"
                    } else {
                        "96k"
                    }
                    .to_string(),
                ]);
            }
            _ => return Err(format!("Unsupported audio format: {}", format)),
        }
    } else {
        // Video
        match format.as_str() {
            "mp4" => {
                args.extend([
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    if quality == "high" { "slow" } else { "fast" }.to_string(),
                ]);
                let crf = if quality == "high" {
                    "18"
                } else if quality == "medium" {
                    "23"
                } else {
                    "28"
                };
                args.extend(["-crf".to_string(), crf.to_string()]);
            }
            "webm" => {
                args.extend([
                    "-c:v".to_string(),
                    "libvpx-vp9".to_string(),
                    "-b:v".to_string(),
                    if quality == "high" {
                        "2M"
                    } else if quality == "medium" {
                        "1M"
                    } else {
                        "500k"
                    }
                    .to_string(),
                ]);
            }
            "mov" => {
                args.extend([
                    "-c:v".to_string(),
                    "prores_ks".to_string(),
                    "-profile:v".to_string(),
                    "3".to_string(), // HQ profile
                ]);
            }
            "gif" => {
                vf.push("fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse".to_string());
                args.push("-vf".to_string());
                args.push(vf.join(","));
            }
            _ => return Err(format!("Unsupported video format: {}", format)),
        }
    }

    args.push(output_path_str.clone());

    // 6. Run FFmpeg + progress parsing
    let mut child = Command::new(&ffmpeg_bin)
        .args(&args)
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("FFmpeg spawn failed: {}", e))?;

    if let Some(mut stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let output = String::from_utf8_lossy(&buf[0..n]);
                        if let Some(time_pos) = output.find("time=") {
                            let time_str = &output[time_pos + 5..time_pos + 16];
                            let parts: Vec<&str> = time_str.split(':').collect();
                            if parts.len() == 3 {
                                let h: f64 = parts[0].parse().unwrap_or(0.0);
                                let m: f64 = parts[1].parse().unwrap_or(0.0);
                                let s: f64 = parts[2].parse().unwrap_or(0.0);
                                let current_time = h * 3600.0 + m * 60.0 + s;
                                let progress = if total_duration > 0.0 {
                                    (current_time / total_duration * 100.0) as u32
                                } else {
                                    0
                                };
                                let _ = app_clone
                                    .emit("ffmpeg-progress", json!({"progress": progress}));
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("FFmpeg wait failed: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg failed:\n{}", err.trim()));
    }

    // 7. Cleanup input file (keep output for preview/download)
    let _ = fs::remove_file(&input_path);

    Ok(output_path_str)
}

use tauri_plugin_dialog::{DialogExt, FilePath};

#[tauri::command]
async fn save_processed_file(app: AppHandle, path: String, filename: String) -> Result<(), String> {
    // Read the processed file bytes
    let bytes =
        std::fs::read(&path).map_err(|e| format!("Failed to read processed file: {}", e))?;

    let extension = filename.split('.').last().unwrap_or("mp4").to_string();

    // Create the dialog builder
    let builder = app
        .dialog()
        .file()
        .set_title("Save Processed File As...")
        .set_file_name(&filename)
        .add_filter("Video / Audio", &[&extension])
        .add_filter("All Files", &["*"]);

    // Use oneshot channel to await the callback result
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();

    builder.save_file(move |path_opt: Option<FilePath>| {
        let _ = tx.send(path_opt);
    });

    // Await the result and safely unwrap the Option<FilePath>
    let file_path = rx
        .await
        .map_err(|_| "Failed to receive dialog result".to_string())?
        .ok_or_else(|| "User cancelled save".to_string())?;

    // Correct conversion using into_path()
    let target_path = file_path
        .into_path()
        .map_err(|_| "Invalid file path".to_string())?;

    // Now write the bytes
    std::fs::write(&target_path, &bytes).map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn get_processed_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(bytes)
}

// ──────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────
// Parameters for live preview (same values as in process_ffmpeg)
// ──────────────────────────────────────────────────────────────
#[derive(Deserialize)]
struct PreviewParams {
    brightness: f64,
    contrast: f64,
    saturation: f64,
    color_filter: String, // "none" | "grayscale" | "sepia" | "vignette"
                          // You can add more later (volume, denoise, etc.) if you want audio preview too
}

// ──────────────────────────────────────────────────────────────
// Returns raw bytes of the filtered preview clip
// ──────────────────────────────────────────────────────────────
#[tauri::command]
async fn create_video_preview(
    app: AppHandle,
    input_bytes: Vec<u8>,
    params: PreviewParams,
) -> Result<Vec<u8>, String> {
    let previews_dir: PathBuf = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Cannot get app data dir: {}", e))?
        .join("previews");

    fs::create_dir_all(&previews_dir).map_err(|e| format!("Cannot create previews dir: {}", e))?;

    let input_temp = previews_dir.join(format!("input-{}", Uuid::new_v4().simple()));
    fs::write(&input_temp, &input_bytes)
        .map_err(|e| format!("Failed to write temp input: {}", e))?;

    let preview_id = Uuid::new_v4().simple().to_string();
    let output_filename = format!("preview-{}.webm", preview_id);
    let output_path = previews_dir.join(&output_filename);

    let ffmpeg_bin = get_ffmpeg_path(&app)?;

    let mut vf: Vec<String> = Vec::new();

    if params.brightness != 0.0 || params.contrast != 1.0 || params.saturation != 1.0 {
        vf.push(format!(
            "eq=brightness={}:contrast={}:saturation={}",
            params.brightness, params.contrast, params.saturation
        ));
    }

    match params.color_filter.as_str() {
        "grayscale" => vf.push("format=gray".to_string()),
        "sepia" => vf
            .push("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131".to_string()),
        "vignette" => vf.push("vignette=PI/4".to_string()),
        _ => {}
    }

    vf.push("scale=640:-2".to_string());
    vf.push("fps=15".to_string());
    vf.push("format=yuv420p".to_string());

    let vf_filter = vf.join(",");

    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        input_temp.to_string_lossy().into(),
        "-t".to_string(),
        "5".to_string(),
        "-vf".to_string(),
        vf_filter.clone(),
        "-c:v".to_string(),
        "h264_nvenc".to_string(), // Try NVIDIA GPU first
        "-preset".to_string(),
        "p4".to_string(),
        "-b:v".to_string(),
        "2M".to_string(),
        "-an".to_string(),
        "-f".to_string(),
        "webm".to_string(),
        output_path.to_string_lossy().into(),
    ];

    let output = Command::new(&ffmpeg_bin).args(&args).output();

    let preview_bytes = match output {
        Ok(o) if o.status.success() => {
            eprintln!("[PREVIEW] Used GPU (h264_nvenc)");
            fs::read(&output_path).map_err(|e| format!("Failed to read preview: {}", e))?
        }
        _ => {
            eprintln!("[PREVIEW] NVENC unavailable → fallback to VP9");
            let mut fallback_args = vec![
                "-y".to_string(),
                "-i".to_string(),
                input_temp.to_string_lossy().into(),
                "-t".to_string(),
                "5".to_string(),
                "-vf".to_string(),
                vf_filter,
                "-c:v".to_string(),
                "libvpx-vp9".to_string(),
                "-b:v".to_string(),
                "1M".to_string(),
                "-cpu-used".to_string(),
                "4".to_string(),
                "-row-mt".to_string(),
                "1".to_string(),
                "-tile-columns".to_string(),
                "2".to_string(),
                "-frame-parallel".to_string(),
                "1".to_string(),
                "-an".to_string(),
                "-f".to_string(),
                "webm".to_string(),
                output_path.to_string_lossy().into(),
            ];

            let fallback = Command::new(&ffmpeg_bin)
                .args(&fallback_args)
                .output()
                .map_err(|e| format!("FFmpeg fallback failed: {}", e))?;

            if !fallback.status.success() {
                let err = String::from_utf8_lossy(&fallback.stderr);
                return Err(format!("Preview failed:\n{}", err.trim()));
            }

            fs::read(&output_path).map_err(|e| format!("Failed to read preview: {}", e))?
        }
    };

    let _ = fs::remove_file(&input_temp);
    let _ = fs::remove_file(&output_path);

    Ok(preview_bytes)
}

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta.len())
}

// ──────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────
// translations.rs
// ──────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────
// translations.rs

use anyhow::{Context, Result as AnyResult};
use serde::Serialize;
use tokio::fs::File;

#[derive(Debug, Serialize, Deserialize)]
pub struct NllbModelInfo {
    pub folder_name: String,
    pub path: String,
    pub exists: bool,
    pub size_mb: Option<f64>,
    pub is_active: bool,
}

// Global state: currently selected model folder name
static CURRENT_MODEL_FOLDER: Lazy<Arc<Mutex<String>>> =
    Lazy::new(|| Arc::new(Mutex::new("int8_float16".to_string())));

fn get_nllb_models_dir(app: &AppHandle) -> AnyResult<PathBuf> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .context("Cannot get app local data dir")?;

    dir.push("nllb_models");
    std::fs::create_dir_all(&dir)?;

    Ok(dir)
}

fn get_model_folder_path(app: &AppHandle, folder_name: &str) -> PathBuf {
    let mut base = get_nllb_models_dir(app).unwrap_or_default();
    base.push(folder_name);
    base
}

fn model_exists(path: &Path) -> bool {
    path.join("model.bin").exists() && path.join("tokenizer.json").exists()
}

fn approximate_folder_size_mb(path: &Path) -> Option<f64> {
    if !path.is_dir() {
        return None;
    }
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    total = total.saturating_add(metadata.len());
                }
            }
        }
    }
    if total == 0 {
        None
    } else {
        Some(total as f64 / 1_048_576.0) // bytes → MB
    }
}

// ──────────────────────────────────────────────────────────────
// Model listing with active status
// ──────────────────────────────────────────────────────────────

#[tauri::command]
fn list_downloaded_nllb_models(app: AppHandle) -> Result<Vec<NllbModelInfo>, String> {
    let dir = get_nllb_models_dir(&app).map_err(|e| e.to_string())?;
    let active = CURRENT_MODEL_FOLDER.lock().unwrap().clone();

    let mut models = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    let name_str = name.to_string();
                    let exists = model_exists(&path);
                    let size_mb = if exists {
                        approximate_folder_size_mb(&path)
                    } else {
                        None
                    };

                    models.push(NllbModelInfo {
                        folder_name: name_str.clone(),
                        path: path.to_string_lossy().into_owned(),
                        exists,
                        size_mb,
                        is_active: name_str == active,
                    });
                }
            }
        }
    }

    models.sort_by(|a, b| a.folder_name.cmp(&b.folder_name));
    Ok(models)
}

// ──────────────────────────────────────────────────────────────
// Active model management
// ──────────────────────────────────────────────────────────────

#[tauri::command]
fn set_active_nllb_model(folder_name: String) -> Result<(), String> {
    if folder_name.is_empty() {
        return Err("Model folder name cannot be empty".to_string());
    }

    let mut guard = CURRENT_MODEL_FOLDER.lock().unwrap();
    *guard = folder_name.clone();

    println!("[NLLB] Active model changed to: {}", folder_name);
    Ok(())
}

#[tauri::command]
fn get_active_nllb_model() -> Result<String, String> {
    let guard = CURRENT_MODEL_FOLDER.lock().unwrap();
    Ok(guard.clone())
}

// ──────────────────────────────────────────────────────────────
// Model existence check
// ──────────────────────────────────────────────────────────────

#[tauri::command(async)]
async fn ensure_nllb_model(app: AppHandle, folder_name: String) -> Result<String, String> {
    let path = get_model_folder_path(&app, &folder_name);

    if model_exists(&path) {
        return Ok(path.to_string_lossy().into_owned());
    }

    Err(format!(
        "Model '{}' not found. Please download it first.",
        folder_name
    ))
}

// ──────────────────────────────────────────────────────────────
// Delete model
// ──────────────────────────────────────────────────────────────

#[tauri::command(async)]
async fn delete_nllb_model(app: AppHandle, folder_name: String) -> Result<(), String> {
    if folder_name.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }

    let path = get_model_folder_path(&app, &folder_name);

    if !path.exists() {
        return Err(format!("Folder {} does not exist", folder_name));
    }

    {
        let active = CURRENT_MODEL_FOLDER.lock().unwrap().clone();
        if active == folder_name {
            return Err("Cannot delete the currently active model".to_string());
        }
    }

    fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete {}: {}", folder_name, e))?;

    println!("[NLLB] Deleted model folder: {}", folder_name);
    Ok(())
}

// ──────────────────────────────────────────────────────────────
// Real download from Hugging Face
// ──────────────────────────────────────────────────────────────

const NLLB_REPO: &str = "Aaron294/NLLB-CT2RS-COMPAT";

#[tauri::command(async)]
async fn download_nllb_model(app: AppHandle, folder_name: String) -> Result<String, String> {
    if folder_name.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }

    let target_dir = get_model_folder_path(&app, &folder_name);

    if model_exists(&target_dir) {
        return Ok(format!("Model '{}' already exists", folder_name));
    }

    // Clean up any previous broken download
    if target_dir.exists() {
        tokio::fs::remove_dir_all(&target_dir)
            .await
            .map_err(|e| format!("Cannot clean previous directory: {}", e))?;
    }

    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("Cannot create directory: {}", e))?;

    let files = vec!["model.bin", "tokenizer.json"];

    let client = reqwest::Client::builder()
        .user_agent("SpeakShift-App/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    for file_name in files {
        // let url = format!(
        //     "https://huggingface.co/Aaron294/NLLB-CT2RS-COMPAT/resolve/main/{}/{}",
        //     folder_name, file_name
        // );
        let url = format!(
            "https://huggingface.co/Aaron294/NLLB-CT2RS-COMPAT/resolve/main/{}/{}",
            folder_name, file_name
        );

        // emit starting
        app.emit(
            "nllb-download-progress",
            serde_json::json!({
                "folder": folder_name,
                "file": file_name,
                "status": "starting",
                "percent": 0
            }),
        )
        .ok();

        let mut response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Failed to start download {}: {}", file_name, e))?;

        if !response.status().is_success() {
            return Err(format!(
                "HTTP {} downloading {}: {}",
                response.status(),
                file_name,
                response.text().await.unwrap_or_default()
            ));
        }

        let total_size = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;

        let mut file = tokio::fs::File::create(target_dir.join(&file_name))
            .await
            .map_err(|e| e.to_string())?;

        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;

            if total_size > 0 {
                let percent = ((downloaded as f64 / total_size as f64) * 100.0) as u32;
                app.emit(
                    "nllb-download-progress",
                    serde_json::json!({
                        "folder": folder_name,
                        "file": file_name,
                        "status": "downloading",
                        "percent": percent,
                        "downloaded_bytes": downloaded,
                        "total_bytes": total_size,
                    }),
                )
                .ok();
            }
        }

        // completed one file
        app.emit(
            "nllb-download-progress",
            serde_json::json!({
                "folder": folder_name,
                "file": file_name,
                "status": "completed",
                "percent": 100
            }),
        )
        .ok();
    }

    // Final check
    if !model_exists(&target_dir) {
        return Err(format!(
            "Download finished but model files missing for '{}'",
            folder_name
        ));
    }

    Ok(format!("Successfully downloaded model '{}'", folder_name))
}

fn get_nllb_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    get_sidecar_path(
        app,
        "nllb-translation",
        "x86_64-pc-windows-msvc.exe",
        "x86_64-unknown-linux-gnu",
        "x86_64-apple-darwin",
    )
}

// ──────────────────────────────────────────────────────────────
// Translation – call external binary
// ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct TranslationResult {
    pub success: bool,
    pub translated: String,
    pub raw: Option<String>,
    pub score: Option<f64>,
    pub error: Option<String>,
}

#[tauri::command(async)]
async fn translate_text(
    app: AppHandle,
    text: String,
    src_lang: String,
    tgt_lang: String,
    beam: Option<u32>,
    max_new_tokens: Option<u32>,
) -> Result<TranslationResult, String> {
    ensure_feature_unlocked(&app, "Translation")?;
    if text.trim().is_empty() {
        return Err("No text to translate".to_string());
    }

    let model_folder = CURRENT_MODEL_FOLDER.lock().unwrap().clone();
    let model_dir = get_model_folder_path(&app, &model_folder);

    if !model_exists(&model_dir) {
        return Err(format!(
            "Selected model '{}' is missing model.bin or tokenizer.json",
            model_folder
        ));
    }

    let binary_path = get_nllb_binary_path(&app)?;

    let mut cmd = tokio::process::Command::new(&binary_path);

    cmd.arg("--model-dir").arg(model_dir);
    cmd.arg("--text").arg(text.trim());
    cmd.arg("--source-lang").arg(&src_lang);
    cmd.arg("--target-lang").arg(&tgt_lang);

    if let Some(b) = beam {
        cmd.arg("--beam").arg(b.to_string());
    }
    if let Some(m) = max_new_tokens {
        cmd.arg("--max-tokens").arg(m.to_string());
    }

    // Optional: add --verbose in dev to see more output
    // #[cfg(debug_assertions)]
    // cmd.arg("--verbose");

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run nllb-translation: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("Translation failed:\n{}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let result: TranslationResult = serde_json::from_str(&stdout).map_err(|e| {
        format!(
            "Failed to parse JSON from binary.\nError: {}\nOutput:\n{}",
            e, stdout
        )
    })?;

    Ok(result)
}

#[tauri::command]
fn get_temp_dir() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

// ──────────────────────────────────────────────────────────────
// Qwen TTS for voice profiling and dubbing
// ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct QwenVoiceProfileResult {
    prompt_path: String,
    output_probe_path: String,
    model_dir: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct QwenDubbingRecord {
    id: String,
    title: String,
    text: String,
    lang: String,
    prompt_path: String,
    output_path: String,
    created_at_ms: u64,
}

#[derive(Serialize)]
struct QwenModelStatus {
    model_dir: String,
    prompt_dir: String,
    is_ready: bool,
    total_files: usize,
    downloaded_files: usize,
    missing_files: Vec<String>,
    supported_languages: Vec<String>,
}

#[derive(Deserialize)]
struct HfModelMeta {
    siblings: Option<Vec<HfSibling>>,
}

#[derive(Deserialize)]
struct HfSibling {
    rfilename: String,
}

const QWEN_MODEL_REPO: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";
const QWEN_MODEL_FOLDER: &str = "Qwen3-TTS-12Hz-0.6B-Base";
const PARAKEET_TDT_REPO: &str = "istupakov/parakeet-tdt-0.6b-v3-onnx";
const PARAKEET_TDT_FOLDER: &str = "parakeet-tdt-0.6b-v3-onnx";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
enum QwenErrorCode {
    ModelNotFound,
    CliExecutionFailed,
    InvalidAudio,
    InvalidInput,
    Io,
    OutOfMemory,
    NormalizationFailed,
    Busy,
    Cancelled,
    Unknown,
}

#[derive(Serialize)]
struct ParakeetModelStatus {
    model_dir: String,
    is_ready: bool,
    total_files: usize,
    downloaded_files: usize,
    missing_files: Vec<String>,
    active_model_dir: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ParakeetDiarizedTextSegment {
    start_ms: i64,
    end_ms: i64,
    speaker: String,
    text: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct ParakeetTranscribeDiarizeResult {
    audio_path: String,
    model_dir: String,
    diarization_model: String,
    full_text: String,
    segments: Vec<ParakeetDiarizedTextSegment>,
}

#[derive(Serialize)]
struct QwenPipelineResult {
    record: QwenDubbingRecord,
    final_audio_path: String,
    final_video_path: Option<String>,
    segment_count: usize,
}

static ACTIVE_PARAKEET_TDT_MODEL_DIR: Lazy<Arc<Mutex<Option<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QwenCommandError {
    code: QwenErrorCode,
    message: String,
    stage: Option<String>,
    recovery_hint: Option<String>,
    details: Option<String>,
}

impl QwenCommandError {
    fn new(code: QwenErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            stage: None,
            recovery_hint: None,
            details: None,
        }
    }

    fn with_stage(mut self, stage: impl Into<String>) -> Self {
        self.stage = Some(stage.into());
        self
    }

    fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.recovery_hint = Some(hint.into());
        self
    }

    fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }

    fn from_cli_failure(stage: &str, stderr: &str, stdout: &str) -> Self {
        let lower = stderr.to_lowercase();
        let mut err = if lower.contains("out of memory") || lower.contains("cuda") && lower.contains("oom") {
            Self::new(
                QwenErrorCode::OutOfMemory,
                "Qwen synthesis ran out of memory",
            )
            .with_hint("Enable CPU mode, reduce text length, or close GPU-heavy applications")
        } else {
            Self::new(QwenErrorCode::CliExecutionFailed, "qwen3tts-cli execution failed")
                .with_hint("Verify model files are complete and reference/prompt audio is valid")
        };

        err = err.with_stage(stage.to_string());
        err.with_details(format!("stderr:\n{}\nstdout:\n{}", stderr, stdout))
    }
}

impl std::fmt::Display for QwenCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let payload = serde_json::to_string(self).unwrap_or_else(|_| {
            format!(
                "{{\"code\":\"Unknown\",\"message\":\"{}\"}}",
                self.message.replace('"', "\\\"")
            )
        });
        write!(f, "{}", payload)
    }
}

impl std::error::Error for QwenCommandError {}

fn emit_qwen_progress(
    app: &AppHandle,
    task_id: &Option<String>,
    percentage: u32,
    stage: &str,
    message: &str,
) {
    let payload = json!({
        "task_id": task_id,
        "percentage": percentage,
        "stage": stage,
        "message": message,
    });

    let _ = app.emit("qwen-progress", payload.clone());

    // Backward-compatible mirror for existing frontend listeners.
    let legacy_payload = json!({
        "taskId": task_id,
        "percent": percentage,
        "stage": stage,
        "message": message,
    });
    let _ = app.emit("qwen-voice-progress", legacy_payload.clone());
    let _ = app.emit("qwen-dubbing-progress", legacy_payload);
}

async fn normalize_qwen_audio(
    app: &AppHandle,
    input_path: &Path,
    kind: &str,
) -> Result<PathBuf, QwenCommandError> {
    if !input_path.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidAudio,
                format!("Audio file not found for normalization: {}", input_path.display()),
            )
            .with_stage("normalize")
            .with_hint("Retry synthesis and ensure ffmpeg sidecar is available"),
        );
    }

    let ffmpeg = get_ffmpeg_path(app).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::CliExecutionFailed,
            format!("Failed to resolve ffmpeg binary: {}", e),
        )
        .with_stage("normalize")
        .with_hint("Verify ffmpeg sidecar is bundled and executable")
    })?;

    let output_path = input_path.with_file_name(format!(
        "{}_normalized_{}.wav",
        kind,
        Uuid::new_v4()
    ));

    let out = TokioCommand::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(input_path)
        .arg("-af")
        .arg("loudnorm=I=-15:TP=-1.5:LRA=11")
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(&output_path)
        .output()
        .await
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::NormalizationFailed,
                format!("Failed to run ffmpeg normalization: {}", e),
            )
            .with_stage("normalize")
            .with_hint("Ensure ffmpeg sidecar exists and the source audio is readable")
        })?;

    if !out.status.success() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::NormalizationFailed,
                "ffmpeg loudnorm command failed",
            )
            .with_stage("normalize")
            .with_hint("Try CPU synthesis mode or re-run with shorter text")
            .with_details(String::from_utf8_lossy(&out.stderr).to_string()),
        );
    }

    if !output_path.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::NormalizationFailed,
                format!(
                    "Normalization output file was not created: {}",
                    output_path.display()
                ),
            )
            .with_stage("normalize"),
        );
    }

    Ok(output_path)
}

fn get_tts_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get app local data dir: {}", e))?;
    dir.push("tts_models");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create tts_models dir: {}", e))?;
    Ok(dir)
}

fn get_qwen_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = get_tts_models_dir(app)?;
    dir.push(QWEN_MODEL_FOLDER);
    Ok(dir)
}

fn get_tts_voice_prompts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get app local data dir: {}", e))?;
    dir.push("tts_voice_prompts");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create tts_voice_prompts dir: {}", e))?;
    Ok(dir)
}

fn get_parakeet_tdt_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = get_tts_models_dir(app)?;
    dir.push(PARAKEET_TDT_FOLDER);
    Ok(dir)
}

fn required_parakeet_tdt_files() -> Vec<String> {
    vec![
        "encoder-model.onnx".to_string(),
        "decoder_joint-model.onnx".to_string(),
        "vocab.txt".to_string(),
    ]
}

async fn fetch_parakeet_tdt_files() -> Result<Vec<String>, String> {
    let api_url = format!("https://huggingface.co/api/models/{}", PARAKEET_TDT_REPO);
    let client = Client::builder()
        .user_agent("SpeakShift-Tauri/0.1.0")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client
        .get(&api_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Parakeet model metadata: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Failed to fetch Parakeet model metadata: HTTP {}",
            resp.status()
        ));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read Parakeet metadata body: {}", e))?;

    let meta: HfModelMeta = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Parakeet metadata JSON: {}", e))?;

    let mut files = meta
        .siblings
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.rfilename)
        .filter(|name: &String| {
            !name.starts_with('.')
                && !name.ends_with(".md")
                && !name.ends_with(".png")
                && !name.ends_with(".jpg")
                && !name.ends_with(".jpeg")
                && !name.ends_with(".gif")
        })
        .collect::<Vec<_>>();

    files.sort();
    files.dedup();
    Ok(files)
}

fn get_active_parakeet_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(active) = ACTIVE_PARAKEET_TDT_MODEL_DIR.lock().unwrap().clone() {
        let p = PathBuf::from(active);
        if p.exists() {
            return Ok(p);
        }
    }

    let default_dir = get_parakeet_tdt_model_dir(app)?;
    if default_dir.exists() {
        return Ok(default_dir);
    }

    Err("Parakeet TDT model directory is not available".to_string())
}

fn resolve_parakeet_exec_config(force_cpu: bool) -> ParakeetExecutionConfig {
    if force_cpu {
        return ParakeetExecutionConfig::new()
            .with_execution_provider(ParakeetExecutionProvider::Cpu);
    }

    #[cfg(feature = "cuda")]
    {
        return ParakeetExecutionConfig::new()
            .with_execution_provider(ParakeetExecutionProvider::Cuda);
    }

    #[allow(unreachable_code)]
    ParakeetExecutionConfig::new().with_execution_provider(ParakeetExecutionProvider::Cpu)
}

fn split_sentence_aware(text: &str, max_words: usize) -> Vec<String> {
    let clean = text.trim();
    if clean.is_empty() {
        return Vec::new();
    }

    let mut sentences = Vec::new();
    let mut start = 0usize;
    for (i, ch) in clean.char_indices() {
        if matches!(ch, '.' | '!' | '?') {
            let part = clean[start..=i].trim();
            if !part.is_empty() {
                sentences.push(part.to_string());
            }
            start = i + ch.len_utf8();
        }
    }

    let tail = clean[start..].trim();
    if !tail.is_empty() {
        sentences.push(tail.to_string());
    }
    if sentences.is_empty() {
        sentences.push(clean.to_string());
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_words = 0usize;

    for sentence in sentences {
        let words = sentence.split_whitespace().count();
        if current_words > 0 && current_words + words > max_words {
            chunks.push(current.trim().to_string());
            current.clear();
            current_words = 0;
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(&sentence);
        current_words += words;
    }

    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }

    chunks
}

fn wav_duration_seconds(path: &Path) -> Result<f32, QwenCommandError> {
    let reader = WavReader::open(path).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::InvalidAudio,
            format!("Failed to open WAV file '{}': {}", path.display(), e),
        )
        .with_stage("timing")
    })?;

    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidAudio,
                "Invalid WAV format while computing duration",
            )
            .with_stage("timing"),
        );
    }

    let sample_count = reader.duration() as f32;
    Ok(sample_count / spec.sample_rate as f32 / spec.channels as f32)
}

fn build_atempo_chain(mut tempo: f32) -> String {
    let mut filters = Vec::new();
    while tempo > 2.0 {
        filters.push("atempo=2.0".to_string());
        tempo /= 2.0;
    }
    while tempo < 0.5 {
        filters.push("atempo=0.5".to_string());
        tempo /= 0.5;
    }
    filters.push(format!("atempo={:.5}", tempo));
    filters.join(",")
}

async fn adjust_audio_duration(
    app: &AppHandle,
    input_path: &Path,
    target_duration_seconds: f32,
    output_path: &Path,
    task_id: &Option<String>,
) -> Result<(PathBuf, f32), QwenCommandError> {
    if target_duration_seconds <= 0.0 {
        fs::copy(input_path, output_path).map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to copy hinted audio: {}", e),
            )
            .with_stage("timing")
        })?;
        return Ok((output_path.to_path_buf(), 1.0));
    }

    let current = wav_duration_seconds(input_path)?;
    if current <= 0.0 {
        fs::copy(input_path, output_path).map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to copy zero-duration audio: {}", e),
            )
            .with_stage("timing")
        })?;
        return Ok((output_path.to_path_buf(), 1.0));
    }

    let ratio = current / target_duration_seconds;
    let abs_delta = (ratio - 1.0).abs();
    if abs_delta < 0.06 {
        fs::copy(input_path, output_path).map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to copy timing-aligned audio: {}", e),
            )
            .with_stage("timing")
        })?;
        return Ok((output_path.to_path_buf(), 1.0));
    }

    let ffmpeg = get_ffmpeg_path(app).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::CliExecutionFailed,
            format!("Failed to locate ffmpeg: {}", e),
        )
        .with_stage("timing")
    })?;

    if abs_delta > 0.15 {
        build_qwen_warning(
            app,
            task_id,
            &format!(
                "Large duration mismatch detected (factor {:.2}). Falling back to original speed with silence padding.",
                ratio
            ),
        );
    }

    if abs_delta <= 0.14 {
        // Preserve timbre as much as possible for small to moderate corrections.
        let candidate_filters = vec![
            format!("apitch=1.0,{}", build_atempo_chain(ratio.clamp(0.5, 2.0))),
            build_atempo_chain(ratio.clamp(0.5, 2.0)),
        ];

        let mut last_err = String::new();
        for filter in candidate_filters {
            let out = TokioCommand::new(&ffmpeg)
                .arg("-y")
                .arg("-i")
                .arg(input_path)
                .arg("-af")
                .arg(filter)
                .arg("-ac")
                .arg("1")
                .arg("-ar")
                .arg("16000")
                .arg("-c:a")
                .arg("pcm_s16le")
                .arg(output_path)
                .output()
                .await
                .map_err(|e| {
                    QwenCommandError::new(
                        QwenErrorCode::CliExecutionFailed,
                        format!("Failed to run ffmpeg duration adjust: {}", e),
                    )
                    .with_stage("timing")
                })?;

            if out.status.success() {
                return Ok((output_path.to_path_buf(), ratio));
            }
            last_err = String::from_utf8_lossy(&out.stderr).to_string();
        }

        return Err(
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                "Failed to adjust audio duration with ffmpeg",
            )
            .with_stage("timing")
            .with_details(last_err),
        );
    }

    // For large differences, preserve original speech speed and only pad trailing silence if needed.
    if target_duration_seconds > current {
        let pad_seconds = target_duration_seconds - current;
        let filter = format!("apad=pad_dur={:.4}", pad_seconds);
        let out = TokioCommand::new(ffmpeg)
            .arg("-y")
            .arg("-i")
            .arg(input_path)
            .arg("-af")
            .arg(filter)
            .arg("-ac")
            .arg("1")
            .arg("-ar")
            .arg("16000")
            .arg("-c:a")
            .arg("pcm_s16le")
            .arg(output_path)
            .output()
            .await
            .map_err(|e| {
                QwenCommandError::new(
                    QwenErrorCode::CliExecutionFailed,
                    format!("Failed to run ffmpeg silence padding: {}", e),
                )
                .with_stage("timing")
            })?;

        if !out.status.success() {
            return Err(
                QwenCommandError::new(
                    QwenErrorCode::CliExecutionFailed,
                    "Failed to apply silence padding for duration alignment",
                )
                .with_stage("timing")
                .with_details(String::from_utf8_lossy(&out.stderr).to_string()),
            );
        }
        return Ok((output_path.to_path_buf(), 1.0));
    }

    build_qwen_warning(
        app,
        task_id,
        "Generated audio is longer than target segment and large compression would reduce quality. Keeping original speed.",
    );
    fs::copy(input_path, output_path).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::Io,
            format!("Failed to keep original-speed audio: {}", e),
        )
        .with_stage("timing")
    })?;
    Ok((output_path.to_path_buf(), 1.0))
}

async fn is_qwen_task_cancelled(task_id: &Option<String>) -> bool {
    let Some(id) = task_id.as_ref() else {
        return false;
    };
    CANCELLED_QWEN_TASKS.lock().await.contains(id)
}

async fn ensure_task_not_cancelled(
    app: &AppHandle,
    task_id: &Option<String>,
) -> Result<(), QwenCommandError> {
    if is_qwen_task_cancelled(task_id).await {
        let _ = app.emit(
            "qwen-cancelled",
            json!({
                "task_id": task_id,
                "message": "Qwen task cancelled by user",
            }),
        );
        return Err(
            QwenCommandError::new(QwenErrorCode::Cancelled, "Task cancelled")
                .with_stage("cancel"),
        );
    }
    Ok(())
}

async fn ensure_task_not_cancelled_with_cleanup(
    app: &AppHandle,
    task_id: &Option<String>,
    files_to_cleanup: &[PathBuf],
) -> Result<(), QwenCommandError> {
    if is_qwen_task_cancelled(task_id).await {
        for path in files_to_cleanup {
            let _ = fs::remove_file(path);
        }
        let _ = app.emit(
            "qwen-cancelled",
            json!({
                "task_id": task_id,
                "message": "Qwen task cancelled by user",
            }),
        );
        return Err(
            QwenCommandError::new(QwenErrorCode::Cancelled, "Task cancelled")
                .with_stage("cancel"),
        );
    }
    Ok(())
}

async fn register_qwen_task_pid(task_id: &Option<String>, pid: Option<u32>) {
    let (Some(id), Some(actual_pid)) = (task_id.as_ref(), pid) else {
        return;
    };
    let mut map = QWEN_TASK_CHILD_PIDS.lock().await;
    map.entry(id.clone()).or_default().insert(actual_pid);
}

async fn unregister_qwen_task_pid(task_id: &Option<String>, pid: Option<u32>) {
    let (Some(id), Some(actual_pid)) = (task_id.as_ref(), pid) else {
        return;
    };
    let mut map = QWEN_TASK_CHILD_PIDS.lock().await;
    if let Some(set) = map.get_mut(id) {
        set.remove(&actual_pid);
        if set.is_empty() {
            map.remove(id);
        }
    }
}

async fn register_qwen_task_file(task_id: &Option<String>, path: &Path) {
    let Some(id) = task_id.as_ref() else {
        return;
    };
    let mut map = QWEN_TASK_PARTIAL_FILES.lock().await;
    map.entry(id.clone())
        .or_default()
        .insert(path.to_path_buf());
}

async fn unregister_qwen_task_file(task_id: &Option<String>, path: &Path) {
    let Some(id) = task_id.as_ref() else {
        return;
    };
    let mut map = QWEN_TASK_PARTIAL_FILES.lock().await;
    if let Some(set) = map.get_mut(id) {
        set.remove(path);
        if set.is_empty() {
            map.remove(id);
        }
    }
}

async fn cleanup_registered_qwen_task_files(task_id: &str) -> usize {
    let files = {
        let mut map = QWEN_TASK_PARTIAL_FILES.lock().await;
        map.remove(task_id).unwrap_or_default()
    };

    let mut removed = 0usize;
    for path in files {
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

async fn clear_qwen_task_tracking(task_id: &Option<String>) {
    let Some(id) = task_id.as_ref() else {
        return;
    };
    QWEN_TASK_CHILD_PIDS.lock().await.remove(id);
    QWEN_TASK_PARTIAL_FILES.lock().await.remove(id);
}

async fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = TokioCommand::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .output()
            .await;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = TokioCommand::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .output()
            .await;
    }
}

async fn kill_registered_qwen_task_children(task_id: &str) -> usize {
    let pids: Vec<u32> = {
        let mut map = QWEN_TASK_CHILD_PIDS.lock().await;
        map.remove(task_id)
            .unwrap_or_default()
            .into_iter()
            .collect()
    };

    for pid in &pids {
        kill_process_tree(*pid).await;
    }

    pids.len()
}

#[tauri::command]
async fn cancel_qwen_task(app: AppHandle, task_id: String) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("task_id is required".to_string());
    }

    CANCELLED_QWEN_TASKS.lock().await.insert(task_id.clone());
    let killed_children = kill_registered_qwen_task_children(&task_id).await;
    let removed_files = cleanup_registered_qwen_task_files(&task_id).await;
    let _ = app.emit(
        "qwen-cancelled",
        json!({
            "task_id": task_id,
            "message": "Cancellation requested",
            "killed_children": killed_children,
            "removed_files": removed_files,
        }),
    );
    Ok(())
}

#[tauri::command]
fn cleanup_qwen_intermediates(app: AppHandle, older_than_hours: Option<u64>) -> Result<usize, String> {
    let mut root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to resolve app local data dir: {}", e))?;
    root.push("qwen_pipeline");
    if !root.exists() {
        return Ok(0);
    }

    let max_age_secs = older_than_hours.unwrap_or(24) * 3600;
    let now = SystemTime::now();
    let mut deleted = 0usize;

    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let keep = path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|n| n.contains("qwen_pipeline_final_normalized"))
                .unwrap_or(false);
            if keep {
                continue;
            }

            let Ok(meta) = fs::metadata(&path) else { continue };
            let Ok(modified) = meta.modified() else { continue };
            let Ok(age) = now.duration_since(modified) else { continue };
            if age.as_secs() >= max_age_secs {
                if fs::remove_file(&path).is_ok() {
                    deleted += 1;
                }
            }
        }
    }

    Ok(deleted)
}

async fn crossfade_concat_wavs(
    app: &AppHandle,
    wav_paths: &[PathBuf],
    output_path: &Path,
    crossfade_ms: u32,
) -> Result<(), QwenCommandError> {
    if wav_paths.is_empty() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidInput,
                "No synthesized chunks to concatenate",
            )
            .with_stage("concat"),
        );
    }

    if wav_paths.len() == 1 {
        fs::copy(&wav_paths[0], output_path).map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to copy single chunk output: {}", e),
            )
            .with_stage("concat")
        })?;
        return Ok(());
    }

    let ffmpeg = get_ffmpeg_path(app).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::CliExecutionFailed,
            format!("Failed to locate ffmpeg: {}", e),
        )
        .with_stage("concat")
    })?;

    let mut args: Vec<String> = vec!["-y".to_string()];
    for wav in wav_paths {
        args.push("-i".to_string());
        args.push(wav.to_string_lossy().to_string());
    }

    let d = (crossfade_ms as f32 / 1000.0).max(0.08);
    let mut filter_parts = Vec::new();
    for idx in 0..(wav_paths.len() - 1) {
        let left = if idx == 0 {
            "[0:a]".to_string()
        } else {
            format!("[a{}]", idx)
        };
        let right = format!("[{}:a]", idx + 1);
        let out = format!("[a{}]", idx + 1);
        filter_parts.push(format!(
            "{}{}acrossfade=d={:.3}:c1=tri:c2=tri{}",
            left, right, d, out
        ));
    }

    args.push("-filter_complex".to_string());
    args.push(filter_parts.join(";"));
    args.push("-map".to_string());
    args.push(format!("[a{}]", wav_paths.len() - 1));
    args.push("-ac".to_string());
    args.push("1".to_string());
    args.push("-ar".to_string());
    args.push("16000".to_string());
    args.push("-c:a".to_string());
    args.push("pcm_s16le".to_string());
    args.push(output_path.to_string_lossy().to_string());

    let out = TokioCommand::new(ffmpeg)
        .args(args)
        .output()
        .await
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Failed to run ffmpeg crossfade concat: {}", e),
            )
            .with_stage("concat")
        })?;

    if !out.status.success() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                "Failed while crossfading synthesized chunks",
            )
            .with_stage("concat")
            .with_details(String::from_utf8_lossy(&out.stderr).to_string()),
        );
    }

    Ok(())
}

fn build_qwen_warning(app: &AppHandle, task_id: &Option<String>, warning: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    println!(
        "[QWEN-WARN {}.{:03}] task={:?} {}",
        now.as_secs(),
        now.subsec_millis(),
        task_id,
        warning
    );

    let _ = app.emit(
        "qwen-warning",
        json!({
            "task_id": task_id,
            "message": warning,
        }),
    );
}

fn estimate_qwen_required_vram_mib(text_len: usize, dtype: &str) -> u32 {
    let base = if dtype.eq_ignore_ascii_case("bf16") {
        4300u32
    } else {
        5600u32
    };

    let dynamic = ((text_len as f32 / 260.0) * 140.0).round() as u32;
    base.saturating_add(dynamic.min(2600))
}

fn estimate_qwen_required_ram_mib_from_text(text: &str) -> u32 {
    let token_count = text.split_whitespace().count().max(1) as f32;
    let gb = 2.0f32 + (token_count / 1000.0) * 0.8;
    (gb * 1024.0).round() as u32
}

async fn probe_available_ram_mib() -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(meminfo) = fs::read_to_string("/proc/meminfo") {
            for line in meminfo.lines() {
                if let Some(rest) = line.strip_prefix("MemAvailable:") {
                    let kb = rest
                        .split_whitespace()
                        .find_map(|v| v.parse::<u64>().ok())?;
                    return Some((kb / 1024) as u32);
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = TokioCommand::new("powershell")
            .arg("-NoProfile")
            .arg("-Command")
            .arg("(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory")
            .output()
            .await
        {
            if out.status.success() {
                if let Some(kb) = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .find_map(|line| line.trim().parse::<u64>().ok())
                {
                    return Some((kb / 1024) as u32);
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let (Ok(vm), Ok(ps)) = (
            TokioCommand::new("vm_stat").output().await,
            TokioCommand::new("sysctl")
                .arg("-n")
                .arg("hw.pagesize")
                .output()
                .await,
        ) {
            if vm.status.success() && ps.status.success() {
                if let Ok(page_size) = String::from_utf8_lossy(&ps.stdout).trim().parse::<u64>() {
                    let mut free_pages: u64 = 0;
                    for line in String::from_utf8_lossy(&vm.stdout).lines() {
                        if line.contains("Pages free") || line.contains("Pages inactive") {
                            let digits = line.chars().filter(|c| c.is_ascii_digit()).collect::<String>();
                            if let Ok(v) = digits.parse::<u64>() {
                                free_pages = free_pages.saturating_add(v);
                            }
                        }
                    }
                    let bytes = free_pages.saturating_mul(page_size);
                    return Some((bytes / (1024 * 1024)) as u32);
                }
            }
        }
    }

    None
}

async fn ensure_qwen_vram_headroom(
    app: &AppHandle,
    task_id: &Option<String>,
    use_cpu: bool,
    text: &str,
    dtype: &str,
    stage: &str,
) -> Result<(), QwenCommandError> {
    if use_cpu {
        return Ok(());
    }

    let text_len = text.len().max(1);
    let required_mib = estimate_qwen_required_vram_mib(text_len.max(1), dtype);
    let probe_nvidia = TokioCommand::new("nvidia-smi")
        .arg("--query-gpu=memory.free")
        .arg("--format=csv,noheader,nounits")
        .output()
        .await;

    let parse_mib = |s: &str| -> Option<u32> {
        s.lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .max()
    };

    let free_mib = match probe_nvidia {
        Ok(output) if output.status.success() => parse_mib(&String::from_utf8_lossy(&output.stdout)),
        _ => None,
    };

    let free_mib = if let Some(v) = free_mib {
        Some(v)
    } else {
        let probe_rocm = TokioCommand::new("rocm-smi")
            .arg("--showmeminfo")
            .arg("vram")
            .arg("--csv")
            .output()
            .await;

        match probe_rocm {
            Ok(output) if output.status.success() => {
                let nums: Vec<u64> = String::from_utf8_lossy(&output.stdout)
                    .split(|c: char| !c.is_ascii_digit())
                    .filter_map(|n| n.parse::<u64>().ok())
                    .collect();
                nums.into_iter().max().map(|raw| {
                    // rocm-smi may report bytes or MiB depending on mode; normalize conservatively.
                    if raw > 262_144 {
                        (raw / (1024 * 1024)) as u32
                    } else {
                        raw as u32
                    }
                })
            }
            _ => None,
        }
    };

    if let Some(free_mib) = free_mib {
        if free_mib + 256 < required_mib {
            return Err(
                QwenCommandError::new(
                    QwenErrorCode::OutOfMemory,
                    format!(
                        "Insufficient free VRAM for synthesis (free {} MiB, estimated need {} MiB)",
                        free_mib, required_mib
                    ),
                )
                .with_stage(stage)
                .with_hint("Enable CPU mode or shorten text/chunk size before retrying"),
            );
        }

        if free_mib < required_mib + 1024 {
            build_qwen_warning(
                app,
                task_id,
                &format!(
                    "GPU memory is tight (free {} MiB, estimated need {} MiB). Consider CPU mode if synthesis fails.",
                    free_mib, required_mib
                ),
            );
        }

        return Ok(());
    }

    build_qwen_warning(
        app,
        task_id,
        "GPU memory probe unavailable for NVIDIA/AMD. Falling back to RAM heuristic.",
    );

    let ram_needed_mib = estimate_qwen_required_ram_mib_from_text(text);
    match probe_available_ram_mib().await {
        Some(available_ram_mib) => {
            if available_ram_mib < ram_needed_mib {
                return Err(
                    QwenCommandError::new(
                        QwenErrorCode::OutOfMemory,
                        format!(
                            "Insufficient available RAM for synthesis fallback (available {} MiB, estimated need {} MiB)",
                            available_ram_mib, ram_needed_mib
                        ),
                    )
                    .with_stage(stage)
                    .with_hint("Close memory-heavy applications, reduce text length, or retry later"),
                );
            }

            if available_ram_mib < ram_needed_mib + 1024 {
                build_qwen_warning(
                    app,
                    task_id,
                    &format!(
                        "RAM headroom is low (available {} MiB, estimated need {} MiB).",
                        available_ram_mib, ram_needed_mib
                    ),
                );
            }
            Ok(())
        }
        None => {
            build_qwen_warning(
                app,
                task_id,
                "Failed to probe available RAM; skipping memory preflight.",
            );
            Ok(())
        }
    }
}

fn overlap_seconds(a_start: f32, a_end: f32, b_start: f32, b_end: f32) -> f32 {
    (a_end.min(b_end) - a_start.max(b_start)).max(0.0)
}

fn detect_voiced_regions(audio: &[f32], sample_rate: u32) -> Vec<(f32, f32)> {
    if audio.is_empty() || sample_rate == 0 {
        return Vec::new();
    }

    let frame = ((sample_rate as f32) * 0.02) as usize;
    let hop = ((sample_rate as f32) * 0.01) as usize;
    if frame == 0 || hop == 0 || audio.len() < frame {
        return vec![(0.0, audio.len() as f32 / sample_rate as f32)];
    }

    let mut energies = Vec::new();
    let mut i = 0usize;
    while i + frame <= audio.len() {
        let mut sum = 0.0f32;
        for s in &audio[i..i + frame] {
            sum += s * s;
        }
        let rms = (sum / frame as f32).sqrt();
        energies.push((i as f32 / sample_rate as f32, rms));
        i += hop;
    }

    if energies.is_empty() {
        return Vec::new();
    }

    let mean = energies.iter().map(|(_, e)| *e).sum::<f32>() / energies.len() as f32;
    let threshold = (mean * 0.55).max(0.004);

    let mut regions = Vec::new();
    let mut start: Option<f32> = None;
    let mut last_t = 0.0f32;

    for (t, e) in energies {
        let voiced = e >= threshold;
        if voiced && start.is_none() {
            start = Some(t);
        }
        if !voiced && start.is_some() {
            let s = start.take().unwrap_or(0.0);
            if t - s >= 0.08 {
                regions.push((s, t));
            }
        }
        last_t = t;
    }

    if let Some(s) = start {
        let end = (last_t + 0.02).max(s);
        if end - s >= 0.08 {
            regions.push((s, end));
        }
    }

    regions
}

fn merge_time_regions(mut regions: Vec<(f32, f32)>, max_gap: f32) -> Vec<(f32, f32)> {
    if regions.is_empty() {
        return regions;
    }
    regions.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged = vec![regions[0]];
    for (s, e) in regions.into_iter().skip(1) {
        let last = merged.last_mut().unwrap();
        if s <= last.1 + max_gap {
            last.1 = last.1.max(e);
        } else {
            merged.push((s, e));
        }
    }
    merged
}

fn is_translation_suspicious(source: &str, translated: &str) -> bool {
    let t = translated.trim();
    if t.is_empty() {
        return true;
    }

    let alnum = t.chars().filter(|c| c.is_alphanumeric()).count();
    if alnum < t.len().saturating_div(4) {
        return true;
    }

    if t.len() > 16 {
        let unique = t.chars().collect::<HashSet<_>>().len();
        if unique * 5 < t.len() {
            return true;
        }
    }

    let s = source.trim().to_lowercase();
    let tn = t.to_lowercase();
    s.len() > 8 && tn == s
}

async fn parakeet_transcribe_and_diarize_impl(
    app: &AppHandle,
    media_path: &str,
    model_dir: Option<String>,
    force_cpu: Option<bool>,
    task_id: &Option<String>,
) -> Result<ParakeetTranscribeDiarizeResult, QwenCommandError> {
    ensure_task_not_cancelled(app, task_id).await?;
    emit_qwen_progress(app, task_id, 12, "extract-audio", "Preparing audio for Parakeet-TDT");

    let input = PathBuf::from(media_path);
    if !input.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidInput,
                format!("Input media path does not exist: {}", media_path),
            )
            .with_stage("extract-audio"),
        );
    }

    let ffmpeg = get_ffmpeg_path(app).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::CliExecutionFailed,
            format!("Failed to locate ffmpeg: {}", e),
        )
        .with_stage("extract-audio")
    })?;

    let mut work_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to resolve app data dir: {}", e),
            )
            .with_stage("extract-audio")
        })?;
    work_dir.push("qwen_pipeline");
    work_dir.push("parakeet");
    fs::create_dir_all(&work_dir).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::Io,
            format!("Failed to create Parakeet work dir: {}", e),
        )
        .with_stage("extract-audio")
    })?;

    let wav_path = work_dir.join(format!("parakeet_input_{}.wav", Uuid::new_v4()));
    let ffmpeg_out = TokioCommand::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(&wav_path)
        .output()
        .await
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Failed to run ffmpeg for Parakeet input: {}", e),
            )
            .with_stage("extract-audio")
        })?;

    if !ffmpeg_out.status.success() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidAudio,
                "Failed to convert source media to 16k mono WAV",
            )
            .with_stage("extract-audio")
            .with_details(String::from_utf8_lossy(&ffmpeg_out.stderr).to_string()),
        );
    }

    emit_qwen_progress(app, task_id, 24, "load-model", "Loading Parakeet-TDT model");

    let resolved_model_dir = if let Some(dir) = model_dir {
        PathBuf::from(dir)
    } else {
        get_active_parakeet_model_dir(app).map_err(|e| {
            QwenCommandError::new(QwenErrorCode::ModelNotFound, e)
                .with_stage("load-model")
                .with_hint("Download Parakeet-TDT model first")
        })?
    };

    let audio_samples = load_audio_to_f32_samples(&wav_path.to_string_lossy()).map_err(|e| {
        QwenCommandError::new(QwenErrorCode::InvalidAudio, e).with_stage("transcribe")
    })?;

    ensure_task_not_cancelled(app, task_id).await?;

    let exec_config = resolve_parakeet_exec_config(force_cpu.unwrap_or(false));
    // Use parakeet-rs verified constructor and Transcriber trait method.
    let mut parakeet = ParakeetTDT::from_pretrained(&resolved_model_dir, Some(exec_config))
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::ModelNotFound,
                format!("Failed to load Parakeet-TDT model: {}", e),
            )
            .with_stage("load-model")
            .with_hint("Ensure encoder-model.onnx, decoder_joint-model.onnx and vocab.txt exist")
        })?;

    emit_qwen_progress(app, task_id, 38, "transcribe", "Running Parakeet-TDT transcription");

    let transcribe = parakeet
        .transcribe_samples(
            audio_samples.clone(),
            16000,
            1,
            Some(ParakeetTimestampMode::Sentences),
        )
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Parakeet-TDT transcription failed: {}", e),
            )
            .with_stage("transcribe")
        })?;

    emit_qwen_progress(app, task_id, 52, "diarize", "Running speaker diarization");

    let diar_model_name = { CURRENT_DIAR_MODEL.lock().unwrap().clone() };
    let diar_model_path = ensure_diarization_model(app.clone(), diar_model_name.clone())
        .await
        .map_err(|e| QwenCommandError::new(QwenErrorCode::ModelNotFound, e).with_stage("diarize"))?;

    let mut diarizer = Sortformer::with_config(&diar_model_path, None, DiarizationConfig::callhome())
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Failed to initialize Sortformer: {}", e),
            )
            .with_stage("diarize")
        })?;

    let diar_segments: Vec<ParakeetSpeakerSegment> = diarizer
        .diarize(audio_samples.clone(), 16000, 1)
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Sortformer diarization failed: {}", e),
            )
            .with_stage("diarize")
        })?;

    // Overlap-aware refinement: detect transcript regions with competing speakers,
    // intersect with energy-based voiced regions, then re-run Sortformer on short clips.
    let mut overlap_candidates: Vec<(f32, f32)> = Vec::new();
    for token in &transcribe.tokens {
        let overlaps = diar_segments
            .iter()
            .filter(|s| overlap_seconds(token.start, token.end, s.start, s.end) > 0.02)
            .count();
        if overlaps >= 2 {
            overlap_candidates.push((token.start.max(0.0), token.end.max(token.start + 0.05)));
        }
    }

    let voiced_regions = detect_voiced_regions(&audio_samples, 16000);

    let mut refined_overlap_regions = Vec::new();
    for (os, oe) in merge_time_regions(overlap_candidates, 0.08) {
        for (vs, ve) in &voiced_regions {
            let s = os.max(*vs);
            let e = oe.min(*ve);
            if e - s >= 0.12 {
                refined_overlap_regions.push((s, e));
            }
        }
    }
    refined_overlap_regions = merge_time_regions(refined_overlap_regions, 0.04);

    let mut token_override: Vec<Option<(String, f32)>> = vec![None; transcribe.tokens.len()];
    let overlap_total = refined_overlap_regions.len();
    if overlap_total > 0 {
        let audio_for_overlap = audio_samples.clone();

        for (idx, (rs, re)) in refined_overlap_regions.iter().enumerate() {
            ensure_task_not_cancelled(app, task_id).await?;
            emit_qwen_progress(
                app,
                task_id,
                58,
                "overlap-refine",
                &format!("Handling speech overlaps ({}/{} regions)", idx + 1, overlap_total),
            );

            let start_idx = ((*rs * 16000.0).floor() as usize).min(audio_for_overlap.len());
            let end_idx = ((*re * 16000.0).ceil() as usize).min(audio_for_overlap.len());
            if end_idx <= start_idx + 400 {
                continue;
            }

            let mut speaker_scores: std::collections::HashMap<usize, f32> = std::collections::HashMap::new();
            let mut cursor = start_idx;
            let window = (1.2f32 * 16000.0) as usize;
            let hop = (0.8f32 * 16000.0) as usize;

            while cursor < end_idx {
                let sub_end = (cursor + window).min(end_idx);
                if sub_end <= cursor + 320 {
                    break;
                }

                let clip = audio_for_overlap[cursor..sub_end].to_vec();
                let clip_segments = diarizer.diarize(clip, 16000, 1).unwrap_or_default();
                for s in clip_segments {
                    let dur = (s.end - s.start).max(0.0);
                    *speaker_scores.entry(s.speaker_id).or_insert(0.0) += dur;
                }

                if sub_end == end_idx {
                    break;
                }
                cursor = cursor.saturating_add(hop);
            }

            if speaker_scores.is_empty() {
                continue;
            }

            let Some((best_spk, best_score)) = speaker_scores
                .into_iter()
                .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)) else {
                continue;
            };

            let confidence = best_score / ((*re - *rs).max(0.1));
            for (t_idx, token) in transcribe.tokens.iter().enumerate() {
                if overlap_seconds(token.start, token.end, *rs, *re) > 0.02 {
                    let next = (format!("SPEAKER_{:02}", best_spk), confidence);
                    let should_update = token_override[t_idx]
                        .as_ref()
                        .map(|(_, c)| confidence > *c)
                        .unwrap_or(true);
                    if should_update {
                        token_override[t_idx] = Some(next);
                    }
                }
            }
        }
    }

    let mut segments = Vec::new();
    for (token_idx, token) in transcribe.tokens.iter().enumerate() {
        let base_speaker = diar_segments
            .iter()
            .filter_map(|s| {
                let overlap = overlap_seconds(token.start, token.end, s.start, s.end);
                if overlap > 0.0 {
                    Some((s.speaker_id, overlap))
                } else {
                    None
                }
            })
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(id, _)| format!("SPEAKER_{:02}", id))
            .unwrap_or_else(|| "UNKNOWN".to_string());

        let speaker = token_override[token_idx]
            .as_ref()
            .map(|(s, _)| s.clone())
            .unwrap_or(base_speaker);

        segments.push(ParakeetDiarizedTextSegment {
            start_ms: (token.start * 1000.0).round() as i64,
            end_ms: (token.end * 1000.0).round() as i64,
            speaker,
            text: token.text.trim().to_string(),
        });
    }

    emit_qwen_progress(app, task_id, 65, "parakeet-ready", "Parakeet transcription and diarization complete");

    Ok(ParakeetTranscribeDiarizeResult {
        audio_path: wav_path.to_string_lossy().to_string(),
        model_dir: resolved_model_dir.to_string_lossy().to_string(),
        diarization_model: diar_model_name,
        full_text: transcribe.text.trim().to_string(),
        segments,
    })
}

fn qwen_supported_languages() -> Vec<String> {
    vec![
        "Chinese".to_string(),
        "English".to_string(),
        "Japanese".to_string(),
        "Korean".to_string(),
        "German".to_string(),
        "French".to_string(),
        "Russian".to_string(),
        "Portuguese".to_string(),
        "Spanish".to_string(),
        "Italian".to_string(),
    ]
}

async fn fetch_qwen_model_files() -> Result<Vec<String>, String> {
    let api_url = format!("https://huggingface.co/api/models/{}", QWEN_MODEL_REPO);
    let client = Client::builder()
        .user_agent("SpeakShift-Tauri/0.1.0")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client
        .get(&api_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Hugging Face model metadata: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Failed to fetch model metadata: HTTP {}", resp.status()));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read Hugging Face model metadata body: {}", e))?;

    let meta: HfModelMeta = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Hugging Face model metadata JSON: {}", e))?;

    let mut files = meta
        .siblings
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.rfilename)
        .filter(|name: &String| {
            !name.starts_with('.')
                && !name.ends_with(".md")
                && !name.ends_with(".png")
                && !name.ends_with(".jpg")
                && !name.ends_with(".jpeg")
                && !name.ends_with(".gif")
        })
        .collect::<Vec<_>>();

    files.sort();
    files.dedup();
    Ok(files)
}

#[tauri::command]
async fn get_qwen_model_status(app: AppHandle) -> Result<QwenModelStatus, String> {
    let model_dir = get_qwen_model_dir(&app)?;
    let prompt_dir = get_tts_voice_prompts_dir(&app)?;
    let files = fetch_qwen_model_files().await?;

    let mut downloaded = 0usize;
    let mut missing = Vec::new();

    for file in &files {
        let path = model_dir.join(file);
        if path.exists() && path.is_file() {
            downloaded += 1;
        } else {
            missing.push(file.clone());
        }
    }

    Ok(QwenModelStatus {
        model_dir: model_dir.to_string_lossy().to_string(),
        prompt_dir: prompt_dir.to_string_lossy().to_string(),
        is_ready: !files.is_empty() && downloaded == files.len(),
        total_files: files.len(),
        downloaded_files: downloaded,
        missing_files: missing,
        supported_languages: qwen_supported_languages(),
    })
}

#[tauri::command]
async fn download_qwen_model(app: AppHandle) -> Result<QwenModelStatus, String> {
    let model_dir = get_qwen_model_dir(&app)?;
    fs::create_dir_all(&model_dir).map_err(|e| format!("Failed to create qwen model dir: {}", e))?;

    let files = fetch_qwen_model_files().await?;
    if files.is_empty() {
        return Err("No downloadable files found in Hugging Face repo metadata".to_string());
    }

    let client = Client::builder()
        .user_agent("SpeakShift-Tauri/0.1.0")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    for (idx, file_name) in files.iter().enumerate() {
        let target = model_dir.join(file_name);

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create qwen model subdir '{}': {}", parent.display(), e))?;
        }

        if target.exists() && target.is_file() {
            let percent = (((idx + 1) as f64 / files.len() as f64) * 100.0).round() as u32;
            let _ = app.emit(
                "qwen-model-download-progress",
                json!({
                    "percent": percent,
                    "file": file_name,
                    "index": idx + 1,
                    "total": files.len(),
                    "status": "already"
                }),
            );
            continue;
        }

        let url = format!(
            "https://huggingface.co/{}/resolve/main/{}",
            QWEN_MODEL_REPO, file_name
        );

        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Failed downloading '{}': {}", file_name, e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Failed downloading '{}': HTTP {}",
                file_name,
                response.status()
            ));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read bytes for '{}': {}", file_name, e))?;

        tokio::fs::write(&target, &bytes)
            .await
            .map_err(|e| format!("Failed writing '{}': {}", target.display(), e))?;

        let percent = (((idx + 1) as f64 / files.len() as f64) * 100.0).round() as u32;
        let _ = app.emit(
            "qwen-model-download-progress",
            json!({
                "percent": percent,
                "file": file_name,
                "index": idx + 1,
                "total": files.len(),
                "status": "downloading"
            }),
        );
    }

    get_qwen_model_status(app).await
}

#[tauri::command]
async fn delete_qwen_model(app: AppHandle) -> Result<QwenModelStatus, String> {
    let model_dir = get_qwen_model_dir(&app)?;
    if model_dir.exists() {
        tokio::fs::remove_dir_all(&model_dir)
            .await
            .map_err(|e| format!("Failed to delete qwen model dir: {}", e))?;
    }
    fs::create_dir_all(&model_dir).map_err(|e| format!("Failed to recreate qwen model dir: {}", e))?;
    get_qwen_model_status(app).await
}

#[tauri::command]
async fn get_parakeet_tdt_model_status(app: AppHandle) -> Result<ParakeetModelStatus, String> {
    let model_dir = get_parakeet_tdt_model_dir(&app)?;
    fs::create_dir_all(&model_dir).map_err(|e| format!("Failed to create Parakeet model dir: {}", e))?;

    let expected = required_parakeet_tdt_files();
    let mut downloaded = 0usize;
    let mut missing = Vec::new();
    for file in &expected {
        let p = model_dir.join(file);
        if p.exists() && p.is_file() {
            downloaded += 1;
        } else {
            missing.push(file.clone());
        }
    }

    Ok(ParakeetModelStatus {
        model_dir: model_dir.to_string_lossy().to_string(),
        is_ready: downloaded == expected.len(),
        total_files: expected.len(),
        downloaded_files: downloaded,
        missing_files: missing,
        active_model_dir: ACTIVE_PARAKEET_TDT_MODEL_DIR.lock().unwrap().clone(),
    })
}

#[tauri::command]
async fn download_parakeet_tdt_model(app: AppHandle) -> Result<ParakeetModelStatus, String> {
    let model_dir = get_parakeet_tdt_model_dir(&app)?;
    fs::create_dir_all(&model_dir)
        .map_err(|e| format!("Failed to create Parakeet model dir: {}", e))?;

    let files = fetch_parakeet_tdt_files().await?;
    if files.is_empty() {
        return Err("No downloadable files found for Parakeet-TDT model".to_string());
    }

    let client = Client::builder()
        .user_agent("SpeakShift-Tauri/0.1.0")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    for (idx, file_name) in files.iter().enumerate() {
        let target = model_dir.join(file_name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create model subdir '{}': {}", parent.display(), e))?;
        }

        if !(target.exists() && target.is_file()) {
            let url = format!(
                "https://huggingface.co/{}/resolve/main/{}",
                PARAKEET_TDT_REPO, file_name
            );

            let response = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("Failed downloading '{}': {}", file_name, e))?;

            if !response.status().is_success() {
                return Err(format!(
                    "Failed downloading '{}': HTTP {}",
                    file_name,
                    response.status()
                ));
            }

            let bytes = response
                .bytes()
                .await
                .map_err(|e| format!("Failed reading bytes for '{}': {}", file_name, e))?;

            tokio::fs::write(&target, &bytes)
                .await
                .map_err(|e| format!("Failed writing '{}': {}", target.display(), e))?;
        }

        let percentage = (((idx + 1) as f64 / files.len() as f64) * 100.0).round() as u32;
        let _ = app.emit(
            "parakeet-tdt-model-download-progress",
            json!({
                "percentage": percentage,
                "file": file_name,
                "index": idx + 1,
                "total": files.len(),
            }),
        );
    }

    let default_dir = get_parakeet_tdt_model_dir(&app)?;
    *ACTIVE_PARAKEET_TDT_MODEL_DIR.lock().unwrap() = Some(default_dir.to_string_lossy().to_string());

    get_parakeet_tdt_model_status(app).await
}

#[tauri::command]
fn load_parakeet_tdt_model(app: AppHandle, model_dir: Option<String>) -> Result<String, String> {
    let dir = if let Some(dir) = model_dir {
        PathBuf::from(dir)
    } else {
        get_parakeet_tdt_model_dir(&app)?
    };

    let required = required_parakeet_tdt_files();
    for file in required {
        if !dir.join(&file).exists() {
            return Err(format!(
                "Parakeet-TDT model file missing: '{}' in {}",
                file,
                dir.display()
            ));
        }
    }

    *ACTIVE_PARAKEET_TDT_MODEL_DIR.lock().unwrap() = Some(dir.to_string_lossy().to_string());
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn delete_parakeet_tdt_model(app: AppHandle) -> Result<ParakeetModelStatus, String> {
    let model_dir = get_parakeet_tdt_model_dir(&app)?;
    if model_dir.exists() {
        tokio::fs::remove_dir_all(&model_dir)
            .await
            .map_err(|e| format!("Failed to delete Parakeet-TDT model dir: {}", e))?;
    }
    fs::create_dir_all(&model_dir)
        .map_err(|e| format!("Failed to recreate Parakeet model dir: {}", e))?;
    *ACTIVE_PARAKEET_TDT_MODEL_DIR.lock().unwrap() = None;
    get_parakeet_tdt_model_status(app).await
}

#[tauri::command]
async fn ensure_tdt_model(app: AppHandle) -> Result<ParakeetModelStatus, String> {
    let status = get_parakeet_tdt_model_status(app.clone()).await?;

    if !status.is_ready {
        let _ = download_parakeet_tdt_model(app.clone()).await?;
    }

    load_parakeet_tdt_model(app.clone(), None)?;
    get_parakeet_tdt_model_status(app).await
}

#[tauri::command]
async fn parakeet_transcribe_and_diarize(
    app: AppHandle,
    media_path: String,
    model_dir: Option<String>,
    force_cpu: Option<bool>,
    task_id: Option<String>,
) -> Result<ParakeetTranscribeDiarizeResult, QwenCommandError> {
    ensure_feature_unlocked(&app, "Diarization")
        .map_err(|e| QwenCommandError::new(QwenErrorCode::InvalidInput, e).with_stage("license"))?;
    parakeet_transcribe_and_diarize_impl(&app, &media_path, model_dir, force_cpu, &task_id).await
}

#[tauri::command]
async fn parakeet_diarize_then_transcribe_segments(
    app: AppHandle,
    media_path: String,
    model_dir: Option<String>,
    force_cpu: Option<bool>,
) -> Result<ParakeetTranscribeDiarizeResult, String> {
    ensure_feature_unlocked(&app, "Diarization")?;
    let input = PathBuf::from(&media_path);
    if !input.exists() {
        return Err(format!("Input media path does not exist: {}", media_path));
    }

    let ffmpeg = get_ffmpeg_path(&app).map_err(|e| format!("Failed to locate ffmpeg: {}", e))?;

    let mut work_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    work_dir.push("qwen_pipeline");
    work_dir.push("parakeet");
    fs::create_dir_all(&work_dir).map_err(|e| format!("Failed to create work dir: {}", e))?;

    let wav_path = work_dir.join(format!("parakeet_segmented_input_{}.wav", Uuid::new_v4()));
    let ffmpeg_out = TokioCommand::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(&wav_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run ffmpeg for Parakeet input: {}", e))?;

    if !ffmpeg_out.status.success() {
        return Err(format!(
            "Failed to convert source media to 16k mono WAV: {}",
            String::from_utf8_lossy(&ffmpeg_out.stderr)
        ));
    }

    let audio_samples = load_audio_to_f32_samples(&wav_path.to_string_lossy())
        .map_err(|e| format!("Failed to load converted audio: {}", e))?;

    let diar_model_name = { CURRENT_DIAR_MODEL.lock().unwrap().clone() };
    let diar_model_path = ensure_diarization_model(app.clone(), diar_model_name.clone()).await?;

    let mut diarizer = Sortformer::with_config(&diar_model_path, None, DiarizationConfig::callhome())
        .map_err(|e| format!("Failed to initialize Sortformer: {}", e))?;

    let diar_segments = diarizer
        .diarize(audio_samples.clone(), 16000, 1)
        .map_err(|e| format!("Sortformer diarization failed: {}", e))?;

    let normalized_turns = normalize_diarized_segments(
        diar_segments
            .into_iter()
            .map(|seg: ParakeetSpeakerSegment| DiarizedSegment {
                start_ms: (seg.start * 1000.0).round() as i64,
                end_ms: (seg.end * 1000.0).round() as i64,
                speaker: format!("SPEAKER_{:02}", seg.speaker_id),
            })
            .collect(),
    );

    if normalized_turns.is_empty() {
        return Err("No diarized segments were produced".to_string());
    }

    let resolved_model_dir = if let Some(dir) = model_dir {
        PathBuf::from(dir)
    } else {
        get_active_parakeet_model_dir(&app)
            .map_err(|e| format!("Parakeet-TDT model is not ready: {}", e))?
    };

    let exec_config = resolve_parakeet_exec_config(force_cpu.unwrap_or(false));
    let mut parakeet = ParakeetTDT::from_pretrained(&resolved_model_dir, Some(exec_config))
        .map_err(|e| format!("Failed to load Parakeet-TDT model: {}", e))?;

    let mut out_segments: Vec<ParakeetDiarizedTextSegment> = Vec::new();

    for turn in normalized_turns {
        let start_idx = (((turn.start_ms as f64) / 1000.0) * 16000.0).floor() as usize;
        let end_idx = (((turn.end_ms as f64) / 1000.0) * 16000.0).ceil() as usize;

        let s = start_idx.min(audio_samples.len());
        let e = end_idx.min(audio_samples.len());

        if e <= s {
            continue;
        }

        // Skip ultra-short clips that are usually non-speech artifacts.
        if e - s < 1600 {
            continue;
        }

        let clip = audio_samples[s..e].to_vec();

        let transcribe = parakeet
            .transcribe_samples(clip, 16000, 1, Some(ParakeetTimestampMode::Sentences))
            .map_err(|e| format!("Parakeet-TDT segment transcription failed: {}", e))?;

        let text = transcribe.text.trim().to_string();
        if text.is_empty() {
            continue;
        }

        out_segments.push(ParakeetDiarizedTextSegment {
            start_ms: turn.start_ms,
            end_ms: turn.end_ms,
            speaker: turn.speaker,
            text,
        });
    }

    if out_segments.is_empty() {
        return Err("No transcript text was produced for diarized segments".to_string());
    }

    let full_text = out_segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    Ok(ParakeetTranscribeDiarizeResult {
        audio_path: wav_path.to_string_lossy().to_string(),
        model_dir: resolved_model_dir.to_string_lossy().to_string(),
        diarization_model: diar_model_name,
        full_text,
        segments: out_segments,
    })
}

fn get_qwen3tts_cli_path(app: &AppHandle) -> Result<PathBuf, String> {
    get_sidecar_path(
        app,
        "qwen3tts-cli",
        "x86_64-pc-windows-msvc.exe",
        "x86_64-unknown-linux-gnu",
        "aarch64-apple-darwin",
    )
}

fn map_lang_for_qwen(lang: Option<String>) -> String {
    match lang.unwrap_or_else(|| "english".to_string()).to_lowercase().as_str() {
        "zh" | "chinese" => "chinese".to_string(),
        "en" | "english" => "english".to_string(),
        "ja" | "japanese" => "japanese".to_string(),
        "ko" | "korean" => "korean".to_string(),
        "de" | "german" => "german".to_string(),
        "fr" | "french" => "french".to_string(),
        "ru" | "russian" => "russian".to_string(),
        "es" | "spanish" => "spanish".to_string(),
        "pt" | "portuguese" => "portuguese".to_string(),
        "it" | "italian" => "italian".to_string(),
        other => other.to_string(),
    }
}

fn resolve_qwen_model_dir(app: &AppHandle, model_dir: Option<String>) -> Result<PathBuf, String> {
    if let Some(dir) = model_dir {
        let p = PathBuf::from(&dir);
        if !p.exists() {
            return Err(format!("Qwen model dir does not exist: {}", dir));
        }
        return Ok(p);
    }

    let local_managed = get_qwen_model_dir(app)?;
    if local_managed.exists() {
        let has_any_file = fs::read_dir(&local_managed)
            .map_err(|e| format!("Failed to read qwen model dir: {}", e))?
            .flatten()
            .any(|e| e.path().is_file() || e.path().is_dir());
        if has_any_file {
            return Ok(local_managed);
        }
    }

    if let Ok(env_dir) = std::env::var("QWEN3TTS_MODEL_DIR") {
        let p = PathBuf::from(&env_dir);
        if p.exists() {
            return Ok(p);
        }
    }

    let fallback = PathBuf::from("F:/qwen3tts/Qwen3-TTS-12Hz-0.6B-Base");
    if fallback.exists() {
        return Ok(fallback);
    }

    Err("Qwen model directory not found. Pass modelDir from UI or set QWEN3TTS_MODEL_DIR.".to_string())
}

fn build_demo_preview_text_from_prompt_path(prompt_path: &str) -> String {
    let stem = Path::new(prompt_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Voice".to_string());

    let inferred_name = stem
        .split(['_', '-'])
        .filter(|part| !part.is_empty())
        .next()
        .unwrap_or("Voice")
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect::<String>();

    let display_name = if inferred_name.is_empty() {
        "Voice".to_string()
    } else {
        let mut chars = inferred_name.chars();
        let first = chars.next().unwrap_or('V').to_ascii_uppercase();
        let rest = chars.as_str().to_ascii_lowercase();
        format!("{}{}", first, rest)
    };

    build_demo_preview_text(Some(display_name), prompt_path)
}

fn build_demo_preview_text(voice_name: Option<String>, prompt_path: &str) -> String {
    let mut display_name = voice_name.unwrap_or_default();
    if display_name.trim().is_empty() {
        display_name = Path::new(prompt_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Voice".to_string());
    }

    let name_norm = display_name.to_lowercase();
    let variant_seed = name_norm.bytes().fold(0usize, |acc, b| acc.wrapping_add(b as usize));

    if name_norm.contains("news") || name_norm.contains("anchor") || name_norm.contains("news anchor") {
        let options = [
            format!("Good evening, this is {} with your fast and factual headlines.", display_name),
            format!("Hello, I am {}, delivering clear updates from around the world.", display_name),
            format!("This is {} with a precise news summary you can trust.", display_name),
        ];
        return options[variant_seed % options.len()].clone();
    }

    if name_norm.contains("podcast") || name_norm.contains("podcaster") || name_norm.contains("host") {
        let options = [
            format!("Welcome back, I am {}, and today we dive into a smart and practical topic.", display_name),
            format!("Hi, this is {} with your friendly long-form podcast voice.", display_name),
            format!("You are listening to {}, where ideas feel conversational and human.", display_name),
        ];
        return options[variant_seed % options.len()].clone();
    }

    if name_norm.contains("teacher") || name_norm.contains("coach") || name_norm.contains("tutor") {
        let options = [
            format!("Hello, I am {}, and I break complex topics into easy steps.", display_name),
            format!("Hi, this is {}, teaching with clarity, structure, and patience.", display_name),
            format!("I am {}, your calm guide for practical learning.", display_name),
        ];
        return options[variant_seed % options.len()].clone();
    }

    if name_norm.contains("narrator") || name_norm.contains("story") || name_norm.contains("storyteller") {
        let options = [
            format!("I am {}, and this story begins with a quiet but unforgettable moment.", display_name),
            format!("Hi, I am {}, guiding this narrative with cinematic pacing.", display_name),
            format!("This is {}, bringing characters and scenes to life line by line.", display_name),
        ];
        return options[variant_seed % options.len()].clone();
    }

    if name_norm.contains("asmr") || name_norm.contains("whisper") {
        let options = [
            format!("Hi, I am {}. Let us slow down, breathe, and speak softly.", display_name),
            format!("This is {}, with a gentle and relaxing ASMR tone.", display_name),
            format!("I am {}, using a soft close-mic style for a calm listening experience.", display_name),
        ];
        return options[variant_seed % options.len()].clone();
    }

    if name_norm.contains("deep voice") || name_norm.contains("deep") || name_norm.contains("baritone") {
        let options = [
            format!("I am {}, with a deep and grounded delivery for dramatic reads.", display_name),
            format!("This is {}, speaking with a low, confident, cinematic tone.", display_name),
            format!("Hi, I am {}, offering a resonant voice for trailers and narration.", display_name),
        ];
        return options[variant_seed % options.len()].clone();
    }

    let options = [
        format!("Hi, I am {}, your versatile professional narration voice.", display_name),
        format!("Hello, this is {}, ready for clear and natural spoken content.", display_name),
        format!("I am {}, delivering polished speech for demos and production tests.", display_name),
    ];
    options[variant_seed % options.len()].clone()
}

#[tauri::command]
async fn create_qwen_voice_profile(
    app: AppHandle,
    voice_name: String,
    reference_audio_path: Option<String>,
    reference_blob: Option<Vec<u8>>,
    source_ext: Option<String>,
    reference_text: Option<String>,
    ref_text: Option<String>,
    language: Option<String>,
    model_dir: Option<String>,
    force_cpu: Option<bool>,
    task_id: Option<String>,
) -> Result<QwenVoiceProfileResult, QwenCommandError> {
    emit_qwen_progress(&app, &task_id, 5, "validate", "Validating reference input");

    let reference_path = if let Some(path) = reference_audio_path {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(
                QwenCommandError::new(
                    QwenErrorCode::InvalidAudio,
                    format!("Reference audio file does not exist: {}", path),
                )
                .with_stage("validate")
                .with_hint("Pick an existing WAV/MP3 reference file"),
            );
        }
        path
    } else if let Some(blob) = reference_blob {
        if blob.is_empty() {
            return Err(
                QwenCommandError::new(QwenErrorCode::InvalidAudio, "Reference blob is empty")
                    .with_stage("validate")
                    .with_hint("Record or upload a non-empty reference clip"),
            );
        }

        let mut dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| {
                QwenCommandError::new(
                    QwenErrorCode::Io,
                    format!("Failed to get app local data dir: {}", e),
                )
                .with_stage("validate")
            })?;
        dir.push("qwen_references");
        fs::create_dir_all(&dir)
            .map_err(|e| {
                QwenCommandError::new(
                    QwenErrorCode::Io,
                    format!("Failed to create qwen_references dir: {}", e),
                )
                .with_stage("validate")
            })?;

        let ext = source_ext
            .unwrap_or_else(|| "wav".to_string())
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>();
        let safe_ext = if ext.is_empty() { "wav".to_string() } else { ext };

        let out_path = dir.join(format!("qwen_ref_{}.{}", Uuid::new_v4(), safe_ext));
        fs::write(&out_path, blob).map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to write reference blob: {}", e),
            )
            .with_stage("validate")
        })?;
        out_path.to_string_lossy().to_string()
    } else {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidInput,
                "Reference audio path or blob is required",
            )
            .with_stage("validate")
            .with_hint("Provide either referenceAudioPath or referenceBlob"),
        );
    };

    let cli_path = get_qwen3tts_cli_path(&app).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::CliExecutionFailed,
            format!("Failed to locate qwen3tts-cli: {}", e),
        )
        .with_stage("prepare")
    })?;
    let resolved_model_dir = resolve_qwen_model_dir(&app, model_dir).map_err(|e| {
        QwenCommandError::new(QwenErrorCode::ModelNotFound, e)
            .with_stage("prepare")
            .with_hint("Download the Qwen model or set modelDir/QWEN3TTS_MODEL_DIR")
    })?;
    emit_qwen_progress(&app, &task_id, 20, "prepare", "Preparing prompt output files");

    let out_dir = get_tts_voice_prompts_dir(&app).map_err(|e| {
        QwenCommandError::new(QwenErrorCode::Io, e).with_stage("prepare")
    })?;

    let safe_name = voice_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>();

    let prompt_path = out_dir.join(format!("{}_{}.safetensors", safe_name, Uuid::new_v4()));
    let probe_path = out_dir.join(format!("{}_probe_{}.wav", safe_name, Uuid::new_v4()));

    let use_cpu = force_cpu.unwrap_or(false);
    let device = if use_cpu { "cpu" } else { "cuda" };
    let dtype = if use_cpu { "f32" } else { "bf16" };

    ensure_qwen_vram_headroom(
        &app,
        &task_id,
        use_cpu,
        "This is a saved voice profile probe from SpeakShift.",
        dtype,
        "prepare",
    )
    .await?;

    let mut args: Vec<String> = vec![
        "--model-dir".to_string(),
        resolved_model_dir.to_string_lossy().to_string(),
        "--text".to_string(),
        "This is a saved voice profile probe from SpeakShift.".to_string(),
        "--ref-audio".to_string(),
        reference_path,
        "--language".to_string(),
        map_lang_for_qwen(language),
        "--save-prompt".to_string(),
        prompt_path.to_string_lossy().to_string(),
        "--output".to_string(),
        probe_path.to_string_lossy().to_string(),
        "--device".to_string(),
        device.to_string(),
        "--dtype".to_string(),
        dtype.to_string(),
    ];

    let final_ref_text = ref_text.or(reference_text);
    if let Some(rt) = final_ref_text {
        if !rt.trim().is_empty() {
            args.push("--ref-text".to_string());
            args.push(rt);
        }
    }

    emit_qwen_progress(&app, &task_id, 45, "run", "Running qwen3tts-cli for voice profile");

    let output = TokioCommand::new(&cli_path)
        .current_dir(cli_path.parent().unwrap_or(Path::new(".")))
        .args(args)
        .output()
        .await
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Failed to execute qwen3tts-cli: {}", e),
            )
            .with_stage("run")
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(QwenCommandError::from_cli_failure("run", &stderr, &stdout));
    }

    emit_qwen_progress(&app, &task_id, 85, "verify", "Verifying generated prompt and probe");

    if !prompt_path.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidAudio,
                format!("Prompt profile was not created: {}", prompt_path.display()),
            )
            .with_stage("verify")
            .with_details(format!("stdout:\n{}\nstderr:\n{}", stdout, stderr)),
        );
    }

    if !probe_path.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidAudio,
                format!("Probe audio was not created: {}", probe_path.display()),
            )
            .with_stage("verify")
            .with_details(format!("stdout:\n{}\nstderr:\n{}", stdout, stderr)),
        );
    }

    emit_qwen_progress(&app, &task_id, 92, "normalize", "Normalizing voice probe loudness");
    let normalized_probe_path = normalize_qwen_audio(&app, &probe_path, "qwen_voice_probe").await?;

    emit_qwen_progress(&app, &task_id, 100, "done", "Voice profile created");

    Ok(QwenVoiceProfileResult {
        prompt_path: prompt_path.to_string_lossy().to_string(),
        output_probe_path: normalized_probe_path.to_string_lossy().to_string(),
        model_dir: resolved_model_dir.to_string_lossy().to_string(),
    })
}

fn get_qwen_dubbings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get app local data dir: {}", e))?;
    dir.push("qwen_dubbings");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create qwen_dubbings dir: {}", e))?;
    Ok(dir)
}

fn get_qwen_dubbings_manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_qwen_dubbings_dir(app)?;
    Ok(dir.join("manifest.json"))
}

fn read_qwen_dubbings_manifest(app: &AppHandle) -> Result<Vec<QwenDubbingRecord>, String> {
    let _guard = QWEN_DUBBINGS_LOCK
        .lock()
        .map_err(|e| format!("Failed to lock dubbings manifest: {}", e))?;

    let manifest = get_qwen_dubbings_manifest_path(app)?;
    if !manifest.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&manifest)
        .map_err(|e| format!("Failed to read dubbings manifest: {}", e))?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<QwenDubbingRecord>>(&content)
        .map_err(|e| format!("Failed to parse dubbings manifest: {}", e))
}

fn read_qwen_dubbings_manifest_locked(app: &AppHandle) -> Result<Vec<QwenDubbingRecord>, String> {
    let manifest = get_qwen_dubbings_manifest_path(app)?;
    if !manifest.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&manifest)
        .map_err(|e| format!("Failed to read dubbings manifest: {}", e))?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<QwenDubbingRecord>>(&content)
        .map_err(|e| format!("Failed to parse dubbings manifest: {}", e))
}

fn write_qwen_dubbings_manifest_locked(app: &AppHandle, records: &[QwenDubbingRecord]) -> Result<(), String> {
    let manifest = get_qwen_dubbings_manifest_path(app)?;
    let json = serde_json::to_string_pretty(records)
        .map_err(|e| format!("Failed to serialize dubbings manifest: {}", e))?;

    let tmp_path = manifest.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&tmp_path, json).map_err(|e| format!("Failed to write temp dubbings manifest: {}", e))?;
    fs::rename(&tmp_path, &manifest)
        .map_err(|e| format!("Failed to atomically replace dubbings manifest: {}", e))
}

fn write_qwen_dubbings_manifest(app: &AppHandle, records: &[QwenDubbingRecord]) -> Result<(), String> {
    let _guard = QWEN_DUBBINGS_LOCK
        .lock()
        .map_err(|e| format!("Failed to lock dubbings manifest: {}", e))?;
    write_qwen_dubbings_manifest_locked(app, records)
}

#[tauri::command]
fn list_qwen_dubbings(app: AppHandle) -> Result<Vec<QwenDubbingRecord>, String> {
    let mut records = read_qwen_dubbings_manifest(&app)?;
    records.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    Ok(records)
}

#[tauri::command]
async fn create_qwen_dubbing(
    app: AppHandle,
    title: Option<String>,
    text: String,
    lang: Option<String>,
    ref_lang: Option<String>,
    source_nllb_lang: Option<String>,
    target_nllb_lang: Option<String>,
    prompt_path: String,
    model_dir: Option<String>,
    force_cpu: Option<bool>,
    task_id: Option<String>,
) -> Result<QwenDubbingRecord, QwenCommandError> {
    let _queue_guard = QWEN_SYNTH_LOCK.try_lock().map_err(|_| {
        QwenCommandError::new(
            QwenErrorCode::Busy,
            "Another dubbing is currently running. Please wait for it to finish.",
        )
        .with_stage("queue")
    })?;

    emit_qwen_progress(&app, &task_id, 5, "validate", "Validating dubbing input");

    let trimmed_text = text.trim().to_string();
    if trimmed_text.is_empty() {
        return Err(
            QwenCommandError::new(QwenErrorCode::InvalidInput, "Dubbing text cannot be empty")
                .with_stage("validate"),
        );
    }

    let final_lang = map_lang_for_qwen(lang.clone());
    let src_nllb = source_nllb_lang.unwrap_or_else(|| "eng_Latn".to_string());
    let tgt_nllb = target_nllb_lang.unwrap_or_else(|| "eng_Latn".to_string());

    if src_nllb != tgt_nllb {
        build_qwen_warning(
            &app,
            &task_id,
            "Source and target translation languages differ. Verify translation quality for best dubbing naturalness.",
        );
    }

    if let Some(ref_l) = ref_lang {
        if !ref_l.trim().is_empty() && ref_l.to_lowercase() != final_lang.to_lowercase() {
            build_qwen_warning(
                &app,
                &task_id,
                "Cross-language voice cloning may reduce naturalness. Consider using a reference speaker in the target language.",
            );
        }
    }

    let synth_text = if src_nllb == tgt_nllb {
        trimmed_text.clone()
    } else {
        match translate_text(
            app.clone(),
            trimmed_text.clone(),
            src_nllb,
            tgt_nllb,
            Some(4),
            Some(512),
        )
        .await
        {
            Ok(t) if t.success && !t.translated.trim().is_empty() => {
                let score = t.score.unwrap_or(1.0);
                let bad = score < 0.6 || is_translation_suspicious(&trimmed_text, &t.translated);
                if bad {
                    build_qwen_warning(
                        &app,
                        &task_id,
                        &format!(
                            "Low-confidence translation detected for dubbing text (score {:.2}). Using original text.",
                            score
                        ),
                    );
                    trimmed_text.clone()
                } else {
                    t.translated
                }
            }
            Ok(_) => {
                build_qwen_warning(
                    &app,
                    &task_id,
                    "Translation returned empty output for dubbing text. Using original text.",
                );
                trimmed_text.clone()
            }
            Err(_) => {
                build_qwen_warning(
                    &app,
                    &task_id,
                    "Translation step failed for dubbing text. Using original text.",
                );
                trimmed_text.clone()
            }
        }
    };

    let prompt = PathBuf::from(&prompt_path);
    if !prompt.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidInput,
                format!("Prompt path does not exist: {}", prompt_path),
            )
            .with_stage("validate")
            .with_hint("Create or select a valid voice profile prompt file"),
        );
    }

    let resolved_model_dir = resolve_qwen_model_dir(&app, model_dir).map_err(|e| {
        QwenCommandError::new(QwenErrorCode::ModelNotFound, e)
            .with_stage("prepare")
            .with_hint("Download the Qwen model before running dubbing")
    })?;
    emit_qwen_progress(&app, &task_id, 20, "prepare", "Preparing dubbing output path");

    let use_cpu = force_cpu.unwrap_or(false);
    let device = if use_cpu { "cpu" } else { "cuda" };
    let dtype = if use_cpu { "f32" } else { "bf16" };

    ensure_qwen_vram_headroom(&app, &task_id, use_cpu, &synth_text, dtype, "prepare").await?;

    let mut out_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to get app local data dir: {}", e),
            )
            .with_stage("prepare")
        })?;
    out_dir.push("qwen_tts_outputs");
    fs::create_dir_all(&out_dir).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::Io,
            format!("Failed to create qwen_tts_outputs dir: {}", e),
        )
        .with_stage("prepare")
    })?;

    let output_path = out_dir.join(format!("qwen_dubbing_{}.wav", Uuid::new_v4()));
    register_qwen_task_file(&task_id, &output_path).await;

    let cli_path = get_qwen3tts_cli_path(&app).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::CliExecutionFailed,
            format!("Failed to locate qwen3tts-cli: {}", e),
        )
        .with_stage("prepare")
    })?;
    let args: Vec<String> = vec![
        "--model-dir".to_string(),
        resolved_model_dir.to_string_lossy().to_string(),
        "--text".to_string(),
        synth_text.clone(),
        "--load-prompt".to_string(),
        prompt_path.clone(),
        "--language".to_string(),
        final_lang.clone(),
        "--output".to_string(),
        output_path.to_string_lossy().to_string(),
        "--device".to_string(),
        device.to_string(),
        "--dtype".to_string(),
        dtype.to_string(),
    ];

    emit_qwen_progress(&app, &task_id, 45, "run", "Running qwen3tts-cli dubbing synthesis");

    let mut child = TokioCommand::new(&cli_path)
        .current_dir(cli_path.parent().unwrap_or(Path::new(".")))
        .args(args)
        .spawn()
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Failed to execute qwen3tts-cli for dubbing: {}", e),
            )
            .with_stage("run")
        })?;

    let child_pid = child.id();
    register_qwen_task_pid(&task_id, child_pid).await;
    let output = child.wait_with_output().await.map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::CliExecutionFailed,
            format!("Failed while waiting for qwen3tts-cli dubbing process: {}", e),
        )
        .with_stage("run")
    })?;
    unregister_qwen_task_pid(&task_id, child_pid).await;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(QwenCommandError::from_cli_failure("run", &stderr, &stdout));
    }

    emit_qwen_progress(&app, &task_id, 75, "normalize", "Normalizing dubbing loudness");

    let normalized_output_path = normalize_qwen_audio(&app, &output_path, "qwen_dubbing").await?;
    register_qwen_task_file(&task_id, &normalized_output_path).await;

    emit_qwen_progress(&app, &task_id, 85, "verify", "Verifying generated dubbing audio");

    if !normalized_output_path.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidAudio,
                format!(
                    "Dubbing output was not created: {}",
                    normalized_output_path.display()
                ),
            )
            .with_stage("verify"),
        );
    }

    let generated_title = {
        let fallback = if trimmed_text.len() > 48 {
            format!("{}...", &trimmed_text[..48])
        } else {
            trimmed_text.clone()
        };
        title.unwrap_or(fallback).trim().to_string()
    };

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to compute timestamp: {}", e),
            )
            .with_stage("persist")
        })?
        .as_millis() as u64;

    let record = QwenDubbingRecord {
        id: Uuid::new_v4().to_string(),
        title: if generated_title.is_empty() {
            "Untitled dubbing".to_string()
        } else {
            generated_title
        },
        text: synth_text,
        lang: final_lang,
        prompt_path,
        output_path: normalized_output_path.to_string_lossy().to_string(),
        created_at_ms: now_ms,
    };

    {
        let _guard = QWEN_DUBBINGS_LOCK.lock().map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to lock dubbings manifest: {}", e),
            )
            .with_stage("persist")
        })?;
        let mut records = read_qwen_dubbings_manifest_locked(&app)
            .map_err(|e| QwenCommandError::new(QwenErrorCode::Io, e).with_stage("persist"))?;
        records.push(record.clone());
        write_qwen_dubbings_manifest_locked(&app, &records)
            .map_err(|e| QwenCommandError::new(QwenErrorCode::Io, e).with_stage("persist"))?;
    }

    emit_qwen_progress(&app, &task_id, 100, "done", "Dubbing created");

    unregister_qwen_task_file(&task_id, &normalized_output_path).await;
    clear_qwen_task_tracking(&task_id).await;

    Ok(record)
}

#[tauri::command]
async fn start_qwen_dubbing_pipeline(
    app: AppHandle,
    source_media_path: String,
    prompt_path: String,
    title: Option<String>,
    target_lang: Option<String>,
    ref_lang: Option<String>,
    source_nllb_lang: Option<String>,
    target_nllb_lang: Option<String>,
    model_dir: Option<String>,
    force_cpu: Option<bool>,
    task_id: Option<String>,
    keep_intermediates: Option<bool>,
) -> Result<QwenPipelineResult, QwenCommandError> {
    let _queue_guard = QWEN_SYNTH_LOCK.try_lock().map_err(|_| {
        QwenCommandError::new(
            QwenErrorCode::Busy,
            "Another dubbing is currently running. Please wait for it to finish.",
        )
        .with_stage("queue")
    })?;

    let mut intermediates: Vec<PathBuf> = Vec::new();
    emit_qwen_progress(&app, &task_id, 2, "validate", "Validating dubbing pipeline inputs");
    ensure_task_not_cancelled_with_cleanup(&app, &task_id, &intermediates).await?;

    let keep_intermediates = keep_intermediates.unwrap_or(false);

    let source_path = PathBuf::from(&source_media_path);
    if !source_path.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidInput,
                format!("Source media does not exist: {}", source_media_path),
            )
            .with_stage("validate"),
        );
    }

    let prompt = PathBuf::from(&prompt_path);
    if !prompt.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidInput,
                format!("Prompt path does not exist: {}", prompt_path),
            )
            .with_stage("validate"),
        );
    }

    let final_lang = map_lang_for_qwen(target_lang.clone());
    if let Some(ref_l) = ref_lang {
        if !ref_l.trim().is_empty() && ref_l.to_lowercase() != final_lang.to_lowercase() {
            build_qwen_warning(
                &app,
                &task_id,
                "Cross-language voice cloning may reduce naturalness. Consider using a reference speaker in the target language.",
            );
        }
    }

    emit_qwen_progress(&app, &task_id, 8, "prepare-model", "Ensuring Parakeet-TDT model availability");
    ensure_tdt_model(app.clone()).await.map_err(|e| {
        QwenCommandError::new(QwenErrorCode::ModelNotFound, e)
            .with_stage("prepare-model")
            .with_hint("Download Parakeet-TDT model from Settings if this persists")
    })?;

    emit_qwen_progress(&app, &task_id, 12, "parakeet", "Running Parakeet transcription + diarization");

    let parakeet = parakeet_transcribe_and_diarize_impl(
        &app,
        &source_media_path,
        None,
        force_cpu,
        &task_id,
    )
    .await?;

    if parakeet.segments.is_empty() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidAudio,
                "No transcribed segments were produced by Parakeet",
            )
            .with_stage("parakeet"),
        );
    }

    let src_nllb = source_nllb_lang.unwrap_or_else(|| "eng_Latn".to_string());
    let tgt_nllb = target_nllb_lang.unwrap_or_else(|| "eng_Latn".to_string());

    emit_qwen_progress(&app, &task_id, 36, "translate", "Translating diarized segments");

    let mut translated_segments: Vec<(ParakeetDiarizedTextSegment, String)> = Vec::new();
    for (idx, seg) in parakeet.segments.iter().enumerate() {
        ensure_task_not_cancelled_with_cleanup(&app, &task_id, &intermediates).await?;
        let pct = 36 + (((idx + 1) as f32 / parakeet.segments.len() as f32) * 20.0) as u32;
        emit_qwen_progress(
            &app,
            &task_id,
            pct.min(56),
            "translate",
            &format!("Translating segment {}/{}", idx + 1, parakeet.segments.len()),
        );

        let translated = if seg.text.trim().is_empty() || src_nllb == tgt_nllb {
            seg.text.clone()
        } else {
            match translate_text(
                app.clone(),
                seg.text.clone(),
                src_nllb.clone(),
                tgt_nllb.clone(),
                Some(4),
                Some(512),
            )
            .await
            {
                Ok(t) if t.success && !t.translated.trim().is_empty() => {
                    let score = t.score.unwrap_or(1.0);
                    let bad = score < 0.6 || is_translation_suspicious(&seg.text, &t.translated);
                    if bad {
                        build_qwen_warning(
                            &app,
                            &task_id,
                            &format!(
                                "Low-confidence translation detected for a segment (score {:.2}). Using original text.",
                                score
                            ),
                        );
                        seg.text.clone()
                    } else {
                        t.translated
                    }
                }
                Ok(_) => {
                    build_qwen_warning(
                        &app,
                        &task_id,
                        "Translation returned empty output for a segment. Using original text.",
                    );
                    seg.text.clone()
                }
                Err(_) => seg.text.clone(),
            }
        };

        translated_segments.push((seg.clone(), translated));
    }

    emit_qwen_progress(&app, &task_id, 58, "chunk", "Chunking translated text for synthesis");

    let mut chunk_plan: Vec<(String, f32)> = Vec::new();
    for (original_seg, translated_text) in &translated_segments {
        let chunks = split_sentence_aware(translated_text, 180);
        if chunks.is_empty() {
            continue;
        }

        let total_words = chunks
            .iter()
            .map(|c| c.split_whitespace().count().max(1))
            .sum::<usize>()
            .max(1);

        let seg_duration = ((original_seg.end_ms - original_seg.start_ms).max(350) as f32) / 1000.0;
        for chunk in chunks {
            let words = chunk.split_whitespace().count().max(1);
            let target_dur = seg_duration * (words as f32 / total_words as f32);
            chunk_plan.push((chunk, target_dur.max(0.35)));
        }
    }

    if chunk_plan.is_empty() {
        return Err(
            QwenCommandError::new(QwenErrorCode::InvalidInput, "No valid text chunks to synthesize")
                .with_stage("chunk"),
        );
    }

    let resolved_model_dir = resolve_qwen_model_dir(&app, model_dir).map_err(|e| {
        QwenCommandError::new(QwenErrorCode::ModelNotFound, e)
            .with_stage("prepare")
            .with_hint("Download the Qwen model before running dubbing pipeline")
    })?;

    let use_cpu = force_cpu.unwrap_or(false);
    let device = if use_cpu { "cpu" } else { "cuda" };
    let dtype = if use_cpu { "f32" } else { "bf16" };
    let cli_path = get_qwen3tts_cli_path(&app).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::CliExecutionFailed,
            format!("Failed to locate qwen3tts-cli: {}", e),
        )
        .with_stage("prepare")
    })?;

    let mut work_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to get app local data dir: {}", e),
            )
            .with_stage("prepare")
        })?;
    work_dir.push("qwen_pipeline");
    let chunks_dir = work_dir.join("chunks");
    fs::create_dir_all(&chunks_dir).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::Io,
            format!("Failed to create pipeline chunk dir: {}", e),
        )
        .with_stage("prepare")
    })?;

    emit_qwen_progress(&app, &task_id, 62, "synthesize", "Synthesizing translated chunks");

    let mut synthesized_paths = Vec::new();
    for (idx, (chunk_text, duration_hint)) in chunk_plan.iter().enumerate() {
        ensure_task_not_cancelled_with_cleanup(&app, &task_id, &intermediates).await?;
        let progress = 62 + (((idx + 1) as f32 / chunk_plan.len() as f32) * 24.0) as u32;
        emit_qwen_progress(
            &app,
            &task_id,
            progress.min(86),
            "synthesize",
            &format!("Synthesizing chunk {}/{}", idx + 1, chunk_plan.len()),
        );

        let raw_chunk = chunks_dir.join(format!("raw_chunk_{:04}_{}.wav", idx, Uuid::new_v4()));
        register_qwen_task_file(&task_id, &raw_chunk).await;

        ensure_qwen_vram_headroom(
            &app,
            &task_id,
            use_cpu,
            chunk_text,
            dtype,
            "synthesize",
        )
        .await?;

        let args = vec![
            "--model-dir".to_string(),
            resolved_model_dir.to_string_lossy().to_string(),
            "--text".to_string(),
            chunk_text.clone(),
            "--load-prompt".to_string(),
            prompt_path.clone(),
            "--language".to_string(),
            final_lang.clone(),
            "--output".to_string(),
            raw_chunk.to_string_lossy().to_string(),
            "--device".to_string(),
            device.to_string(),
            "--dtype".to_string(),
            dtype.to_string(),
        ];

        let mut child = TokioCommand::new(&cli_path)
            .current_dir(cli_path.parent().unwrap_or(Path::new(".")))
            .args(args)
            .spawn()
            .map_err(|e| {
                QwenCommandError::new(
                    QwenErrorCode::CliExecutionFailed,
                    format!("Failed to execute qwen3tts-cli in pipeline: {}", e),
                )
                .with_stage("synthesize")
            })?;

        let child_pid = child.id();
        register_qwen_task_pid(&task_id, child_pid).await;
        let out = child.wait_with_output().await.map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Failed while waiting for pipeline chunk synthesis process: {}", e),
            )
            .with_stage("synthesize")
        })?;
        unregister_qwen_task_pid(&task_id, child_pid).await;

        if !out.status.success() {
            return Err(QwenCommandError::from_cli_failure(
                "synthesize",
                &String::from_utf8_lossy(&out.stderr),
                &String::from_utf8_lossy(&out.stdout),
            ));
        }

        intermediates.push(raw_chunk.clone());

        let normalized = normalize_qwen_audio(&app, &raw_chunk, "pipeline_chunk").await?;
        register_qwen_task_file(&task_id, &normalized).await;
        intermediates.push(normalized.clone());
        let hinted = chunks_dir.join(format!("hinted_chunk_{:04}_{}.wav", idx, Uuid::new_v4()));
        register_qwen_task_file(&task_id, &hinted).await;
        let (adjusted, _factor) =
            adjust_audio_duration(&app, &normalized, *duration_hint, &hinted, &task_id).await?;
        register_qwen_task_file(&task_id, &adjusted).await;
        intermediates.push(adjusted.clone());
        synthesized_paths.push(adjusted);
    }

    emit_qwen_progress(&app, &task_id, 88, "concat", "Crossfading synthesized chunks");

    let final_audio_unorm = work_dir.join(format!("qwen_pipeline_audio_raw_{}.wav", Uuid::new_v4()));
    register_qwen_task_file(&task_id, &final_audio_unorm).await;
    crossfade_concat_wavs(&app, &synthesized_paths, &final_audio_unorm, 120).await?;
    intermediates.push(final_audio_unorm.clone());

    emit_qwen_progress(&app, &task_id, 92, "normalize", "Normalizing final dubbing audio");
    let final_audio_path = normalize_qwen_audio(&app, &final_audio_unorm, "qwen_pipeline_final").await?;
    register_qwen_task_file(&task_id, &final_audio_path).await;

    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let is_video = ["mp4", "mkv", "mov", "webm", "avi", "m4v"].contains(&ext.as_str());

    emit_qwen_progress(&app, &task_id, 95, "mux", "Muxing dubbed audio back to source video");

    let mut final_video_path: Option<String> = None;
    if is_video {
        let ffmpeg = get_ffmpeg_path(&app).map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Failed to locate ffmpeg: {}", e),
            )
            .with_stage("mux")
        })?;

        let output_video = work_dir.join(format!("qwen_pipeline_video_{}.mp4", Uuid::new_v4()));
        let mux = TokioCommand::new(ffmpeg)
            .arg("-y")
            .arg("-i")
            .arg(&source_path)
            .arg("-i")
            .arg(&final_audio_path)
            .arg("-map")
            .arg("0:v:0")
            .arg("-map")
            .arg("1:a:0")
            .arg("-c:v")
            .arg("copy")
            .arg("-c:a")
            .arg("aac")
            .arg("-shortest")
            .arg(&output_video)
            .output()
            .await
            .map_err(|e| {
                QwenCommandError::new(
                    QwenErrorCode::CliExecutionFailed,
                    format!("Failed to execute ffmpeg mux step: {}", e),
                )
                .with_stage("mux")
            })?;

        if mux.status.success() && output_video.exists() {
            final_video_path = Some(output_video.to_string_lossy().to_string());
        }
    }

    if !keep_intermediates {
        for p in intermediates {
            if p != final_audio_path {
                let _ = fs::remove_file(p);
            }
        }
    }

    unregister_qwen_task_file(&task_id, &final_audio_path).await;

    let translated_full_text = translated_segments
        .iter()
        .map(|(_, t)| t.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to compute timestamp: {}", e),
            )
            .with_stage("persist")
        })?
        .as_millis() as u64;

    let generated_title = title
        .unwrap_or_else(|| {
            if translated_full_text.len() > 48 {
                format!("{}...", &translated_full_text[..48])
            } else {
                translated_full_text.clone()
            }
        })
        .trim()
        .to_string();

    let record = QwenDubbingRecord {
        id: Uuid::new_v4().to_string(),
        title: if generated_title.is_empty() {
            "Untitled dubbing".to_string()
        } else {
            generated_title
        },
        text: translated_full_text,
        lang: final_lang,
        prompt_path,
        output_path: final_audio_path.to_string_lossy().to_string(),
        created_at_ms: now_ms,
    };

    {
        let _guard = QWEN_DUBBINGS_LOCK.lock().map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to lock dubbings manifest: {}", e),
            )
            .with_stage("persist")
        })?;
        let mut records = read_qwen_dubbings_manifest_locked(&app)
            .map_err(|e| QwenCommandError::new(QwenErrorCode::Io, e).with_stage("persist"))?;
        records.push(record.clone());
        write_qwen_dubbings_manifest_locked(&app, &records)
            .map_err(|e| QwenCommandError::new(QwenErrorCode::Io, e).with_stage("persist"))?;
    }

    emit_qwen_progress(&app, &task_id, 100, "done", "Qwen dubbing pipeline finished");

    if let Some(id) = task_id.as_ref() {
        CANCELLED_QWEN_TASKS.lock().await.remove(id);
    }
    clear_qwen_task_tracking(&task_id).await;

    Ok(QwenPipelineResult {
        record,
        final_audio_path: final_audio_path.to_string_lossy().to_string(),
        final_video_path,
        segment_count: translated_segments.len(),
    })
}

#[tauri::command]
async fn synthesize_qwen_preview(
    app: AppHandle,
    prompt_path: String,
    voice_name: Option<String>,
    text: Option<String>,
    lang: Option<String>,
    model_dir: Option<String>,
    force_cpu: Option<bool>,
    task_id: Option<String>,
) -> Result<String, QwenCommandError> {
    emit_qwen_progress(&app, &task_id, 5, "validate", "Validating preview inputs");

    let prompt = PathBuf::from(&prompt_path);
    if !prompt.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidInput,
                format!("Prompt path does not exist: {}", prompt_path),
            )
            .with_stage("validate"),
        );
    }

    let resolved_model_dir = resolve_qwen_model_dir(&app, model_dir).map_err(|e| {
        QwenCommandError::new(QwenErrorCode::ModelNotFound, e)
            .with_stage("prepare")
            .with_hint("Download the Qwen model before creating previews")
    })?;

    let inferred_demo_text = build_demo_preview_text(voice_name.clone(), &prompt_path);

    let final_text = text
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(inferred_demo_text);
    let final_lang = map_lang_for_qwen(lang);

    emit_qwen_progress(&app, &task_id, 25, "prepare", "Preparing preview synthesis");

    let use_cpu = force_cpu.unwrap_or(false);
    let device = if use_cpu { "cpu" } else { "cuda" };
    let dtype = if use_cpu { "f32" } else { "bf16" };

    let mut out_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::Io,
                format!("Failed to get app local data dir: {}", e),
            )
            .with_stage("prepare")
        })?;
    out_dir.push("qwen_tts_outputs");
    fs::create_dir_all(&out_dir).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::Io,
            format!("Failed to create qwen_tts_outputs dir: {}", e),
        )
        .with_stage("prepare")
    })?;

    let output_path = out_dir.join(format!("qwen_preview_{}.wav", Uuid::new_v4()));
    let cli_path = get_qwen3tts_cli_path(&app).map_err(|e| {
        QwenCommandError::new(
            QwenErrorCode::CliExecutionFailed,
            format!("Failed to locate qwen3tts-cli: {}", e),
        )
        .with_stage("prepare")
    })?;

    let args: Vec<String> = vec![
        "--model-dir".to_string(),
        resolved_model_dir.to_string_lossy().to_string(),
        "--text".to_string(),
        final_text,
        "--load-prompt".to_string(),
        prompt_path,
        "--language".to_string(),
        final_lang,
        "--output".to_string(),
        output_path.to_string_lossy().to_string(),
        "--device".to_string(),
        device.to_string(),
        "--dtype".to_string(),
        dtype.to_string(),
    ];

    emit_qwen_progress(&app, &task_id, 55, "run", "Running qwen3tts-cli preview synthesis");

    let output = TokioCommand::new(&cli_path)
        .current_dir(cli_path.parent().unwrap_or(Path::new(".")))
        .args(args)
        .output()
        .await
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Failed to execute qwen3tts-cli preview: {}", e),
            )
            .with_stage("run")
        })?;

    if !output.status.success() {
        return Err(QwenCommandError::from_cli_failure(
            "run",
            &String::from_utf8_lossy(&output.stderr),
            &String::from_utf8_lossy(&output.stdout),
        ));
    }

    if !output_path.exists() {
        return Err(
            QwenCommandError::new(
                QwenErrorCode::InvalidAudio,
                format!("Preview output was not created: {}", output_path.display()),
            )
            .with_stage("verify"),
        );
    }

    emit_qwen_progress(&app, &task_id, 80, "normalize", "Normalizing preview loudness");

    let normalized = normalize_qwen_audio(&app, &output_path, "qwen_preview").await?;

    emit_qwen_progress(&app, &task_id, 100, "done", "Preview ready");

    Ok(normalized.to_string_lossy().to_string())
}

#[tauri::command]
fn read_artifact_bytes(path: String) -> Result<Vec<u8>, String> {
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(format!("Artifact file does not exist: {}", path));
    }
    fs::read(&pb).map_err(|e| format!("Failed to read artifact bytes: {}", e))
}

fn get_sidecar_path(
    app: &AppHandle,
    base_name: &str,                // e.g. "ffmpeg", "whisper-cli", "yt-dlp", "nllb-translation"
    windows_suffix: &str,           // e.g. "x86_64-pc-windows-msvc.exe"
    linux_suffix: &str,             // e.g. "x86_64-unknown-linux-gnu"
    macos_suffix: &str,             // e.g. "x86_64-apple-darwin" or "aarch64-apple-darwin"
) -> Result<PathBuf, String> {
    println!("[SIDECAR] Looking for '{}'", base_name);

    // Helper that takes &Path (works with both PathBuf and &Path)
    let check = |path: &Path, label: &str| -> Option<PathBuf> {
        if path.exists() && path.is_file() {
            println!("[SIDECAR] Found {} at: {}", label, path.display());
            Some(path.to_path_buf())
        } else {
            println!("[SIDECAR] Not found at {}: {}", label, path.display());
            None
        }
    };

    // ────────────────────────────────────────────────
    // 1. Next to the executable (very common in dev & some Windows bundles)
    // ────────────────────────────────────────────────
    let exe_dir = match std::env::current_exe() {
        Ok(path) => match path.parent() {
            Some(dir) => dir.to_path_buf(),
            None => return Err("Cannot get parent directory of executable".to_string()),
        },
        Err(e) => return Err(format!("Cannot get current executable path: {}", e)),
    };

    let exe_candidates: Vec<PathBuf> = if cfg!(debug_assertions) {
        vec![exe_dir.join(base_name)]
    } else if cfg!(target_os = "windows") {
        vec![
            exe_dir.join(format!("{}.exe", base_name)),
            exe_dir.join(format!("{}-{}", base_name, windows_suffix)),
        ]
    } else if cfg!(target_os = "linux") {
        vec![
            exe_dir.join(base_name),
            exe_dir.join(format!("{}-{}", base_name, linux_suffix)),
        ]
    } else { // macOS
        vec![
            exe_dir.join(base_name),
            exe_dir.join(format!("{}-{}", base_name, macos_suffix)),
        ]
    };

    for candidate in &exe_candidates {
        if let Some(p) = check(candidate, "next to exe") {
            return Ok(p);
        }
    }

    // ────────────────────────────────────────────────
    // 2. Resources directory — standard Tauri bundled location
    // ────────────────────────────────────────────────
    let res_dir = match app.path().resource_dir() {
        Ok(dir) => dir,
        Err(e) => return Err(format!("Cannot get resource directory: {}", e)),
    };

    println!("[SIDECAR] Resources dir: {}", res_dir.display());

    let res_candidates: Vec<String> = if cfg!(target_os = "windows") {
        vec![
            format!("{}-{}", base_name, windows_suffix),
            format!("{}.exe", base_name),
            format!("binaries/{}-{}", base_name, windows_suffix),
            format!("binaries/{}.exe", base_name),
        ]
    } else if cfg!(target_os = "linux") {
        vec![
            format!("{}-{}", base_name, linux_suffix),
            base_name.to_string(),
            format!("binaries/{}-{}", base_name, linux_suffix),
            format!("binaries/{}", base_name),
        ]
    } else { // macOS
        vec![
            format!("{}-{}", base_name, macos_suffix),
            base_name.to_string(),
            format!("binaries/{}-{}", base_name, macos_suffix),
            format!("binaries/{}", base_name),
        ]
    };

    for rel_path in &res_candidates {
        let full_path = res_dir.join(rel_path);
        if let Some(p) = check(&full_path, "resources") {
            return Ok(p);
        }
    }

    // ────────────────────────────────────────────────
    // 3. Platform-specific fallbacks
    // ────────────────────────────────────────────────
    if cfg!(target_os = "linux") {
        let system_paths = [
            format!("/usr/bin/{}", base_name),
            format!("/usr/local/bin/{}", base_name),
        ];

        for sys_path_str in system_paths {
            let sys_path = Path::new(&sys_path_str);
            if let Some(p) = check(sys_path, "system path") {
                return Ok(p);
            }
        }
    }

    // macOS: no common extra system path fallback (Gatekeeper usually prevents this anyway)

    // ────────────────────────────────────────────────
    // Final detailed error message
    // ────────────────────────────────────────────────
    Err(format!(
        "Sidecar '{}' not found on {}.\n\
         • Tried next to exe:\n  {}\n\
         • Tried in resources ({}):\n  {}\n\
         • Linux system paths (if applicable): /usr/bin/{} , /usr/local/bin/{}\n\
         • Recommendation: Prefer Command::new_sidecar(\"{}\") — it resolves automatically",
        base_name,
        if cfg!(target_os = "windows") {
            "Windows"
        } else if cfg!(target_os = "linux") {
            "Linux"
        } else {
            "macOS"
        },
        exe_candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join("\n  "),
        res_dir.display(),
        res_candidates.join("\n  "),
        base_name,
        base_name,
        base_name
    ))
}

const OFFLINE_LICENSE_PUBLIC_KEY_B64: &str =
    match option_env!("SPEAKSHIFT_LICENSE_PUBLIC_KEY_B64") {
        Some(v) => v,
        None => "REPLACE_WITH_YOUR_ED25519_PUBLIC_KEY_BASE64",
    };

#[derive(serde::Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OfflineLicensePayload {
    schema_version: u8,
    plan: String,
    buyer_name: String,
    buyer_email: String,
    license_id: String,
    issued_at: i64,
    perpetual: bool,
}

#[derive(serde::Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SignedOfflineLicense {
    payload: OfflineLicensePayload,
    signature: String,
}

#[derive(serde::Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StoredOfflineLicense {
    schema_version: u8,
    activated_at: i64,
    signed_license: SignedOfflineLicense,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineLicenseStatus {
    is_pro: bool,
    plan: String,
    buyer_name: Option<String>,
    buyer_email: Option<String>,
    license_id: Option<String>,
    activated_at: Option<i64>,
    message: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EntitlementStatus {
    is_pro: bool,
    plan: String,
    locked_features: Vec<String>,
    message: String,
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn get_license_state_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .ok()
        .map(PathBuf::from)
        .or_else(|| app.path().app_config_dir().ok())
        .or_else(|| app.path().app_local_data_dir().ok())
        .ok_or_else(|| "Failed to resolve writable user directory for license state".to_string())?;

    let dir = base.join(".speakshift").join("license");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create license state directory {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn get_offline_license_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_license_state_root(app)?.join("offline_license.json"))
}

fn evaluate_entitlement(app: &AppHandle) -> Result<EntitlementStatus, String> {
    let is_pro = match get_offline_license_status(app.clone()) {
        Ok(status) => status.is_pro,
        Err(_) => false,
    };

    let message = if is_pro {
        "Pro unlocked".to_string()
    } else {
        "Free tier active. Enter your offline Pro key in Profile to unlock Batch, Diarization, and Translation."
            .to_string()
    };

    Ok(EntitlementStatus {
        is_pro,
        plan: if is_pro { "pro".to_string() } else { "free".to_string() },
        locked_features: if is_pro {
            Vec::new()
        } else {
            vec![
                "Batch transcription".to_string(),
                "Diarization".to_string(),
                "Translation".to_string(),
            ]
        },
        message,
    })
}

fn ensure_feature_unlocked(app: &AppHandle, feature_name: &str) -> Result<(), String> {
    let entitlement = evaluate_entitlement(app)?;
    if entitlement.is_pro {
        return Ok(());
    }

    Err(format!(
        "{} is a Pro feature. Enter a valid offline Pro key in Profile > Offline Pro Activation to unlock.",
        feature_name
    ))
}

#[tauri::command]
fn get_entitlement_status(app: AppHandle) -> Result<EntitlementStatus, String> {
    evaluate_entitlement(&app)
}

fn decode_b64_any(input: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(input)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(input))
        .map_err(|e| format!("Base64 decode failed: {}", e))
}

fn verify_signed_offline_license(signed: &SignedOfflineLicense) -> Result<(), String> {
    if OFFLINE_LICENSE_PUBLIC_KEY_B64.starts_with("REPLACE_WITH_") {
        return Err("Offline license public key is not configured in the app binary".to_string());
    }

    let pubkey_vec = decode_b64_any(OFFLINE_LICENSE_PUBLIC_KEY_B64)?;
    let pubkey_bytes: [u8; 32] = pubkey_vec
        .try_into()
        .map_err(|_| "Invalid public key length; expected 32 bytes".to_string())?;
    let verify_key =
        VerifyingKey::from_bytes(&pubkey_bytes).map_err(|e| format!("Invalid public key: {}", e))?;

    let sig_vec = decode_b64_any(&signed.signature)?;
    let sig_bytes: [u8; 64] = sig_vec
        .try_into()
        .map_err(|_| "Invalid signature length; expected 64 bytes".to_string())?;
    let signature = Signature::from_bytes(&sig_bytes);

    let payload_bytes = serde_json::to_vec(&signed.payload)
        .map_err(|e| format!("Failed to serialize license payload: {}", e))?;
    verify_key
        .verify(&payload_bytes, &signature)
        .map_err(|_| "License signature verification failed".to_string())?;

    if !signed.payload.perpetual {
        return Err("Only perpetual offline licenses are accepted".to_string());
    }
    if signed.payload.plan.to_ascii_lowercase() != "pro" {
        return Err("License plan is not Pro".to_string());
    }

    Ok(())
}

fn parse_signed_license_key(raw_key: &str) -> Result<SignedOfflineLicense, String> {
    let mut token = raw_key.trim().to_string();
    if token.starts_with("SS1-") {
        token = token[4..].to_string();
    }

    let bytes = decode_b64_any(&token)?;
    let json = String::from_utf8(bytes).map_err(|e| format!("License token is not valid UTF-8: {}", e))?;
    serde_json::from_str::<SignedOfflineLicense>(&json)
        .map_err(|e| format!("License token JSON is invalid: {}", e))
}

fn to_free_status(message: &str) -> OfflineLicenseStatus {
    OfflineLicenseStatus {
        is_pro: false,
        plan: "free".to_string(),
        buyer_name: None,
        buyer_email: None,
        license_id: None,
        activated_at: None,
        message: message.to_string(),
    }
}

#[tauri::command]
fn get_offline_license_status(app: AppHandle) -> Result<OfflineLicenseStatus, String> {
    let license_file = get_offline_license_file(&app)?;
    if !license_file.exists() {
        return Ok(to_free_status("No offline license activated"));
    }

    let content = fs::read_to_string(&license_file)
        .map_err(|e| format!("Failed to read offline license file: {}", e))?;
    let stored: StoredOfflineLicense = serde_json::from_str(&content)
        .map_err(|e| format!("Offline license file is invalid JSON: {}", e))?;

    verify_signed_offline_license(&stored.signed_license)?;

    Ok(OfflineLicenseStatus {
        is_pro: true,
        plan: stored.signed_license.payload.plan.clone(),
        buyer_name: Some(stored.signed_license.payload.buyer_name.clone()),
        buyer_email: Some(stored.signed_license.payload.buyer_email.clone()),
        license_id: Some(stored.signed_license.payload.license_id.clone()),
        activated_at: Some(stored.activated_at),
        message: "Offline Pro license active".to_string(),
    })
}

#[tauri::command]
fn activate_offline_license(
    app: AppHandle,
    license_key: String,
    name: String,
    email: String,
) -> Result<OfflineLicenseStatus, String> {
    let entered_name = name.trim();
    let entered_email = email.trim();
    if entered_name.is_empty() || entered_email.is_empty() {
        return Err("Name and email are required for offline activation".to_string());
    }

    let signed = parse_signed_license_key(&license_key)?;
    verify_signed_offline_license(&signed)?;

    if !signed
        .payload
        .buyer_name
        .trim()
        .eq_ignore_ascii_case(entered_name)
    {
        return Err("Entered name does not match the license".to_string());
    }
    if !signed
        .payload
        .buyer_email
        .trim()
        .eq_ignore_ascii_case(entered_email)
    {
        return Err("Entered email does not match the license".to_string());
    }

    let stored = StoredOfflineLicense {
        schema_version: 1,
        activated_at: now_unix_seconds(),
        signed_license: signed.clone(),
    };

    let file_path = get_offline_license_file(&app)?;
    let json = serde_json::to_string_pretty(&stored)
        .map_err(|e| format!("Failed to serialize offline license: {}", e))?;
    fs::write(&file_path, json)
        .map_err(|e| format!("Failed to write offline license file: {}", e))?;

    Ok(OfflineLicenseStatus {
        is_pro: true,
        plan: signed.payload.plan,
        buyer_name: Some(signed.payload.buyer_name),
        buyer_email: Some(signed.payload.buyer_email),
        license_id: Some(signed.payload.license_id),
        activated_at: Some(stored.activated_at),
        message: "Offline activation successful".to_string(),
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.app_handle();
            let resource_dir = handle
                .path()
                .resource_dir()
                .expect("failed to get resource directory");

            // ─── ONNX Runtime loading preparation (Windows version) ───
            // Point ORT directly to onnxruntime.dll in the resources root
            let ort_dll_path = resource_dir.join("onnxruntime.dll");

            // Must exist — otherwise ort will fall back to system PATH / System32 → wrong version!
            if !ort_dll_path.exists() {
                eprintln!("ERROR: onnxruntime.dll not found in resources: {:?}", ort_dll_path);
                // You can also show a dialog here if you want
            }

            // Tell ort where to load the main DLL from (required when using load-dynamic)
            env::set_var("ORT_DYLIB_PATH", ort_dll_path);

            // Optional: debug (visible when running `tauri dev` or in console of built app)
            println!("ORT_DYLIB_PATH set to: {:?}", env::var("ORT_DYLIB_PATH").ok());
            println!("Resources dir       : {:?}", resource_dir);

            // Startup hygiene: remove stale pipeline intermediates older than 24 hours.
            match cleanup_qwen_intermediates(handle.clone(), Some(24)) {
                Ok(count) if count > 0 => {
                    println!("[QWEN-CLEANUP] Removed {} stale intermediate files", count);
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[QWEN-CLEANUP] Startup cleanup failed: {}", e);
                }
            }

            // No LD_LIBRARY_PATH needed on Windows

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            download_youtube_video,
            ensure_whisper_model,
            transcribe_wav,
            transcribe_media,
            delete_whisper_model,
            download_youtube_audio,
            transcribe_youtube,
            get_file_size,
            transcribe_path,
            list_downloaded_models,
            list_downloaded_diar_models,
            set_active_diar_model,
            ensure_diarization_model,
            delete_diarization_model,
            diarize_speakers,
            serve_audio_file,
            save_temp_audio,
            transcribe_recording,
            process_ffmpeg,
            get_processed_file_bytes,
            save_processed_file,
            create_video_preview,
            list_downloaded_nllb_models,
            set_active_nllb_model,
            get_active_nllb_model,
            ensure_nllb_model,
            delete_nllb_model,
            download_nllb_model,
            translate_text,
            get_temp_dir,
            get_qwen_model_status,
            download_qwen_model,
            delete_qwen_model,
            get_parakeet_tdt_model_status,
            download_parakeet_tdt_model,
            load_parakeet_tdt_model,
            delete_parakeet_tdt_model,
            ensure_tdt_model,
            parakeet_transcribe_and_diarize,
            parakeet_diarize_then_transcribe_segments,
            cancel_qwen_task,
            cleanup_qwen_intermediates,
            create_qwen_voice_profile,
            synthesize_qwen_preview,
            list_qwen_dubbings,
            create_qwen_dubbing,
            start_qwen_dubbing_pipeline,
            read_artifact_bytes,
            normalize_audio_for_preview,
            batch_get_runtime_limits,
            batch_expand_source,
            batch_prepare_queue_output,
            batch_write_text_file,
            batch_write_bytes_file,
            get_offline_license_status,
            activate_offline_license,
            get_entitlement_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}