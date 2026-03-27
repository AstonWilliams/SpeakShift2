"use client";

import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Upload,
  Scissors,
  Settings2,
  Video
} from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import OnboardingCard from "@/components/OnboardingCard";

const VIDEO_FILE_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

const videoEditingSteps = [
  {
    id: "videoedit-welcome-1",
    title: "Welcome to Video Editing Studio",
    description: "This is your local, private workspace to edit, enhance, and export videos — everything happens on your device with zero uploads.",
    imageSrc: "/images/convrt1.png", // screenshot of empty editing area
    buttonText: "Next",
  },
  {
    id: "videoedit-filters-2",
    title: "Step 1: Apply Filters & Color Looks",
    description: "Choose from built-in filters like Vignette, Grayscale, Sepia, Vintage, or others to instantly change the mood of your video.",
    imageSrc: "/images/convrt2.png", // screenshot showing filter dropdown/list
    buttonText: "Next",
  },
  {
    id: "videoedit-tweaks-3",
    title: "Step 2: Fine-Tune Brightness, Contrast & More",
    description: "Adjust brightness, contrast, saturation, exposure, sharpness, and other settings to make your video look exactly how you want.",
    imageSrc: "/images/convrt3.png", // screenshot of sliders for brightness/contrast/etc.
    buttonText: "Next",
  },
  {
    id: "videoedit-export-4",
    title: "Step 3: Export to Any Platform",
    description: "Choose crop presets for TikTok (9:16), YouTube (16:9), Instagram (1:1 or stories), and render in different resolutions (360p to 4K). Click Export to save locally.",
    imageSrc: "/images/convrt4.png", // screenshot of export modal with presets & resolution dropdown
    buttonText: "Got it!",
  },
];

// FFmpeg is loaded dynamically to avoid Turbopack build issues with WASM/Workers
const FFmpegWrapper = dynamic(() => import("@/components/FFmpegProcessor"), { ssr: false });

export default function ConvertPage() {
  const t = useTranslations();
  const [mounted, setMounted] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState(0);

  const handleNext = () => {
    setStep((prev) => Math.min(prev + 1, videoEditingSteps.length));
  };

  const isVideoFile = (picked: File) => {
    if (picked.type.startsWith("video/")) {
      return true;
    }

    const ext = picked.name.split(".").pop()?.toLowerCase() ?? "";
    return VIDEO_FILE_EXTENSIONS.includes(ext);
  };

  const isSupportedVideoPath = (path: string) => {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    return VIDEO_FILE_EXTENSIONS.includes(ext);
  };

  const handleFilePicked = (picked: File | null | undefined) => {
    if (!picked) return;
    if (!isVideoFile(picked)) return;
    setFile(picked);
  };

  const loadVideoFromPath = async (path: string) => {
    const bytes = await invoke<number[]>("get_processed_file_bytes", { path });
    const uint8 = new Uint8Array(bytes);
    const filename = path.split(/[\\/]/).pop() || "video.mp4";
    const ext = filename.split(".").pop()?.toLowerCase() || "mp4";
    const mime =
      ext === "mov" ? "video/quicktime"
        : ext === "webm" ? "video/webm"
          : ext === "mkv" ? "video/x-matroska"
            : "video/mp4";

    const picked = new File([uint8], filename, { type: mime });
    setFile(picked);
  };

  const openWithSystemDialog = async () => {
    try {
      const selected = await open({
        title: "Select video",
        filters: [
          { name: "Video", extensions: VIDEO_FILE_EXTENSIONS },
        ],
        multiple: false,
        directory: false,
      });

      if (!selected || typeof selected !== "string") {
        return;
      }

      await loadVideoFromPath(selected);
    } catch (error) {
      console.error("Failed to open video via native dialog", error);
      fileInputRef.current?.click();
    }
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let dragDepth = 0;

    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      dragDepth += 1;
      setIsDragOver(true);
    };

    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      setIsDragOver(true);
    };

    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        setIsDragOver(false);
      }
    };

    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      dragDepth = 0;
      setIsDragOver(false);

      const droppedFile = event.dataTransfer?.files?.[0] ?? null;
      handleFilePicked(droppedFile);
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
            if (!path || !isSupportedVideoPath(path)) {
              return;
            }

            void loadVideoFromPath(path);
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

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);

    const droppedFile = event.dataTransfer?.files?.[0] ?? null;
    handleFilePicked(droppedFile);
  };

  const handleDrag = (event: React.DragEvent<HTMLDivElement>, over: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(over);
  };

  if (!mounted) return null;

  const showOnboarding = step < videoEditingSteps.length;
  const current = showOnboarding ? videoEditingSteps[step] : null;

  const features = [
    { title: t("Smart Crop"), desc: t("Smart Crop desc"), icon: Scissors },
    { title: t("4K Support"), desc: t("4K Support desc"), icon: Video },
    { title: t("Privacy"), desc: t("Privacy desc"), icon: Settings2 },
  ];

  return (
    <div className="min-h-screen p-8 lg:p-12">
      <header className="mb-12">
        <h1 className="text-5xl font-black tracking-tight mb-4">{t("Video Converter h1")}</h1>
        <p className="text-xl text-zinc-700 dark:text-zinc-300 font-medium">{t("Video Converter desc")}</p>
      </header>
      {current && (
        <OnboardingCard
          id={current.id}
          title={current.title}
          description={current.description}
          imageSrc={current.imageSrc}
          buttonText={current.buttonText}
          onFinish={handleNext}
        />
      )}
      <main className="max-w-6xl">
        {!file ? (
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
              role="button"
              tabIndex={0}
              className={`relative aspect-video lg:aspect-21/9 border-4 border-dashed rounded-[64px] flex flex-col items-center justify-center gap-8 transition-all duration-300 cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400/40 ${isDragOver
                ? "border-blue-500 bg-blue-950/40 scale-[1.015] shadow-2xl ring-4 ring-blue-500/40"
                : "border-zinc-300 dark:border-zinc-700 hover:border-blue-400 dark:hover:border-blue-600 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md"
                }`}
              onClick={() => void openWithSystemDialog()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void openWithSystemDialog();
                }
              }}
              onDragEnter={(e) => handleDrag(e, true)}
              onDragOver={(e) => handleDrag(e, true)}
              onDragLeave={(e) => handleDrag(e, false)}
              onDrop={handleDrop}
              aria-label={t("Drop your video here")}
            >
              <div className={`w-24 h-24 rounded-3xl flex items-center justify-center shadow-xl transition-transform duration-300 ${isDragOver ? "scale-110 bg-blue-600" : "bg-white dark:bg-zinc-800"}`}>
                <Upload className={`w-12 h-12 ${isDragOver ? "text-white" : "text-blue-500"}`} />
              </div>
              <div className="text-center px-6">
                <p className="text-3xl font-black mb-3">{isDragOver ? "Drop now!" : t("Drop your video here")}</p>
                <p className="text-lg text-zinc-600 dark:text-zinc-400 font-medium">MP4, MOV, MKV, WEBM, AVI, M4V {t("up to 2GB")}</p>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">Click to browse</p>
              </div>
            </div>
            <input
              ref={fileInputRef}
              id="file-upload"
              type="file"
              className="hidden"
              accept="video/*"
              onChange={(e) => {
                handleFilePicked(e.target.files?.[0]);
              }}
            />
          </motion.div>
        ) : (
          <FFmpegWrapper file={file} onCancel={() => setFile(null)} />
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-12">
          {features.map((feature, i) => (
            <div key={i} className="p-8 rounded-[40px] bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 shadow-sm">
              <div className="w-12 h-12 bg-zinc-50 dark:bg-zinc-800 rounded-2xl flex items-center justify-center mb-6">
                <feature.icon className="w-6 h-6 text-pink-500" />
              </div>
              <h3 className="text-xl font-bold mb-2">{feature.title}</h3>
              <p className="text-zinc-700 dark:text-zinc-300 font-medium leading-relaxed">{feature.desc}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
