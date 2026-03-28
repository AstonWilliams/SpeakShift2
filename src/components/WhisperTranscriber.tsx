"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from '@tauri-apps/api/event';
import { motion } from "framer-motion";
import {
  Loader2,
  X,
  Play,
  Download,
  FileText,
  Brain,
  CheckCircle2,
  AlertTriangle,
  FileVideo,
  FolderOpen,
  Info,
  AlertOctagon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { saveTranscription } from "@/lib/transcriptionDb";
import { showToast } from "@/lib/toast";
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { useVirtualizer } from '@tanstack/react-virtual';

const MEDIA_FILE_EXTENSIONS = [
  "mp3", "wav", "m4a", "ogg", "flac", "aac", "opus", "wma", "aif", "aiff",
  "mp4", "mkv", "webm", "mov", "avi", "m4v", "wmv", "mpeg", "mpg", "3gp",
];
const MAX_ACCEPTED_FILE_SIZE_MB = 8192;

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/opus",
  wma: "audio/x-ms-wma",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  m4v: "video/x-m4v",
  wmv: "video/x-ms-wmv",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  "3gp": "video/3gpp",
};

const inferMimeFromFileName = (name: string): string => {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXTENSION[ext] || "unknown type";
};

// Keep one native picker in-flight to prevent duplicate dialogs from overlapping triggers.
let inFlightMediaPicker: Promise<string | null> | null = null;

const openMediaPicker = async (title: string): Promise<string | null> => {
  if (inFlightMediaPicker) {
    return inFlightMediaPicker;
  }

  inFlightMediaPicker = (async () => {
    const selected = await open({
      title,
      filters: [{
        name: "Audio & Video",
        extensions: MEDIA_FILE_EXTENSIONS,
      }],
      multiple: false,
      directory: false,
    });

    if (!selected) return null;
    return Array.isArray(selected) ? (selected[0] ?? null) : selected;
  })();

  try {
    return await inFlightMediaPicker;
  } finally {
    inFlightMediaPicker = null;
  }
};

const WHISPER_MODELS = [
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v3",
  "large-v3-turbo",
] as const;

type ModelType = (typeof WHISPER_MODELS)[number];

// Rough size in MB (approximate)
const MODEL_SIZES_MB: Record<ModelType, number> = {
  "tiny": 75,
  "tiny.en": 75,
  "base": 145,
  "base.en": 145,
  "small": 465,
  "small.en": 465,
  "medium": 1500,
  "medium.en": 1500,
  "large-v3": 3000,
  "large-v3-turbo": 1800,
};

interface Props {
  file: File | null;
  initialFilePath?: string | null;
  initialFileName?: string | null;
  onCancel: () => void;
  onTranscriptionComplete?: (result: any) => void;
}

interface Segment {
  start_ms: number;
  end_ms: number;
  text: string;
}

interface TranscriptionResult {
  segments: Segment[];
  detected_language?: string;
  full_text?: string;
  error?: string;
}

type ExportFormat = "srt" | "vtt" | "txt" | "json" | "csv" | "md";

const LANGUAGES = [
  { code: "auto", name: "Auto Detect" },
  { code: "en", name: "English" },
  { code: "hi", name: "Hindi" },
  { code: "ur", name: "Urdu" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "zh", name: "Chinese" },
  { code: "ar", name: "Arabic" },
  { code: "ru", name: "Russian" },
] as const;

type LanguageCode = typeof LANGUAGES[number]["code"];

export default function WhisperTranscriber({ file, initialFilePath = null, initialFileName = null, onCancel, onTranscriptionComplete }: Props) {
  const autoPromptedDropKeyRef = useRef<string | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0); // seconds
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(file);
  const [selectedFileName, setSelectedFileName] = useState(initialFileName ?? file?.name ?? "No file selected");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(initialFilePath);
  const [selectedMimeType, setSelectedMimeType] = useState<string>(
    file?.type || inferMimeFromFileName(initialFileName ?? file?.name ?? "")
  );
  const [isDropZoneDragOver, setIsDropZoneDragOver] = useState(false);
  const [fileSizeMB, setFileSizeMB] = useState<number>(0);
  const [selectedModel, setSelectedModel] = useState<ModelType>("small.en");
  const [selectedLanguage, setSelectedLanguage] = useState<LanguageCode>("auto");
  const [downloadedModels, setDownloadedModels] = useState<string[]>([]);
  const [transcription, setTranscription] = useState<TranscriptionResult | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Ready to begin...");
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("srt");
  // const [isDragOver, setIsDragOver] = useState(false);

  const parentRef = useRef<HTMLDivElement>(null);

  const applySelectedPath = useCallback(async (path: string, fallbackName: string) => {
    const name = path.split(/[\\/]/).pop() || fallbackName;

    let sizeMB = 0;
    try {
      sizeMB = (await invoke<number>("get_file_size", { path })) / (1024 * 1024);
    } catch { }

    if (sizeMB > MAX_ACCEPTED_FILE_SIZE_MB) {
      setError("Selected file is too large (over 8GB). Please choose a smaller file.");
      setSelectedFile(null);
      setSelectedFilePath(null);
      setSelectedFileName("No file selected");
      showToast("File exceeds 8GB limit", "error");
      return;
    }

    setSelectedFilePath(path);
    setSelectedFileName(name);
    setFileSizeMB(sizeMB);
    setSelectedMimeType(inferMimeFromFileName(name));
    setError(null);
    setTranscription(null);
    setStatus(`Selected: ${name}`);
  }, []);

  useEffect(() => {
    if (!file) return;

    if (file.size / (1024 * 1024) > MAX_ACCEPTED_FILE_SIZE_MB) {
      setError("Selected file is too large (over 8GB). Please choose a smaller file.");
      setSelectedFile(null);
      setSelectedFilePath(null);
      setSelectedFileName("No file selected");
      showToast("File exceeds 8GB limit", "error");
      return;
    }

    setSelectedFile(file);
    setSelectedFileName(file.name);
    setFileSizeMB(file.size / (1024 * 1024));
    setSelectedMimeType(file.type || inferMimeFromFileName(file.name));
    setError(null);
    setTranscription(null);
    setSelectedFilePath(null);
  }, [file]);

  useEffect(() => {
    if (!initialFilePath) return;
    setSelectedFile(null);
    void applySelectedPath(
      initialFilePath,
      initialFileName ?? initialFilePath.split(/[\\/]/).pop() ?? "selected-file"
    );
  }, [applySelectedPath, initialFileName, initialFilePath]);

  // Ask for filesystem path once whenever a dropped browser File needs it.
  const handlePendingFilePath = useCallback(async () => {
    if (!selectedFile) {
      return;
    }

    const dropKey = `${selectedFile.name}:${selectedFile.size}:${selectedFile.lastModified}`;
    if (autoPromptedDropKeyRef.current === dropKey || selectedFilePath) {
      return;
    }
    autoPromptedDropKeyRef.current = dropKey;

    console.log("Handling dropped file (once):", selectedFile.name);

    setSelectedFileName(selectedFile.name);
    setFileSizeMB(selectedFile.size / (1024 * 1024));
    setError(null);
    setTranscription(null);

    showToast("Please select the same file again to continue", "info");

    try {
      const path = await openMediaPicker("Select the same file to continue");

      if (!path) {
        setError("File selection cancelled");
        showToast("Cannot transcribe without path", "info");
        return;
      }

      await applySelectedPath(path, selectedFile.name);
      showToast("File path set! Ready to transcribe.", "success");

    } catch (err) {
      console.error("Picker error:", err);
      setError("Failed to get file path");
    }
  }, [applySelectedPath, selectedFile, selectedFilePath]);

  useEffect(() => {
    void handlePendingFilePath();
  }, [handlePendingFilePath]);

  const handleDropInCard = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDropZoneDragOver(false);

    const droppedFile = e.dataTransfer?.files?.[0];
    if (!droppedFile) return;

    const ext = droppedFile.name.split(".").pop()?.toLowerCase() || "";
    if (!MEDIA_FILE_EXTENSIONS.includes(ext)) {
      setError("Please drop an audio or video file");
      return;
    }

    if (droppedFile.size / (1024 * 1024) > MAX_ACCEPTED_FILE_SIZE_MB) {
      setError("Selected file is too large (over 8GB). Please choose a smaller file.");
      setSelectedFile(null);
      setSelectedFilePath(null);
      setSelectedFileName("No file selected");
      showToast("File exceeds 8GB limit", "error");
      return;
    }

    autoPromptedDropKeyRef.current = null;
    setSelectedFilePath(null);
    setSelectedFile(droppedFile);
    setSelectedFileName(droppedFile.name);
    setFileSizeMB(droppedFile.size / (1024 * 1024));
    setError(null);
    setTranscription(null);
    setStatus("Dropped file detected. Please confirm file path...");
  };

  useEffect(() => {
    if (isProcessing) {
      // Start timer
      timerRef.current = setInterval(() => {
        setElapsedTime(prev => prev + 1);
      }, 1000);
    } else {
      // Stop and reset timer
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (!transcription) {
        setElapsedTime(0); // reset only if no result yet
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isProcessing, transcription]);

  // Load downloaded models
  useEffect(() => {
    const loadModels = async () => {
      try {
        const models: string[] = await invoke("list_downloaded_models");
        setDownloadedModels(models);
      } catch (err) {
        console.error("Failed to load models:", err);
      }
    };
    loadModels();
  }, []);

  useEffect(() => {
    const unlistenPromise = listen("transcription-progress", (event: any) => {
      const data = event.payload as any;
      setProgress(data.percent);
      setStatus(data.message || "Processing...");
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  const formatTimestamp = (ms: number) => {
    const pad = (n: number) => n.toString().padStart(2, '0');
    const pad3 = (n: number) => n.toString().padStart(3, '0');

    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const milli = ms % 1000;

    return `${pad(h)}:${pad(m)}:${pad(s)},${pad3(milli)}`;
  };

  const exportAsSRT = async () => {
    console.log("exportAsSRT clicked");

    if (!transcription?.segments?.length) {
      alert("No transcription available to export yet.");
      return;
    }

    let srt = "";
    transcription.segments.forEach((seg, index) => {
      srt += `${index + 1}\n`;
      srt += `${formatTimestamp(seg.start_ms)} --> ${formatTimestamp(seg.end_ms)}\n`;
      srt += `${seg.text.trim()}\n\n`;
    });

    const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
    const fileName = `${selectedFileName.replace(/\.[^/.]+$/, "") || "transcription"}.srt`;

    const ok = await saveBlobWithPicker(blob, fileName, { "text/plain": [".srt"] });
    if (ok) showToast("Saved SRT file", "success");
    else showToast("Failed to save SRT file", "error");
  };

  const exportCurrentFormat = async () => {
    if (!transcription?.segments?.length) {
      alert("No transcription available to export yet.");
      return;
    }

    if (exportFormat === "srt") {
      await exportAsSRT();
      return;
    }

    const baseName = `${selectedFileName.replace(/\.[^/.]+$/, "") || "transcription"}`;

    if (exportFormat === "txt") {
      const text = transcription.segments.map((s) => s.text.trim()).join("\n\n");
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const ok = await saveBlobWithPicker(blob, `${baseName}.txt`, { "text/plain": [".txt"] });
      if (ok) showToast("Saved TXT file", "success");
      else showToast("Failed to save TXT file", "error");
      return;
    }

    if (exportFormat === "vtt") {
      const vttTime = (ms: number) => formatTimestamp(ms).replace(",", ".");
      let body = "WEBVTT\n\n";
      transcription.segments.forEach((seg, index) => {
        body += `${index + 1}\n`;
        body += `${vttTime(seg.start_ms)} --> ${vttTime(seg.end_ms)}\n`;
        body += `${seg.text.trim()}\n\n`;
      });
      const blob = new Blob([body], { type: "text/vtt;charset=utf-8" });
      const ok = await saveBlobWithPicker(blob, `${baseName}.vtt`, { "text/vtt": [".vtt"] });
      if (ok) showToast("Saved VTT file", "success");
      else showToast("Failed to save VTT file", "error");
      return;
    }

    if (exportFormat === "json") {
      const jsonData = {
        filename: selectedFileName,
        transcription: {
          full_text: transcription.full_text || "",
          segments: transcription.segments.map((seg) => ({
            start: seg.start_ms / 1000,
            end: seg.end_ms / 1000,
            text: seg.text.trim(),
          })),
          detected_language: transcription.detected_language,
          model_used: selectedModel,
        },
        exported_at: new Date().toISOString(),
      };

      const blob = new Blob([JSON.stringify(jsonData, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const ok = await saveBlobWithPicker(blob, `${baseName}.json`, {
        "application/json": [".json"],
      });
      if (ok) showToast("Saved JSON file", "success");
      else showToast("Failed to save JSON file", "error");
      return;
    }

    if (exportFormat === "csv") {
      let csv = "Index,Start,End,Text\n";
      transcription.segments.forEach((seg, index) => {
        const text = seg.text.trim().replace(/"/g, '""');
        csv += `"${index + 1}","${(seg.start_ms / 1000).toFixed(3)}","${(seg.end_ms / 1000).toFixed(3)}","${text}"\n`;
      });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const ok = await saveBlobWithPicker(blob, `${baseName}.csv`, { "text/csv": [".csv"] });
      if (ok) showToast("Saved CSV file", "success");
      else showToast("Failed to save CSV file", "error");
      return;
    }

    if (exportFormat === "md") {
      let md = `# Transcription - ${selectedFileName}\n\n`;
      md += `- Model: ${selectedModel}\n`;
      md += `- Language: ${selectedLanguage}\n`;
      md += `- Exported: ${new Date().toLocaleString()}\n\n`;
      transcription.segments.forEach((seg, i) => {
        md += `## Segment ${i + 1} (${formatTimestamp(seg.start_ms)} -> ${formatTimestamp(seg.end_ms)})\n\n`;
        md += `${seg.text.trim()}\n\n`;
      });
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const ok = await saveBlobWithPicker(blob, `${baseName}.md`, { "text/markdown": [".md"] });
      if (ok) showToast("Saved Markdown file", "success");
      else showToast("Failed to save Markdown file", "error");
    }
  };

  // Helper to show save dialog when available, otherwise fallback to link download
  const saveBlobWithPicker = async (blob: Blob, fileName: string, accept?: Record<string, string[]>) => {
    // Try native File System Access API first
    if ("showSaveFilePicker" in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: fileName,
          types: accept ? [{ description: fileName, accept }] : undefined,
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch (err) {
        console.log("showSaveFilePicker failed, falling back:", err);
      }
    }

    // Try Tauri's save dialog + write (desktop)
    try {
      // `save` is from @tauri-apps/plugin-dialog and returns a path string on success
      const tauriPath = await save({ defaultPath: fileName });
      if (tauriPath && typeof tauriPath === 'string') {
        // convert blob to Uint8Array
        const ab = await blob.arrayBuffer();
        const uint8 = new Uint8Array(ab);
        await writeFile(tauriPath, uint8);
        return true;
      }
    } catch (err) {
      console.log('Tauri save/write failed, falling back to link', err);
    }

    // Classic fallback download
    try {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return true;
    } catch (err) {
      console.error('Fallback download failed', err);
      return false;
    }
  };


  const pickFile = async () => {
    // Block while processing; allow replacing previous selections.
    if (isProcessing) return;

    try {
      const path = await openMediaPicker("Select Audio or Video File");

      if (!path) return;

      await applySelectedPath(path, "selected-file");
      setSelectedFile(null);
      showToast("File ready", "success");

    } catch (err) {
      console.error("Manual pick failed:", err);
      setError("Failed to select file");
    }
  };

  const getSizeWarning = () => {
    if (fileSizeMB === 0) return null;

    if (fileSizeMB > 4000) {
      return { color: "red", text: "File too large (>4GB) — will likely fail or crash", icon: AlertTriangle };
    }
    if (fileSizeMB > 3000) {
      return { color: "yellow", text: "Very large file (3–4GB) — risky, may be slow or fail", icon: AlertTriangle };
    }
    if (fileSizeMB > 2000) {
      return { color: "orange", text: "Large file (2–3GB) — may be slow, close other apps", icon: Info };
    }
    return { color: "green", text: "File size is good — recommended for smooth processing", icon: CheckCircle2 };
  };

  const getModelCompatibility = () => {
    const modelSize = MODEL_SIZES_MB[selectedModel];
    const totalMemEstimate = modelSize + fileSizeMB + 1000;

    if (totalMemEstimate > 12000) {
      return { color: "red", text: "High RAM usage expected — may crash on low-end devices" };
    }
    if (totalMemEstimate > 8000) {
      return { color: "yellow", text: "Heavy on RAM — close other apps for best results" };
    }
    if (totalMemEstimate > 4000) {
      return { color: "orange", text: "Moderate RAM usage — should be fine on most devices" };
    }
    return { color: "green", text: "Low RAM usage — perfect for your device" };
  };

  const startTranscription = async () => {
    if (isProcessing) return;
    if (!selectedFilePath) {
      setError("No valid file path. Please select file.");
      return;
    }
    if (fileSizeMB > MAX_ACCEPTED_FILE_SIZE_MB) {
      setError("Selected file is too large (over 8GB). Please choose a smaller file.");
      return;
    }

    setIsProcessing(true);
    setError(null);
    setProgress(0);
    setStatus("Starting transcription...");

    try {
      const result = await invoke<TranscriptionResult>("transcribe_path", {
        filePath: selectedFilePath,
        fileName: selectedFileName,
        modelName: selectedModel,
        language: selectedLanguage === "auto" ? null : selectedLanguage,
      });

      setTranscription(result);
      setProgress(100);
      setStatus("Transcription complete!");

      // Optional db save
      // await saveTranscription({...});

      if (onTranscriptionComplete) onTranscriptionComplete(result);

    } catch (err: any) {
      console.error("Transcription failed:", err);
      setError(err?.message || "Failed to transcribe");
      showToast("Transcription failed", "error");
    } finally {
      setIsProcessing(false);
    }
  };
  // Virtualization setup
  const rowVirtualizer = useVirtualizer({
    count: transcription?.segments?.length || 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 100,      // slightly larger height for better spacing
    overscan: 8,                 // render a few extra rows above/below viewport
  });

  const sizeWarning = getSizeWarning();
  const modelCompat = getModelCompatibility();
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      className="bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden w-full max-w-none"
    >
      <div className="p-8 lg:p-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-blue-100 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center">
              <Brain className="w-8 h-8 text-blue-600 dark:text-blue-400" />
            </div>
            <div
              ref={parentRef}
              className="p-6 pr-4 max-h-160 w-full overflow-auto"
              style={{ contain: "strict" }}
            >
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-3 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* ────────────────────────────────────────────────
           REPLACED FILE SELECTION BLOCK
           (shows dropped/selected file info) 
      ──────────────────────────────────────────────── */}
        <div className="mb-10">
          <label className="block text-sm font-semibold text-zinc-600 dark:text-zinc-300 mb-3">
            Audio / Video File
          </label>

          <div
            className={`
            border-2 border-dashed rounded-2xl p-10 text-center transition-all
            select-none relative overflow-hidden
            ${isDropZoneDragOver
                ? "border-blue-500 bg-blue-100/70 dark:bg-blue-950/40 ring-2 ring-blue-400/50"
                : selectedFileName !== "No file selected"
                ? "border-blue-500 bg-blue-50/30 dark:bg-blue-950/20"
                : "border-zinc-300 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-600"
              }
          `}
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDropZoneDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDropZoneDragOver(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDropZoneDragOver(false);
            }}
            onDrop={handleDropInCard}
          >
            {selectedFileName !== "No file selected" ? (
              <div className="space-y-5">
                <FileVideo className="w-16 h-16 mx-auto text-blue-600" />
                <div>
                  <p className="font-bold text-xl break-all max-w-lg mx-auto">
                    {selectedFileName}
                  </p>
                  <p className="text-sm text-zinc-500 mt-1">
                    {fileSizeMB.toFixed(1)} MB • {selectedMimeType || "unknown type"}
                  </p>
                </div>
                <p className="text-xs text-zinc-500 mt-2">
                  Click "Select File" below or drag another file to replace
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                <FolderOpen className="w-16 h-16 mx-auto text-zinc-400" />
                <div>
                  <p className="font-medium text-zinc-600 dark:text-zinc-300 text-lg">
                    No file selected yet
                  </p>
                  <p className="text-sm text-zinc-500 mt-1">
                    Drop a file on the main screen or click below
                  </p>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    pickFile();
                  }}
                  className="px-10 py-5 bg-linear-to-r from-gray-900 to-black text-white dark:from-gray-100 dark:to-white dark:text-black rounded-2xl font-bold text-lg hover:scale-105 active:scale-95 transition-all shadow-xl"
                >
                  Select File
                </button>
              </div>
            )}
          </div>

          {/* Size & Compatibility Warnings – kept exactly as before */}
          {fileSizeMB > 0 && (
            <div className="mt-6 space-y-4">
              <div
                className={`p-4 rounded-2xl flex items-center gap-3 border ${sizeWarning?.color === "green" ? "bg-green-50 border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-700 dark:text-green-300" :
                  sizeWarning?.color === "orange" ? "bg-orange-50 border-orange-200 text-orange-800 dark:bg-orange-900/20 dark:border-orange-700 dark:text-orange-300" :
                    sizeWarning?.color === "yellow" ? "bg-yellow-50 border-yellow-200 text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-700 dark:text-yellow-300" :
                      "bg-red-50 border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300"
                  }`}
              >
                {sizeWarning?.color === "green" && <CheckCircle2 className="w-6 h-6" />}
                {sizeWarning?.color === "orange" && <Info className="w-6 h-6" />}
                {sizeWarning?.color === "yellow" && <AlertTriangle className="w-6 h-6" />}
                {sizeWarning?.color === "red" && <AlertOctagon className="w-6 h-6" />}
                <p className="text-sm">{sizeWarning?.text}</p>
              </div>
              <div
                className={`p-4 rounded-2xl flex items-center gap-3 border ${modelCompat.color === "green" ? "bg-green-50 border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-700 dark:text-green-300" :
                  modelCompat.color === "orange" ? "bg-orange-50 border-orange-200 text-orange-800 dark:bg-orange-900/20 dark:border-orange-700 dark:text-orange-300" :
                    modelCompat.color === "yellow" ? "bg-yellow-50 border-yellow-200 text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-700 dark:text-yellow-300" :
                      "bg-red-50 border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300"
                  }`}
              >
                {modelCompat.color === "green" && <CheckCircle2 className="w-6 h-6" />}
                {modelCompat.color === "orange" && <Info className="w-6 h-6" />}
                {modelCompat.color === "yellow" && <AlertTriangle className="w-6 h-6" />}
                {modelCompat.color === "red" && <AlertOctagon className="w-6 h-6" />}
                <p className="text-sm">{modelCompat.text}</p>
              </div>
            </div>
          )}
        </div>

        {/* Model selection */}
        <div className="mb-10">
          <label className="block text-sm font-semibold text-zinc-600 dark:text-zinc-300 mb-3">
            Whisper Model
          </label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value as ModelType)}
            disabled={isProcessing || (!selectedFile && !selectedFilePath)}
            className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl p-4 font-medium outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
          >
            {WHISPER_MODELS.map((m) => (
              <option key={m} value={m}>
                {m} {downloadedModels.includes(m) ? "✓ downloaded" : ""}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-zinc-500">
            Bigger model = better accuracy • slower first download
          </p>
        </div>

        {/* Language Selection */}
        <div className="mt-6">
          <label className="block text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">
            Transcription Language
          </label>
          <select
            value={selectedLanguage}
            onChange={(e) => setSelectedLanguage(e.target.value as LanguageCode)}
            className="w-full px-4 py-3 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-xl text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-pink-500"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-zinc-500 mt-1">
            Select language for better accuracy (auto-detect works well for most cases)
          </p>
        </div>
        <br />

        {/* Start button */}
        <button
          onClick={startTranscription}
          disabled={isProcessing || (!selectedFile && !selectedFilePath)}
          className={`
          w-full py-7 rounded-4xl text-xl font-black flex items-center justify-center gap-4 transition-all shadow-xl
          ${isProcessing || (!selectedFile && !selectedFilePath)
              ? "bg-zinc-400 text-white cursor-not-allowed"
              : "bg-linear-to-r from-pink-600 to-pink-700 hover:from-pink-700 hover:to-pink-800 text-white hover:scale-[1.02] active:scale-95"
            }
        `}
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-7 h-7 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Play className="w-7 h-7 fill-current" />
              Start Transcription
            </>
          )}
        </button>

        {/* Status */}
        {(status || isProcessing) && (
          <div className="mt-8 p-6 bg-zinc-50 dark:bg-zinc-900/50 rounded-2xl border border-zinc-200 dark:border-zinc-800">
            <div className="flex justify-between items-center mb-3">
              <span className="font-medium">{status}</span>
              {progress > 0 && <span className="font-bold text-pink-500">{progress}%</span>}
            </div>

            {/* New: Elapsed time display */}
            <div className="text-sm text-zinc-500 dark:text-zinc-400 mb-3 flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Time elapsed: {Math.floor(elapsedTime / 60).toString().padStart(2, '0')}:
              {(elapsedTime % 60).toString().padStart(2, '0')}
            </div>

            {progress > 0 && (
              <div className="w-full bg-zinc-200 dark:bg-zinc-800 h-2.5 rounded-full overflow-hidden">
                <motion.div
                  className="bg-pink-600 h-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-6 p-5 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-2xl text-red-700 dark:text-red-300 flex gap-3 items-start">
            <AlertTriangle className="w-6 h-6 shrink-0 mt-1" />
            <div>
              <p className="font-bold">Error</p>
              <p className="text-sm mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Transcription Result – Virtualized with clean preview style */}
        {transcription?.segments?.length ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
            className="mt-10 space-y-7"
          >
            {/* Preview Card */}
            <div className="bg-white dark:bg-zinc-900/50 backdrop-blur-sm rounded-3xl border border-zinc-200 dark:border-zinc-800/70 shadow-xl overflow-hidden">
              {/* Header */}
              <div className="px-7 pt-6 pb-4 border-b border-zinc-200 dark:border-zinc-800/50">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <FileText className="w-6 h-6 text-pink-500" />
                    <h4 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
                      Quick Preview
                    </h4>
                  </div>
                  <div className="text-sm text-zinc-600 dark:text-zinc-400 font-medium">
                    {transcription.segments.length} segments
                  </div>
                </div>
                <p className="text-sm text-zinc-500 dark:text-zinc-500 mt-1.5">
                  First few entries — full version & search in Transcriptions tab
                </p>
              </div>
              {/* Virtualized scrollable content */}
              <div
                ref={parentRef}
                className={`
                px-7 py-6
                max-h-[55vh] min-h-60
                overflow-y-auto overscroll-contain
                scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent
                scrollbar-thumb-rounded
              `}
                style={{ contain: "strict" }}
              >
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                    const seg = transcription.segments[virtualItem.index];
                    const start = formatTimestamp(seg.start_ms);
                    const end = formatTimestamp(seg.end_ms);
                    return (
                      <div
                        key={virtualItem.key}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualItem.size}px`,
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        className="group px-1 py-4 border-b border-zinc-200 dark:border-zinc-800/40 last:border-b-0 hover:bg-zinc-100 dark:hover:bg-zinc-800/30 transition-colors duration-150"
                      >
                        {/* Timestamp line */}
                        <div className="flex items-baseline gap-3 text-xs text-zinc-500 dark:text-zinc-500 mb-2 font-mono tracking-tight">
                          <span>
                            {start} → {end}
                          </span>
                        </div>
                        {/* Text with subtle pink left accent */}
                        <div className="flex gap-4 items-start">
                          <div className="shrink-0 mt-0.5">
                            <span className="
                            text-lg font-bold text-pink-500/70
                            opacity-80 group-hover:opacity-100 transition-opacity
                          ">
                              {virtualItem.index + 1}
                            </span>
                          </div>
                          <p className="
                          flex-1 pl-2 border-l-2 border-pink-500/30
                          leading-[1.68] text-[15.5px] text-zinc-800 dark:text-zinc-100
                          wrap-break-word hyphens-auto
                        ">
                            {seg.text.trim()}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-col sm:flex-row gap-4 px-2">
              <div className="flex-1 flex gap-2">
                <select
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                  className="px-4 py-4 rounded-3xl bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white border border-zinc-300 dark:border-zinc-700 font-semibold"
                >
                  <option value="srt">SRT</option>
                  <option value="vtt">VTT</option>
                  <option value="txt">TXT</option>
                  <option value="json">JSON</option>
                  <option value="csv">CSV</option>
                  <option value="md">MD</option>
                </select>
                <button
                  onClick={exportCurrentFormat}
                  className="flex-1 bg-linear-to-r from-pink-600 to-pink-700 hover:from-pink-700 hover:to-pink-800 text-white py-4 rounded-3xl font-bold text-sm flex items-center justify-center gap-2 transition-all shadow-md"
                >
                  <Download className="w-5 h-5" />
                  Export {exportFormat.toUpperCase()}
                </button>
              </div>
              <button
                onClick={async () => {
                  if (!transcription?.segments?.length) return;
                  const text = transcription.segments.map(s => s.text.trim()).join('\n\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    setCopyStatus("copied");
                    setTimeout(() => setCopyStatus("idle"), 1800);
                  } catch (err) {
                    console.error("Clipboard copy failed:", err);
                    showToast("Failed to copy text", "error");
                  }
                }}
                className="flex-1 bg-zinc-900 text-zinc-100 dark:bg-zinc-800 py-6 rounded-4xl font-black hover:bg-zinc-800 dark:hover:bg-zinc-700 transition-all disabled:opacity-50"
                disabled={copyStatus === "copied"}
              >
                {copyStatus === "copied" ? (
                  <span className="inline-flex items-center gap-2">
                    Copied!
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                ) : (
                  "Copy Text"
                )}
              </button>
            </div>

            {/* Processed badge */}
            <div className="text-center text-sm text-green-600 dark:text-green-400 flex items-center justify-center gap-2 pt-3">
              <CheckCircle2 className="w-5 h-5" />
              Processed 100% locally with whisper.cpp
            </div>
          </motion.div>
        ) : null}
      </div>
    </motion.div>
  );
}

