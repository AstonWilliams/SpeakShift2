













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



// Prevent concurrent heavy dubbing synthesis jobs from exhausting GPU memory.
static QWEN_SYNTH_LOCK: Lazy<Arc<TokioMutex<()>>> = Lazy::new(|| Arc::new(TokioMutex::new(())));
static QWEN_DUBBINGS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static CANCELLED_QWEN_TASKS: Lazy<Arc<TokioMutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(TokioMutex::new(HashSet::new())));


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
    if (ratio - 1.0).abs() < 0.06 {
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

    let abs_delta = (ratio - 1.0).abs();
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

    if abs_delta <= 0.10 {
        // For small corrections, try apitch+atempo chain first; if unavailable, fall back to atempo.
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

#[tauri::command]
async fn cancel_qwen_task(app: AppHandle, task_id: String) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("task_id is required".to_string());
    }

    CANCELLED_QWEN_TASKS.lock().await.insert(task_id.clone());
    let _ = app.emit(
        "qwen-cancelled",
        json!({
            "task_id": task_id,
            "message": "Cancellation requested",
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
    let _ = app.emit(
        "qwen-warning",
        json!({
            "task_id": task_id,
            "message": warning,
        }),
    );
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
        .diarize(audio_samples, 16000, 1)
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

    let voiced_regions = detect_voiced_regions(&load_audio_to_f32_samples(&wav_path.to_string_lossy()).map_err(|e| {
        QwenCommandError::new(QwenErrorCode::InvalidAudio, e).with_stage("overlap")
    })?, 16000);

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
        let audio_for_overlap = load_audio_to_f32_samples(&wav_path.to_string_lossy()).map_err(|e| {
            QwenCommandError::new(QwenErrorCode::InvalidAudio, e).with_stage("overlap")
        })?;

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
async fn parakeet_transcribe_and_diarize(
    app: AppHandle,
    media_path: String,
    model_dir: Option<String>,
    force_cpu: Option<bool>,
    task_id: Option<String>,
) -> Result<ParakeetTranscribeDiarizeResult, QwenCommandError> {
    parakeet_transcribe_and_diarize_impl(&app, &media_path, model_dir, force_cpu, &task_id).await
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
    if name_norm.contains("news") {
        return format!(
            "Hello, I am {} with your concise and reliable world news briefing.",
            display_name
        );
    }
    if name_norm.contains("narrator") || name_norm.contains("story") {
        return format!(
            "Hi, I am {} and I will guide you through this story with cinematic clarity.",
            display_name
        );
    }
    if name_norm.contains("podcast") {
        return format!(
            "Welcome, I am {} and this is your warm and engaging podcast host voice.",
            display_name
        );
    }
    if name_norm.contains("teacher") || name_norm.contains("coach") {
        return format!(
            "Hi, I am {} and I explain complex topics in a calm and practical way.",
            display_name
        );
    }

    format!(
        "Hi I am {} your go to professional english narrator.",
        display_name
    )
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
    if let Some(ref_l) = ref_lang {
        if !ref_l.trim().is_empty() && ref_l.to_lowercase() != final_lang.to_lowercase() {
            build_qwen_warning(
                &app,
                &task_id,
                "Cross-language voice cloning may reduce naturalness. Consider using a reference speaker in the target language.",
            );
        }
    }

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
        trimmed_text.clone(),
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

    let output = TokioCommand::new(&cli_path)
        .current_dir(cli_path.parent().unwrap_or(Path::new(".")))
        .args(args)
        .output()
        .await
        .map_err(|e| {
            QwenCommandError::new(
                QwenErrorCode::CliExecutionFailed,
                format!("Failed to execute qwen3tts-cli for dubbing: {}", e),
            )
            .with_stage("run")
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(QwenCommandError::from_cli_failure("run", &stderr, &stdout));
    }

    emit_qwen_progress(&app, &task_id, 75, "normalize", "Normalizing dubbing loudness");

    let normalized_output_path = normalize_qwen_audio(&app, &output_path, "qwen_dubbing").await?;

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
        text: trimmed_text,
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

        let out = TokioCommand::new(&cli_path)
            .current_dir(cli_path.parent().unwrap_or(Path::new(".")))
            .args(args)
            .output()
            .await
            .map_err(|e| {
                QwenCommandError::new(
                    QwenErrorCode::CliExecutionFailed,
                    format!("Failed to execute qwen3tts-cli in pipeline: {}", e),
                )
                .with_stage("synthesize")
            })?;

        if !out.status.success() {
            return Err(QwenCommandError::from_cli_failure(
                "synthesize",
                &String::from_utf8_lossy(&out.stderr),
                &String::from_utf8_lossy(&out.stdout),
            ));
        }

        intermediates.push(raw_chunk.clone());

        let normalized = normalize_qwen_audio(&app, &raw_chunk, "pipeline_chunk").await?;
        intermediates.push(normalized.clone());
        let hinted = chunks_dir.join(format!("hinted_chunk_{:04}_{}.wav", idx, Uuid::new_v4()));
        let (adjusted, _factor) =
            adjust_audio_duration(&app, &normalized, *duration_hint, &hinted, &task_id).await?;
        intermediates.push(adjusted.clone());
        synthesized_paths.push(adjusted);
    }

    emit_qwen_progress(&app, &task_id, 88, "concat", "Crossfading synthesized chunks");

    let final_audio_unorm = work_dir.join(format!("qwen_pipeline_audio_raw_{}.wav", Uuid::new_v4()));
    crossfade_concat_wavs(&app, &synthesized_paths, &final_audio_unorm, 120).await?;
    intermediates.push(final_audio_unorm.clone());

    emit_qwen_progress(&app, &task_id, 92, "normalize", "Normalizing final dubbing audio");
    let final_audio_path = normalize_qwen_audio(&app, &final_audio_unorm, "qwen_pipeline_final").await?;

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