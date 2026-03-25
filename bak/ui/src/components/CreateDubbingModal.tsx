"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { invoke } from "@tauri-apps/api/tauri";
import { open as openDialog } from "@tauri-apps/api/dialog";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  UploadCloud,
  FileAudio,
  Mic,
  Square,
  Loader2,
  Wand2,
  ChevronDown,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { showToast } from "@/lib/toast";
import { getVoice, type VoiceRecord } from "@/lib/audioVoiceDb";
import { addDubbing, type DubbingRecord } from "@/lib/dubbingDb";
import { cn } from "@/lib/utils";

// Interfaces from page.tsx
interface QwenProgressEvent {
  task_id?: string;
  percentage?: number;
  stage?: string;
  message?: string;
}

interface QwenWarningEvent {
  task_id?: string;
  message?: string;
}

interface PipelineResult {
  record: {
    id: string;
    title: string;
    text: string;
    lang: string;
    prompt_path: string;
    output_path: string;
    created_at_ms: number;
  };
  final_audio_path: string;
  final_video_path?: string | null;
  segment_count: number;
}

const LANG_OPTIONS = [
  { code: "auto", label: "Detect" },
  { code: "zh", label: "Chinese" },
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "ru", label: "Russian" },
  { code: "pt", label: "Portuguese" },
  { code: "es", label: "Spanish" },
  { code: "it", label: "Italian" },
];

const NLLB_MAP: Record<string, string> = {
  auto: "eng_Latn",
  en: "eng_Latn",
  zh: "zho_Hans",
  ja: "jpn_Jpan",
  ko: "kor_Hang",
  de: "deu_Latn",
  fr: "fra_Latn",
  ru: "rus_Cyrl",
  pt: "por_Latn",
  es: "spa_Latn",
  it: "ita_Latn",
};

const extractInvokeErrorMessage = (err: unknown) => {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;

  const asObj = err as Record<string, unknown>;
  const directMessage = typeof asObj.message === "string" ? asObj.message : "";
  if (directMessage) {
    try {
      const parsed = JSON.parse(directMessage) as {
        message?: string;
        stage?: string;
        recoveryHint?: string;
      };
      if (parsed?.message) {
        return `${parsed.message}${parsed.stage ? ` (Stage: ${parsed.stage})` : ""}${parsed.recoveryHint ? `\nHint: ${parsed.recoveryHint}`: ""}`;
      }
    } catch {
      return directMessage;
    }
  }

  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
};


interface CreateDubbingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  initialVoiceId?: string;
}

export default function CreateDubbingModal({
  open,
  onOpenChange,
  onCreated,
  initialVoiceId,
}: CreateDubbingModalProps) {
  const [voices, setVoices] = useState<VoiceRecord[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  const [title, setTitle] = useState("");
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("en");
  const [voiceId, setVoiceId] = useState(initialVoiceId || "");
  const [sourceMediaPath, setSourceMediaPath] = useState("");
  const [statusText, setStatusText] = useState("Ready");
  const [progress, setProgress] = useState(0);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // New state for 2-column layout
  const [transcribedText, setTranscribedText] = useState("");
  const [dubbedText, setDubbedText] = useState("");
  const [dubbedAudioUrl, setDubbedAudioUrl] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (initialVoiceId) {
      setVoiceId(initialVoiceId);
    }
  }, [initialVoiceId]);

  useEffect(() => {
    const loadVoices = async () => {
      try {
        const voiceList = await invoke<VoiceRecord[]>("list_voices");
        setVoices(voiceList);
        if (!voiceId && voiceList.length > 0) {
          setVoiceId(voiceList[0].id);
        }
      } catch (err) {
        console.error(err);
        showToast("Failed to load voices", "error");
      }
    };
    loadVoices();
  }, [voiceId]);

  const resetState = () => {
    setTitle("");
    setSourceLang("en");
    setTargetLang("en");
    setSourceMediaPath("");
    setStatusText("Ready");
    setProgress(0);
    setActiveTaskId(null);
    setTranscribedText("");
    setDubbedText("");
    setDubbedAudioUrl("");
    setIsCreating(false);
    setIsTranscribing(false);
    setWarning(null);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (isCreating) return;
    if (!newOpen) {
      resetState();
    }
    onOpenChange(newOpen);
  };

  const selectSourceMedia = async () => {
    try {
      const file = await openDialog({
        filters: [{ name: "Media", extensions: ["mp3", "wav", "mp4", "m4a"] }],
        multiple: false,
      });

      if (file && typeof file === "string") {
        setSourceMediaPath(file);
        setStatusText(`Selected: ${file.split(/[\\/]/).pop()}`);
        await transcribeSource(file);
      }
    } catch (err) {
      console.error(err);
      showToast("Failed to select file", "error");
    }
  };

  const transcribeSource = async (path: string) => {
    setIsTranscribing(true);
    setStatusText("Transcribing source audio...");
    setProgress(0);
    setTranscribedText("");
    try {
      const result = await invoke<{ text: string }>("transcribe_file", {
        path,
        lang: sourceLang === "auto" ? null : sourceLang,
        // TODO: Add progress listener for transcription
      });
      setTranscribedText(result.text);
      setStatusText("Transcription complete.");
    } catch (err) {
      console.error(err);
      const errorMessage = extractInvokeErrorMessage(err);
      showToast("Transcription failed", "error", errorMessage);
      setStatusText("Transcription failed.");
    } finally {
      setIsTranscribing(false);
    }
  };

  const startDubbing = async () => {
    if (!title.trim()) {
      showToast("Please enter a title", "warning");
      return;
    }
    if (!voiceId) {
      showToast("Please select a voice", "warning");
      return;
    }
    if (!sourceMediaPath) {
      showToast("Please select a source media file", "warning");
      return;
    }
    if (!transcribedText.trim()) {
        showToast("Source text is empty. Please provide a file with audio.", "warning");
        return;
    }

    setIsCreating(true);
    setProgress(0);
    setStatusText("Preparing dubbing pipeline...");
    setWarning(null);

    const voice = await getVoice(voiceId);
    if (!voice?.promptPath) {
      showToast("Selected voice is invalid or missing a voice profile.", "error");
      setIsCreating(false);
      return;
    }

    let unlistenProgress: null | (() => void) = null;
    let unlistenWarning: null | (() => void) = null;

    try {
      const taskId = `dubbing-${Date.now()}`;
      setActiveTaskId(taskId);

      unlistenProgress = await listen<QwenProgressEvent>(
        "qwen-progress",
        (event) => {
          if (event.payload.task_id === taskId) {
            if (event.payload.percentage) {
              setProgress(event.payload.percentage);
            }
            if (event.payload.stage) {
              const stageMessage = event.payload.message ? `: ${event.payload.message}` : "";
              setStatusText(`Stage: ${event.payload.stage}${stageMessage}`);
            }
          }
        }
      );

      unlistenWarning = await listen<QwenWarningEvent>(
        "qwen-warning",
        (event) => {
          if (event.payload.task_id === taskId) {
            setWarning(event.payload.message || "A cross-lingual task may have lower quality.");
          }
        }
      );

      const result = await invoke<PipelineResult>("pipeline_dubbing", {
        taskId,
        title: title.trim(),
        sourcePath: sourceMediaPath,
        sourceLang: NLLB_MAP[sourceLang],
        targetLang: NLLB_MAP[targetLang],
        voiceId,
        voicePromptPath: voice.promptPath,
        sourceText: transcribedText,
      });

      await addDubbing({
        id: result.record.id,
        title: result.record.title,
        sourcePath: sourceMediaPath,
        outputPath: result.final_audio_path,
        lang: targetLang,
        voiceId,
        createdAtMs: result.record.created_at_ms,
      });

      setDubbedText(result.record.text);
      const audioUrl = convertFileSrc(result.final_audio_path);
      setDubbedAudioUrl(audioUrl);

      showToast("Dubbing successful!", "success");
      setStatusText("Dubbing complete.");
      setProgress(100);
      onCreated(); // Refresh the list on the main page
    } catch (err: any) {
      console.error(err);
      const errorMessage = extractInvokeErrorMessage(err);
      showToast("Dubbing failed", "error", errorMessage);
      setStatusText(`Error: ${errorMessage.slice(0, 100)}`);
    } finally {
      setIsCreating(false);
      setActiveTaskId(null);
      unlistenProgress?.();
      unlistenWarning?.();
    }
  };

  const cancelActiveTask = async () => {
    if (!activeTaskId) return;
    try {
      await invoke("cancel_task", { taskId: activeTaskId });
      showToast("Task cancelled", "info");
    } catch (err) {
      console.error("Failed to cancel task:", err);
      showToast("Failed to cancel task", "error");
    }
    setIsCreating(false);
    setActiveTaskId(null);
    setStatusText("Task cancelled.");
  };

  const selectedVoice = useMemo(() => voices.find(v => v.id === voiceId), [voices, voiceId]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center"
          onClick={() => handleOpenChange(false)}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: "circOut" }}
            className="relative w-full max-w-4xl h-[90vh] max-h-[800px] bg-[#0a0a0c] border border-white/10 rounded-2xl shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between p-6 border-b border-white/10 shrink-0">
              <h2 className="text-xl font-semibold text-gray-50">Create New Dubbing</h2>
              <Button variant="ghost" size="icon" className="text-gray-400 hover:text-white" onClick={() => handleOpenChange(false)}>
                <X className="size-5" />
              </Button>
            </header>

            <div className="p-6 flex-1 overflow-y-auto space-y-6">
              {/* Title and Voice Selection */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Input
                  placeholder="Dubbing Title (e.g., 'My Project - Spanish Dub')"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="bg-white/5 border-white/10 text-gray-100 placeholder:text-gray-500 h-12 text-base"
                  disabled={isCreating}
                />
                <Select value={voiceId} onValueChange={setVoiceId} disabled={isCreating}>
                  <SelectTrigger className="bg-white/5 border-white/10 text-gray-100 h-12 text-base">
                    <SelectValue placeholder="Select a voice" />
                  </SelectTrigger>
                  <SelectContent className="bg-[#1a1a1e] border-white/20 text-gray-200">
                    {voices.map((voice) => (
                      <SelectItem key={voice.id} value={voice.id}>
                        {voice.name} ({voice.language})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Main 2-column layout */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Left: Source */}
                <div className="bg-white/5 border border-white/10 rounded-lg p-5 space-y-4">
                  <h3 className="font-semibold text-gray-200">Source</h3>
                  <div
                    className={cn(
                      "relative flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-white/20 rounded-lg cursor-pointer transition-colors",
                      "hover:border-cyan-400/80 hover:bg-cyan-900/20",
                      isTranscribing && "cursor-not-allowed opacity-60"
                    )}
                    onClick={() => !isTranscribing && selectSourceMedia()}
                  >
                    {isTranscribing ? (
                      <div className="flex flex-col items-center text-center text-gray-400">
                        <Loader2 className="size-8 animate-spin mb-3" />
                        <p className="font-semibold">Transcribing...</p>
                        <p className="text-sm">{statusText}</p>
                      </div>
                    ) : sourceMediaPath ? (
                      <div className="flex flex-col items-center text-center text-cyan-300">
                        <FileAudio className="size-8 mb-3" />
                        <p className="font-semibold">File Selected</p>
                        <p className="text-sm text-gray-400 truncate max-w-full px-4">
                          {sourceMediaPath.split(/[\\/]/).pop()}
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center text-center text-gray-400">
                        <UploadCloud className="size-8 mb-3" />
                        <p className="font-semibold">Click to upload media</p>
                        <p className="text-sm">MP3, WAV, MP4, M4A</p>
                      </div>
                    )}
                  </div>
                  <Select value={sourceLang} onValueChange={setSourceLang} disabled={isCreating || isTranscribing}>
                    <SelectTrigger className="bg-white/10 border-white/10 text-gray-100">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1a1a1e] border-white/20 text-gray-200">
                      {LANG_OPTIONS.map(l => <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Textarea
                    placeholder="Transcribed text will appear here..."
                    value={transcribedText}
                    onChange={(e) => setTranscribedText(e.target.value)}
                    className="bg-white/5 border-white/10 text-gray-300 h-36 resize-none"
                    readOnly={isCreating}
                  />
                </div>

                {/* Right: Target */}
                <div className="bg-white/5 border border-white/10 rounded-lg p-5 space-y-4">
                  <h3 className="font-semibold text-gray-200">Target</h3>
                  <Select value={targetLang} onValueChange={setTargetLang} disabled={isCreating}>
                    <SelectTrigger className="bg-white/10 border-white/10 text-gray-100">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1a1a1e] border-white/20 text-gray-200">
                      {LANG_OPTIONS.filter(l => l.code !== 'auto').map(l => <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Textarea
                    placeholder="Dubbed text will appear here..."
                    value={dubbedText}
                    readOnly
                    className="bg-black/20 border-white/10 text-gray-400 h-36 resize-none"
                  />
                  {dubbedAudioUrl ? (
                    <audio ref={audioRef} src={dubbedAudioUrl} controls className="w-full" />
                  ) : (
                    <div className="w-full h-14 flex items-center justify-center bg-black/20 rounded-md text-sm text-gray-500">
                      Dubbed audio will appear here
                    </div>
                  )}
                </div>
              </div>
            </div>

            <footer className="p-6 border-t border-white/10 shrink-0 space-y-4">
              {warning && (
                <div className="flex items-start gap-3 rounded-md border border-amber-400/30 bg-amber-900/20 p-3 text-sm">
                  <AlertTriangle className="size-5 text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-amber-200">
                    <p className="font-semibold">Cross-Lingual Warning</p>
                    <p className="text-amber-300/80">{warning}</p>
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 space-y-1">
                  <div className="flex justify-between items-center">
                    <p className="text-sm text-gray-400">{statusText}</p>
                    {isCreating && <p className="text-sm font-mono text-cyan-400">{progress.toFixed(0)}%</p>}
                  </div>
                  <Progress value={progress} className="h-2 bg-white/10 [&>div]:bg-cyan-400" />
                </div>
                {isCreating ? (
                  <Button
                    variant="outline"
                    className="border-red-500/50 text-red-400 hover:bg-red-900/30 hover:text-red-300"
                    onClick={cancelActiveTask}
                  >
                    Cancel
                  </Button>
                ) : (
                  <Button
                    className="bg-gradient-to-r from-cyan-500 to-teal-400 text-white font-bold shadow-lg hover:opacity-90 gap-2"
                    onClick={startDubbing}
                    disabled={!sourceMediaPath || !transcribedText || isTranscribing}
                  >
                    <Wand2 className="size-4" />
                    Start Dubbing
                  </Button>
                )}
              </div>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
