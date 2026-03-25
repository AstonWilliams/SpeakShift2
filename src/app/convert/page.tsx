"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload,
  Scissors,
  ArrowRight,
  Download,
  Loader2,
  X,
  Plus,
  ChevronDown,
  Settings2,
  Video
} from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import OnboardingCard from "@/components/OnboardingCard";

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
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState("idle");

  const [step, setStep] = useState(0);

  const handleNext = () => {
    if (step < videoEditingSteps.length - 1) {
      setStep(step + 1);
    }
  };

  if (step >= videoEditingSteps.length) return null;

  const current = videoEditingSteps[step];

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const features = [
    { title: t("Smart Crop"), desc: t("Smart Crop desc"), icon: Scissors },
    { title: t("4K Support"), desc: t("4K Support desc"), icon: Video },
    { title: t("Privacy"), desc: t("Privacy desc"), icon: Settings2 },
  ];

  return (
    <div className="min-h-screen p-8 lg:p-12">
      <header className="mb-12">
        <h1 className="text-5xl font-black tracking-tight mb-4">{t("Video Converter h1")}</h1>
        <p className="text-xl text-zinc-500 font-medium">{t("Video Converter desc")}</p>
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
        {!file ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="group relative"
          >
            <div className="absolute inset-0 bg-pink-100/20 blur-3xl group-hover:bg-pink-100/40 transition-colors rounded-[64px]" />
            <div
              className="relative aspect-video lg:aspect-[21/9] border-4 border-dashed border-zinc-200 dark:border-zinc-800 rounded-[64px] flex flex-col items-center justify-center gap-6 cursor-pointer hover:border-pink-300 dark:hover:border-pink-900 transition-all bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm"
              onClick={() => document.getElementById("file-upload")?.click()}
            >
              <div className="w-20 h-20 bg-white dark:bg-zinc-800 rounded-3xl flex items-center justify-center shadow-xl group-hover:scale-110 transition-transform">
                <Upload className="w-10 h-10 text-pink-500" />
              </div>
              <div className="text-center">
                <p className="text-2xl font-black mb-2">{t("Drop your video here")}</p>
                <p className="text-zinc-400 font-bold">MP4, MOV, WEBM {t("up to 2GB")}</p>
              </div>
              <input
                id="file-upload"
                type="file"
                className="hidden"
                accept="video/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setFile(f);
                }}
              />
            </div>
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
              <p className="text-zinc-500 dark:text-zinc-400 font-medium leading-relaxed">{feature.desc}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
