"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Mic,
  Brain,
  ShieldCheck,
  FileAudio,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import OnboardingCard from "@/components/OnboardingCard";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

const MEDIA_FILE_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "flac", "mp4", "mkv", "webm", "mov"];

const WhisperTranscriber = dynamic(() => import("@/components/WhisperTranscriber"), {
  ssr: false,
});

const steps = [
  {
    id: "transcribe-tutorial-1-models122",
    title: "Step 1: Download AI Models",
    description: "Go to Settings (gear icon top-right) and download the Whisper models you want to use. Larger models give better accuracy but take longer on first download.",
    imageSrc: "/images/settings-models-download.png",
    buttonText: "Next",
  },
  {
    id: "transcribe-tutorial-2-select-file122",
    title: "Step 2: Select Your File",
    description: "Drag & drop any audio or video file here, or click the dropzone to browse. Supported formats: MP3, WAV, MP4, M4A, OGG, FLAC, MKV, WEBM, MOV.",
    imageSrc: "/images/transcribe-dropzone-preview.png",
    buttonText: "Next",
  },
  {
    id: "transcribe-tutorial-3-model-language122",
    title: "Step 3: Choose Model & Language",
    description: "Select the Whisper model from the dropdown (base or small are good starting points). Language can be set to Auto Detect or a specific one for better accuracy.",
    imageSrc: "/images/transcribe-model-language.png",
    buttonText: "Next",
  },
  {
    id: "transcribe-tutorial-4-processing-time122",
    title: "Step 4: Processing Time",
    description: "Time depends on your GPU/CPU and file size. Tiny/Base models are very fast. Larger models (large-v3) may take longer on big files but give superior accuracy.",
    imageSrc: "/images/speed-gauge.png",
    buttonText: "Got it!",
  },
  {
    id: "transcribe-tutorial-5-preview-only122",
    title: "This is Just a Preview",
    description: "This is just a preview.For full features — speaker diarization (who said what), segmentation, translation to other languages, and detailed analysis — go to the Transcriptions tab after processing.",
    imageSrc: "/images/output.gif",
    buttonText: "Got it!",
  },
];

export default function TranscribePage() {
  const [mounted, setMounted] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const t = useTranslations();

  const [step, setStep] = useState(0);

  const handleNext = () => {
    if (step < steps.length - 1) {
      setStep(step + 1);
    }
  };

  if (step >= steps.length) return null;

  const current = steps[step];

  useEffect(() => {
    setMounted(true);
  }, []);

  const isSupportedMediaPath = (path: string) => {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    return MEDIA_FILE_EXTENSIONS.includes(ext);
  };

  const tryUseDroppedFile = (droppedFile: File | null) => {
    if (!droppedFile) return false;

    const ext = droppedFile.name.split(".").pop()?.toLowerCase() || "";
    if (!MEDIA_FILE_EXTENSIONS.includes(ext)) {
      alert("Please drop an audio or video file (mp3, wav, mp4, etc.)");
      return false;
    }

    setSelectedPath(null);
    setSelectedName(null);
    setFile(droppedFile);
    return true;
  };

  useEffect(() => {
    let dragDepth = 0;

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragDepth += 1;
      setIsDragOver(true);
    };

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setIsDragOver(true);
    };

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        setIsDragOver(false);
      }
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth = 0;
      setIsDragOver(false);

      const droppedFile = e.dataTransfer?.files?.[0] ?? null;
      tryUseDroppedFile(droppedFile);
    };

    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);

    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const subscribe = async () => {
      try {
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setIsDragOver(true);
            return;
          }

          if (event.payload.type === "leave") {
            setIsDragOver(false);
            return;
          }

          if (event.payload.type === "drop") {
            setIsDragOver(false);
            const path = event.payload.paths?.[0];
            if (!path) return;

            if (!isSupportedMediaPath(path)) {
              alert("Please drop an audio or video file (mp3, wav, mp4, etc.)");
              return;
            }

            setFile(null);
            setSelectedPath(path);
            setSelectedName(path.split(/[\\/]/).pop() || "selected-file");
          }
        });
      } catch (err) {
        console.error("Failed to attach Tauri drag-drop listener:", err);
      }
    };

    void subscribe();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  if (!mounted) return null;

  const features = [
    {
      title: t("Whisper AI"),
      desc: t("Whisper AI desc"),
      icon: Brain,
      color: "text-blue-500",
    },
    {
      title: t("SRT Export"),
      desc: t("SRT Export desc"),
      icon: FileAudio,
      color: "text-pink-500",
    },
    {
      title: t("No Clouds"),
      desc: t("No Clouds desc"),
      icon: ShieldCheck,
      color: "text-green-500",
    },
  ];

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const droppedFile = e.dataTransfer?.files?.[0] ?? null;
    tryUseDroppedFile(droppedFile);
  };

  const pickFromSystemDialog = async () => {
    try {
      const selected = await open({
        title: "Select Audio or Video File",
        filters: [{
          name: "Audio & Video",
          extensions: ["mp3", "wav", "m4a", "ogg", "flac", "mp4", "mkv", "webm", "mov"],
        }],
        multiple: false,
        directory: false,
      });

      if (!selected || Array.isArray(selected)) return;

      setFile(null);
      setSelectedPath(selected);
      setSelectedName(selected.split(/[\\/]/).pop() || "selected-file");
    } catch (err) {
      console.error("File picker error:", err);
    }
  };

  const handleDrag = (e: React.DragEvent<HTMLDivElement>, over: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(over);
  };

  const hasSelection = Boolean(file || selectedPath);

  return (
    <div className="min-h-screen p-8 lg:p-12">
      <header className="mb-12">
        <h1 className="text-5xl font-black tracking-tight mb-4">{t("AI Transcriber")}</h1>
        <p className="text-xl text-zinc-500 font-medium">{t("AI-transcriber-desc")}</p>
      </header>

      <OnboardingCard
        id={current.id}
        title={current.title}
        description={current.description}
        imageSrc={current.imageSrc}
        buttonText={current.buttonText}
        onFinish={handleNext}
      />

      <main className="max-w-6xl">
        {!hasSelection ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="group relative"
          >
            <div
              className={`absolute inset-0 rounded-[64px] blur-3xl pointer-events-none transition-colors duration-500 ${isDragOver ? "bg-blue-500/30" : "bg-blue-100/10 group-hover:bg-blue-100/30"
                }`}
            />

            <div
              className={`
                relative aspect-video lg:aspect-[21/9]
                border-4 border-dashed rounded-[64px]
                flex flex-col items-center justify-center gap-8
                transition-all duration-300 cursor-pointer
                ${isDragOver
                  ? "border-blue-500 bg-blue-950/40 scale-[1.015] shadow-2xl ring-4 ring-blue-500/40"
                  : "border-zinc-300 dark:border-zinc-700 hover:border-blue-400 dark:hover:border-blue-600 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md"
                }
              `}
              onDragEnter={(e) => handleDrag(e, true)}
              onDragOver={(e) => handleDrag(e, true)}
              onDragLeave={(e) => handleDrag(e, false)}
              onDrop={handleDrop}
              onClick={pickFromSystemDialog}
            >
              <div
                className={`w-24 h-24 rounded-3xl flex items-center justify-center shadow-xl transition-transform duration-300 ${isDragOver ? "scale-110 bg-blue-600" : "bg-white dark:bg-zinc-800"
                  }`}
              >
                <Mic className={`w-12 h-12 ${isDragOver ? "text-white" : "text-blue-500"}`} />
              </div>

              <div className="text-center px-6">
                <p className="text-3xl font-black mb-3">
                  {isDragOver ? "Drop now!" : t("Drop your audio or video")}
                </p>
                <p className="text-lg text-zinc-500 dark:text-zinc-400 font-medium">
                  MP3, WAV, MP4, M4A, OGG, FLAC, MKV, WEBM {t("up to 500MB")}
                </p>
              </div>
            </div>
          </motion.div>
        ) : (
          <WhisperTranscriber
            file={file}
            initialFilePath={selectedPath}
            initialFileName={selectedName}
            onCancel={() => {
              setFile(null);
              setSelectedPath(null);
              setSelectedName(null);
            }}
          />
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-16">
          {features.map((feature, i) => (
            <div
              key={i}
              className="p-8 rounded-[40px] bg-white dark:bg-zinc-900/80 border border-zinc-100 dark:border-zinc-800 shadow-sm backdrop-blur-sm"
            >
              <div className="w-14 h-14 bg-zinc-50 dark:bg-zinc-800 rounded-2xl flex items-center justify-center mb-6">
                <feature.icon className={`w-7 h-7 ${feature.color}`} />
              </div>
              <h3 className="text-xl font-bold mb-3">{feature.title}</h3>
              <p className="text-zinc-600 dark:text-zinc-400 leading-relaxed">{feature.desc}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}