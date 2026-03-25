"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { motion } from "framer-motion";
import { AudioLines, Loader2, Mic, Pause, Upload, Waves } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { showToast } from "@/lib/toast";
import { createVoice, type VoiceTag } from "@/lib/audioVoiceDb"; // ← unified db
import { createTtsTask, updateTtsTask } from "@/lib/audioVoiceDb";

interface QwenVoiceProfileResult {
  prompt_path: string;
  output_probe_path: string;
  model_dir: string;
}

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

interface CreateVoiceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void> | void;
}

const MEDIA_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "flac", "webm", "mp4", "mov", "mkv"];
const TAG_OPTIONS: VoiceTag[] = [
  "conversational",
  "narration",
  "social media",
  "entertainment",
  "advertisement",
  "educational",
];

const LANGUAGES = [
  "Chinese",
  "English",
  "Japanese",
  "Korean",
  "German",
  "French",
  "Russian",
  "Portuguese",
  "Spanish",
  "Italian",
];

const ACCENTS: Record<string, string[]> = {
  English: ["American", "British", "Australian", "Indian", "Other"],
  Chinese: ["Mandarin", "Cantonese", "Other"],
  Japanese: ["Standard", "Kansai", "Other"],
  // Add more as needed
};

export default function CreateVoiceModal({
  open,
  onOpenChange,
  onCreated,
}: CreateVoiceModalProps) {
  const normalizeDialogPath = (rawPath: string) => {
    if (!rawPath) return rawPath;
    if (!rawPath.startsWith("file://")) return rawPath;

    let normalized = decodeURIComponent(rawPath.replace(/^file:\/\//, ""));
    // Windows file URIs commonly look like /C:/path/to/file
    if (/^\/[A-Za-z]:\//.test(normalized)) {
      normalized = normalized.slice(1);
    }
    return normalized;
  };

  const [name, setName] = useState("");
  const [language, setLanguage] = useState("English");
  const [accent, setAccent] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<VoiceTag[]>([]);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referencePath, setReferencePath] = useState<string | null>(null);
  const [referenceBlob, setReferenceBlob] = useState<Uint8Array | null>(null);
  const [referencePreview, setReferencePreview] = useState<string>("");
  const [isRecording, setIsRecording] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("Ready to create voice");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Available accents for selected language
  const currentAccents = useMemo(() => ACCENTS[language] || ["Other"], [language]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  const handleFileSelect = async () => {
    try {
      const file = await openDialog({
        filters: [
          {
            name: "Audio",
            extensions: MEDIA_EXTENSIONS,
          },
        ],
        multiple: false,
      });

      if (!file) return;

      const path = Array.isArray(file) ? file[0] : file;
      if (!path) return;

      const normalizedPath = normalizeDialogPath(path);
      const fileName = normalizedPath.split(/[\\/]/).pop() || "reference_audio";
      let previewUrl = "";

      try {
        previewUrl = await invoke<string>("serve_audio_file", { path: normalizedPath });
      } catch {
        previewUrl = convertFileSrc(normalizedPath);
      }

      setReferenceFile(new File([], fileName));
      setReferencePath(normalizedPath);
      setReferenceBlob(null);
      setReferencePreview(previewUrl);
      setStatusText("Reference audio selected");
    } catch (err) {
      console.error(err);
      showToast("Failed to select file", "error");
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = e => {
        audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        setReferencePreview(url);
        setReferenceFile(new File([blob], `recording_${Date.now()}.webm`, { type: "audio/webm" }));
        blob.arrayBuffer().then(buf => {
          setReferenceBlob(new Uint8Array(buf));
          setReferencePath(null);
        });
        setStatusText("Recording saved");
        setIsRecording(false);
      };

      recorder.start();
      setIsRecording(true);
      setStatusText("Recording... Speak clearly");
    } catch (err) {
      console.error(err);
      showToast("Microphone access denied or unavailable", "error");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const toggleTags = (tag: VoiceTag) => {
    setTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  };

  const submit = async () => {
    if (!name.trim()) {
      showToast("Please enter a voice name", "error");
      return;
    }
    if (!referencePreview) {
      showToast("Please provide a reference audio clip", "error");
      return;
    }
    if (tags.length === 0) {
      showToast("Select at least one style tag warning");
      // optional: continue anyway
    }

    setIsSubmitting(true);
    setProgress(0);
    setStatusText("Creating voice profile...");

    let taskId: string | null = null;
    let unlistenProgress: null | (() => void) = null;
    let unlistenWarning: null | (() => void) = null;

    try {
      // 1) Create local task row so detail page can follow progress.
      const task = await createTtsTask({
        kind: "voice_profile",
        title: `Voice creation: ${name}`,
        inputJson: JSON.stringify({
          name,
          language,
          accent,
          tags,
          description,
          hasReference: !!referencePreview,
        }),
      });
      taskId = task.id;

      await updateTtsTask(task.id, {
        status: "running",
        progress: 0,
        stage: "validate",
        message: "Preparing voice profile generation",
      });

      // 2) Listen to backend progress/warnings for this task only.
      unlistenProgress = await listen<QwenProgressEvent>("qwen-progress", async event => {
        const payload = event.payload;
        if (!payload || payload.task_id !== task.id) return;
        const pct = Math.max(0, Math.min(100, Number(payload.percentage ?? 0)));
        setProgress(pct);
        setStatusText(payload.message || "Generating voice profile...");
        await updateTtsTask(task.id, {
          status: pct >= 100 ? "completed" : "running",
          progress: pct,
          stage: payload.stage || undefined,
          message: payload.message || undefined,
        });
      });

      unlistenWarning = await listen<QwenWarningEvent>("qwen-warning", async event => {
        const payload = event.payload;
        if (!payload || payload.task_id !== task.id) return;
        const warning = payload.message || "Warning during voice profile creation";
        showToast(warning, "info");
        await updateTtsTask(task.id, { message: warning });
      });

      // 3) Call Rust backend command that actually exists.
      const result = await invoke<QwenVoiceProfileResult>("create_qwen_voice_profile", {
        voiceName: name,
        referenceAudioPath: referencePath,
        referenceBlob: referenceBlob ? Array.from(referenceBlob) : null,
        sourceExt: referenceFile?.name.split(".").pop()?.toLowerCase(),
        referenceText: description || undefined,
        refText: description || undefined,
        language,
        taskId: task.id,
      });

      unlistenProgress?.();
      unlistenWarning?.();
      unlistenProgress = null;
      unlistenWarning = null;

      setProgress(100);
      setStatusText("Voice profile created successfully!");

      // 4) Save to local DB.
      await createVoice({
        name,
        language,
        accent: accent || undefined,
        tags,
        description,
        previewPath: result.output_probe_path,
        promptPath: result.prompt_path,
        sourceType: referenceFile?.name.includes("recording") ? "microphone" : "file",
      });

      await updateTtsTask(task.id, {
        status: "completed",
        progress: 100,
        stage: "done",
        message: "Voice profile created",
        resultJson: JSON.stringify(result),
        artifactPath: result.prompt_path,
      });

      showToast("Voice created successfully!", "success");
      onCreated();
      onOpenChange(false);
    } catch (err: any) {
      console.error(err);
      showToast(err?.message || "Failed to create voice profile", "error");
      setStatusText("Creation failed");
      if (taskId) {
        await updateTtsTask(taskId, {
          status: "failed",
          stage: "error",
          message: String(err?.message || err || "Unknown error"),
        }).catch(() => undefined);
      }
    } finally {
      unlistenProgress?.();
      unlistenWarning?.();
      setIsSubmitting(false);
      setProgress(0);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl bg-background border-border/50 text-foreground">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold">Create New Voice Profile</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Upload or record a short reference clip (3–15 seconds) to clone a voice using Qwen3-TTS.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Basic info */}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-2">Voice Name *</label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Karoline"
                className="bg-card border-border/50"
                disabled={isSubmitting}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Language</label>
              <Select value={language} onValueChange={setLanguage} disabled={isSubmitting}>
                <SelectTrigger className="bg-card border-border/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map(l => (
                    <SelectItem key={l} value={l}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-2">Accent (optional)</label>
              <Select value={accent} onValueChange={setAccent} disabled={isSubmitting}>
                <SelectTrigger className="bg-card border-border/50">
                  <SelectValue placeholder="General" />
                </SelectTrigger>
                <SelectContent>
                  {currentAccents.map(a => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Style Tags</label>
              <div className="flex flex-wrap gap-2">
                {TAG_OPTIONS.map(tag => (
                  <Badge
                    key={tag}
                    variant={tags.includes(tag) ? "default" : "outline"}
                    className={`cursor-pointer transition-all ${
                      tags.includes(tag)
                        ? "bg-primary hover:bg-primary/90"
                        : "hover:bg-muted/80"
                    }`}
                    onClick={() => toggleTags(tag)}
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Description (optional)</label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Short description of the voice style, tone, or use-case..."
              className="min-h-20 bg-card border-border/50"
              disabled={isSubmitting}
            />
          </div>

          {/* Reference audio section */}
          <div className="rounded-2xl border border-border/50 bg-card/60 p-6">
            <h3 className="text-lg font-semibold mb-4">Reference Audio Clip *</h3>

            <div className="grid gap-6 md:grid-cols-2">
              {/* Upload / Record controls */}
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button
                    variant="outline"
                    className="flex-1 gap-2 border-primary/40 hover:bg-primary/10"
                    onClick={handleFileSelect}
                    disabled={isSubmitting || isRecording}
                  >
                    <Upload className="size-4" />
                    Upload Audio
                  </Button>

                  <Button
                    variant={isRecording ? "destructive" : "outline"}
                    className="flex-1 gap-2"
                    onClick={toggleRecording}
                    disabled={isSubmitting}
                  >
                    {isRecording ? (
                      <>
                        <Pause className="size-4" />
                        Stop Recording
                      </>
                    ) : (
                      <>
                        <Mic className="size-4" />
                        Record
                      </>
                    )}
                  </Button>
                </div>

                {referenceFile && (
                  <div className="text-sm text-muted-foreground">
                    Selected: <span className="font-medium">{referenceFile.name}</span>
                  </div>
                )}
              </div>

              {/* Preview player */}
              <div className="flex flex-col justify-center">
                {referencePreview ? (
                  <div className="rounded-xl border border-border/50 bg-black/40 p-4">
                    <audio
                      controls
                      src={referencePreview}
                      className="w-full"
                      onPlay={() => setStatusText("Playing reference preview...")}
                    />
                  </div>
                ) : (
                  <div className="text-center text-muted-foreground py-8 border border-dashed border-border/50 rounded-xl">
                    <Waves className="size-10 mx-auto mb-3 opacity-50" />
                    <p>Upload or record a clip to preview</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Progress & status */}
          {(isSubmitting || progress > 0) && (
            <div className="rounded-xl border border-border/50 bg-card/60 p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className={`size-3 rounded-full ${progress === 100 ? "bg-emerald-500" : "bg-primary animate-pulse"}`} />
                <span className="font-medium">{statusText}</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-4 pt-4 border-t border-border/50">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={isSubmitting || !name.trim() || !referencePreview}
              className="min-w-40 gap-2 bg-linear-to-r from-emerald-600 via-purple-600 to-pink-600 hover:opacity-90 shadow-lg"
            >
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              Create Voice
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}