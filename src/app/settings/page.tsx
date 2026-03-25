"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Settings,
  Moon,
  Sun,
  Monitor,
  Download,
  Loader2,
  AlertTriangle,
  Trash2,
  CheckCircle,
  RefreshCw,
  Shield,
  Database,
  Users,
  Languages,
  AudioLines,
} from "lucide-react";
import { useTheme } from "next-themes";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useAppLocale } from "@/lib/IntlProvider";
import { Globe } from "lucide-react";
import { useTranslations } from "next-intl";

const WHISPER_MODELS = [
  "tiny", "tiny.en", "base", "base.en", "small", "small.en",
  "medium", "medium.en", "large-v3", "large-v3-turbo",
] as const;
type ModelType = (typeof WHISPER_MODELS)[number];

const DIARIZATION_MODELS = [
  "diar_sortformer_4spk-v1.onnx",
  "diar_streaming_sortformer_4spk-v2.1.onnx",
  "diar_streaming_sortformer_4spk-v2.onnx",
] as const;

type DiarModelType = (typeof DIARIZATION_MODELS)[number];

// ──────────────────────────────────────────────────────────────
// NLLB-200 variants from Xenova repo (most useful quantized ones)
// We show friendly names, real filename prefix + quantized suffix
// ──────────────────────────────────────────────────────────────
const NLLB_VARIANTS = [
  {
    id: "nllb_int8_float16",
    name: "int8 + float16",
    size: "~2.2 GB",
    description: "Best balance of speed and quality",
  },
  {
    id: "nllb_float16",
    name: "float16",
    size: "~2.8 GB",
    description: "Good quality, fast inference",
  },
  {
    id: "nllb_float32",
    name: "float32 (full precision)",
    size: "~6.5 GB",
    description: "Highest quality, more RAM usage",
  },
  {
    id: "nllb_int8_float32",
    name: "int8 + float32",
    size: "~~4–5 GB",
    description: "Good quality, smaller than fp32",
  },
] as const;

type NllbVariant = (typeof NLLB_VARIANTS)[number];

interface DownloadedNllbModel {
  folder_name: string;
  exists: boolean;
}

interface QwenModelStatus {
  model_dir: string;
  prompt_dir: string;
  is_ready: boolean;
  total_files: number;
  downloaded_files: number;
  missing_files: string[];
  supported_languages: string[];
}

interface ParakeetTdtModelStatus {
  model_dir: string;
  is_ready: boolean;
  total_files: number;
  downloaded_files: number;
  missing_files: string[];
  active_model_dir?: string | null;
}

const LANGUAGES = [
  { code: "en", name: "English", greeting: "Hello" },
  { code: "es", name: "Español", greeting: "Hola" },
  { code: "fr", name: "Français", greeting: "Bonjour" },
  { code: "de", name: "Deutsch", greeting: "Hallo" },
  { code: "zh", name: "中文", greeting: "你好" },
  { code: "ar", name: "العربية", greeting: "مرحبا" },
  { code: "hi", name: "हिन्दी", greeting: "नमस्ते" },
  { code: "he", name: "עברית", greeting: "שלום" },
];

// Helper to create nice display names without changing real filenames
const getDiarModelDisplayName = (filename: string): string => {
  if (filename.includes("streaming") && filename.includes("v2.1")) {
    return "Streaming Sortformer v2.1";
  }
  if (filename.includes("streaming") && filename.includes("v2")) {
    return "Streaming Sortformer v2";
  }
  if (filename.includes("sortformer") && filename.includes("v1")) {
    return "Standard Sortformer v1";
  }
  // Fallback: clean filename
  return filename
    .replace("diar_", "")
    .replace("_", " ")
    .replace("-", " ")
    .replace(".onnx", "")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
};

const getDiarModelSubtitle = (filename: string): string => {
  if (filename.includes("streaming")) {
    return "Streaming / long files • 4 speakers";
  }
  return "Standard • 4 speakers";
};

export default function SettingsPage() {
  const [mounted, setMounted] = useState(false);
  const { theme, resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [downloadedModels, setDownloadedModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeDiarModel, setActiveDiarModel] = useState<string>("");
  const [whisperModelToDelete, setWhisperModelToDelete] = useState<ModelType | null>(null);

  const [nllbModels, setNllbModels] = useState<DownloadedNllbModel[]>([]);
  const [activeNllbModel, setActiveNllbModel] = useState<string>("");
  const [nllbDownloadStatus, setNllbDownloadStatus] = useState<
    Record<string, { loading: boolean; progress: number }>
  >({});
  const [nllbModelToDelete, setNllbModelToDelete] = useState<string | null>(null);

  const [qwenStatus, setQwenStatus] = useState<QwenModelStatus | null>(null);
  const [qwenBusy, setQwenBusy] = useState(false);
  const [qwenProgress, setQwenProgress] = useState(0);
  const [qwenCurrentFile, setQwenCurrentFile] = useState("");

  const [tdtStatus, setTdtStatus] = useState<ParakeetTdtModelStatus | null>(null);
  const [tdtBusy, setTdtBusy] = useState(false);
  const [tdtProgress, setTdtProgress] = useState(0);
  const [tdtCurrentFile, setTdtCurrentFile] = useState("");

  const [modelStatus, setModelStatus] = useState<Record<string, {
    loading: boolean;
    success?: boolean;
    error?: string;
  }>>({});

  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [downloadedDiarModels, setDownloadedDiarModels] = useState<string[]>([]);
  const [diarModelStatus, setDiarModelStatus] = useState<Record<string, {
    loading: boolean;
    success?: boolean;
    error?: string;
  }>>({});

  const [diarDownloadProgress, setDiarDownloadProgress] = useState<Record<string, number>>({});

  const [diarModelToDelete, setDiarModelToDelete] = useState<string | null>(null);

  const [modelToDelete, setModelToDelete] = useState<string | null>(null);

  const { locale, setLocale } = useAppLocale();
  const t = useTranslations();

  useEffect(() => {
    setMounted(true);
    loadModels();
    loadDiarModels();
    loadNllbModels();
    loadQwenModelStatus();
    loadTdtModelStatus();

    const unlisten = listen("download-model-progress", (event) => {
      const payload = event.payload as {
        model: string;
        percentage: number;
      };
      setDownloadProgress((prev) => ({
        ...prev,
        [payload.model]: payload.percentage,
      }));
    });

    // ──── NEW: Diarization progress listener ────
    const unlistenDiar = listen("download-diar-model-progress", (event) => {
      const payload = event.payload as { model: string; percentage: number };
      setDiarDownloadProgress((prev) => ({
        ...prev,
        [payload.model]: payload.percentage,
      }));
    });

    const unlistenNllb = listen("translation-download-progress", (event) => {
      const payload = event.payload as {
        variant: string;
        percent: number;
        // file?: string; total?: number; progress?: number; — optional
      };
      setModelStatus((prev) => ({
        ...prev,
        [payload.variant]: {
          ...prev[payload.variant],
          progress: payload.percent,
          loading: payload.percent < 100,
        },
      }));
    });

    const unlistenQwen = listen("qwen-model-download-progress", (event) => {
      const payload = event.payload as {
        percent?: number;
        file?: string;
      };
      setQwenProgress(Math.max(0, Math.min(100, Number(payload?.percent ?? 0))));
      setQwenCurrentFile(payload?.file || "");
    });

    const unlistenTdt = listen("parakeet-tdt-model-download-progress", (event) => {
      const payload = event.payload as {
        percentage?: number;
        file?: string;
      };
      setTdtProgress(Math.max(0, Math.min(100, Number(payload?.percentage ?? 0))));
      setTdtCurrentFile(payload?.file || "");
    });

    return () => {
      unlisten.then((f) => f());
      unlistenDiar?.then((f) => f?.());
      unlistenNllb.then((f) => f());
      unlistenQwen.then((f) => f());
      unlistenTdt.then((f) => f());
    };
  }, []);

  useEffect(() => {
    loadNllbModels();
    loadActiveNllbModel();

    // Listen for download progress
    const unsubscribe = listen("nllb-download-progress", (event: any) => {
      const { folder, status, percent } = event.payload;

      setNllbDownloadStatus((prev) => ({
        ...prev,
        [folder]: {
          loading: status !== "completed",
          progress: percent || 0,
        },
      }));

      if (status === "completed") {
        toast.success(`Model ${folder} downloaded successfully`);
        loadNllbModels(); // refresh list
      }
    });

    return () => {
      unsubscribe.then((f) => f());
    };
  }, []);

  const loadNllbModels = async () => {
    try {
      const models = await invoke<DownloadedNllbModel[]>("list_downloaded_nllb_models");
      setNllbModels(models);
    } catch (err) {
      console.error("Failed to load NLLB models:", err);
      toast.error("Could not load translation models");
    }
  };

  const loadQwenModelStatus = async () => {
    try {
      const status = await invoke<QwenModelStatus>("get_qwen_model_status");
      setQwenStatus(status);
      const calculated = status.total_files > 0
        ? Math.round((status.downloaded_files / status.total_files) * 100)
        : 0;
      setQwenProgress(calculated);
    } catch (err) {
      console.error("Failed to load qwen model status:", err);
      toast.error("Could not load Qwen model status");
    }
  };

  const loadTdtModelStatus = async () => {
    try {
      const status = await invoke<ParakeetTdtModelStatus>("get_parakeet_tdt_model_status");
      setTdtStatus(status);
      const calculated = status.total_files > 0
        ? Math.round((status.downloaded_files / status.total_files) * 100)
        : 0;
      setTdtProgress(calculated);
    } catch (err) {
      console.error("Failed to load Parakeet-TDT model status:", err);
      toast.error("Could not load Parakeet-TDT model status");
    }
  };

  const ensureTdtModel = async () => {
    setTdtBusy(true);
    setTdtCurrentFile("");
    try {
      const status = await invoke<ParakeetTdtModelStatus>("ensure_tdt_model");
      setTdtStatus(status);
      setTdtProgress(status.is_ready ? 100 : tdtProgress);
      toast.success("Parakeet-TDT model is ready");
    } catch (err: any) {
      toast.error(err?.message || "Failed to ensure Parakeet-TDT model");
    } finally {
      setTdtBusy(false);
    }
  };

  const downloadTdtModel = async () => {
    setTdtBusy(true);
    setTdtCurrentFile("");
    try {
      const status = await invoke<ParakeetTdtModelStatus>("download_parakeet_tdt_model");
      setTdtStatus(status);
      setTdtProgress(100);
      toast.success("Parakeet-TDT model downloaded");
    } catch (err: any) {
      toast.error(err?.message || "Failed to download Parakeet-TDT model");
    } finally {
      setTdtBusy(false);
    }
  };

  const deleteTdtModel = async () => {
    setTdtBusy(true);
    try {
      const status = await invoke<ParakeetTdtModelStatus>("delete_parakeet_tdt_model");
      setTdtStatus(status);
      setTdtProgress(0);
      setTdtCurrentFile("");
      toast.success("Parakeet-TDT model deleted");
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete Parakeet-TDT model");
    } finally {
      setTdtBusy(false);
    }
  };

  const downloadQwenModel = async () => {
    setQwenBusy(true);
    setQwenCurrentFile("");
    try {
      const status = await invoke<QwenModelStatus>("download_qwen_model");
      setQwenStatus(status);
      setQwenProgress(100);
      toast.success("Qwen3-TTS base model downloaded");
    } catch (err: any) {
      toast.error(err?.message || "Failed to download Qwen model");
    } finally {
      setQwenBusy(false);
    }
  };

  const deleteQwenModel = async () => {
    setQwenBusy(true);
    try {
      const status = await invoke<QwenModelStatus>("delete_qwen_model");
      setQwenStatus(status);
      setQwenProgress(0);
      setQwenCurrentFile("");
      toast.success("Qwen model removed from local storage");
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete Qwen model");
    } finally {
      setQwenBusy(false);
    }
  };

  const loadActiveNllbModel = async () => {
    try {
      const active: string = await invoke("get_active_nllb_model");
      setActiveNllbModel(active);
    } catch (err) {
      console.error("Failed to get active model:", err);
    }
  };

  const handleDownloadNllb = async (folderName: string) => {
    try {
      setNllbDownloadStatus((prev) => ({
        ...prev,
        [folderName]: { loading: true, progress: 0 },
      }));

      await invoke("download_nllb_model", { folderName });
      // Progress is handled via events
    } catch (err: any) {
      toast.error(`Download failed: ${err?.message || "Unknown error"}`);
      setNllbDownloadStatus((prev) => ({
        ...prev,
        [folderName]: { loading: false, progress: 0 },
      }));
    }
  };

  const handleSetActiveNllb = async (folderName: string) => {
    try {
      await invoke("set_active_nllb_model", { folderName });
      setActiveNllbModel(folderName);
      toast.success(`Activated model: ${folderName}`);
    } catch (err: any) {
      toast.error(`Failed to activate model: ${err?.message}`);
    }
  };

  const handleDeleteNllb = async () => {
    if (!nllbModelToDelete) return;

    try {
      await invoke("delete_nllb_model", { folderName: nllbModelToDelete });
      toast.success(`Model ${nllbModelToDelete} deleted`);
      loadNllbModels();
      if (activeNllbModel === nllbModelToDelete) {
        setActiveNllbModel("");
      }
    } catch (err: any) {
      toast.error(`Failed to delete: ${err?.message}`);
    } finally {
      setNllbModelToDelete(null);
    }
  };

  const loadModels = async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const models: string[] = await invoke("list_downloaded_models");
      setDownloadedModels(models);
    } catch (err: any) {
      setError("Failed to load models. Please restart the app");
    } finally {
      setLoadingModels(false);
    }
  };

  const loadDiarModels = async () => {
    try {
      const models: string[] = await invoke("list_downloaded_diar_models");
      setDownloadedDiarModels(models);
    } catch (err: any) {
      console.error("Failed to load diar models", err);
    }
  };

  const downloadModel = async (model: ModelType) => {
    if (downloadedModels.includes(model)) return;

    setModelStatus((prev) => ({ ...prev, [model]: { loading: true } }));
    setDownloadProgress((prev) => ({ ...prev, [model]: 0 })); // reset progress

    try {
      await invoke("ensure_whisper_model", { modelName: model });

      // On success, set to 100% and success state
      setDownloadProgress((prev) => ({ ...prev, [model]: 100 }));
      setModelStatus((prev) => ({ ...prev, [model]: { loading: false, success: true } }));
      await loadModels();
    } catch (err: any) {
      setDownloadProgress((prev) => ({ ...prev, [model]: 0 }));
      setModelStatus((prev) => ({
        ...prev,
        [model]: { loading: false, error: err?.message || "Download failed" },
      }));
    }
  };

  const requestDeleteModel = (model: string) => setModelToDelete(model);

  const downloadDiarModel = async (model: DiarModelType) => {
    if (downloadedDiarModels.includes(model)) return;

    setDiarModelStatus((prev) => ({ ...prev, [model]: { loading: true } }));
    setDiarDownloadProgress((prev) => ({ ...prev, [model]: 0 }));

    try {
      await invoke("ensure_diarization_model", { modelName: model });

      setDiarDownloadProgress((prev) => ({ ...prev, [model]: 100 }));
      setDiarModelStatus((prev) => ({ ...prev, [model]: { loading: false, success: true } }));
      await loadDiarModels();
      toast.success(`Downloaded diarization model: ${model}`);
    } catch (err: any) {
      setDiarDownloadProgress((prev) => ({ ...prev, [model]: 0 }));
      setDiarModelStatus((prev) => ({
        ...prev,
        [model]: { loading: false, error: err?.message || "Download failed" },
      }));
      toast.error(`Failed to download ${model}`);
    }
  };

  const confirmDeleteModel = async () => {
    if (!modelToDelete) return;

    try {
      // Call the Rust command
      await invoke("delete_whisper_model", { modelName: modelToDelete });

      // Optional: show success toast/notification
      toast.success(`Deleted ${modelToDelete}`);

      setModelToDelete(null);

      // Refresh the list
      await loadModels();
    } catch (err: any) {
      console.error("Delete failed:", err);
      // Show error to user
      toast.error(`Failed to delete ${modelToDelete}: ${err}`);
      // alert(`Failed to delete model: ${err}`); // simple fallback
    }
  };


  const requestDeleteDiarModel = (model: string) => setDiarModelToDelete(model);

  const confirmDeleteDiarModel = async () => {
    if (!diarModelToDelete) return;

    try {
      await invoke("delete_diarization_model", { modelName: diarModelToDelete });
      toast.success(`Deleted ${diarModelToDelete}`);
      setDiarModelToDelete(null);
      await loadDiarModels();
    } catch (err: any) {
      toast.error(`Failed to delete ${diarModelToDelete}: ${err?.message || err}`);
    }
  };



  if (!mounted) return null;
  return (
    <div className={`min-h-screen p-8 lg:p-12 transition-colors duration-300
  ${isDark
        ? "bg-zinc-950 text-white"
        : "bg-gray-50 text-gray-900"}`}>

      {/* Header */}
      <header className="mb-12">
        <h1 className={`text-5xl font-black tracking-tight mb-4 ${isDark ? "text-white" : "text-gray-900"}`}>
          {t("Settings")}
        </h1>
        <p className={`text-xl font-medium ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
          {t("Customize your studio environment and manage local AI models")}
        </p>
      </header>

      <main className="max-w-4xl space-y-16">
        {/* Appearance Section */}
        <section className="space-y-8">
          <div>
            <h2 className={`text-3xl font-black mb-4 flex items-center gap-3 ${isDark ? "text-white" : "text-gray-900"}`}>
              <Sun className="w-7 h-7 text-pink-500" />
              {t("Appearance")}
            </h2>
            <p className={`text-sm font-black uppercase tracking-widest ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
              {t("CHOOSE YOUR STUDIO VIBE")}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {[
              { id: "light", label: "Light", icon: Sun },
              { id: "dark", label: "Dark", icon: Moon },
              { id: "system", label: "System", icon: Monitor },
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTheme(id)}
                className={`p-6 rounded-3xl border transition-all flex flex-col items-center gap-4 shadow-md
              ${theme === id
                    ? "border-pink-500 bg-gradient-to-br from-pink-50 to-white dark:from-pink-950/40 dark:to-zinc-900 shadow-pink-500/30 dark:shadow-pink-500/20"
                    : isDark
                      ? "border-zinc-700 bg-zinc-900/60 hover:bg-zinc-800/80"
                      : "border-gray-300 bg-white hover:bg-gray-50"}`}
              >
                <Icon className={`w-10 h-10 ${theme === id ? "text-pink-500" : isDark ? "text-zinc-400" : "text-gray-700"}`} />
                <span className={`font-bold text-lg ${theme === id ? "text-pink-600 dark:text-pink-400" : isDark ? "text-white" : "text-gray-900"}`}>
                  {label}
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* Language Section - Beautiful Vertical Scroll List */}
        <section className="space-y-6">
          <div>
            <h2 className={`text-3xl font-black flex items-center gap-3 ${isDark ? "text-white" : "text-gray-900"}`}>
              <Globe className="w-7 h-7 text-cyan-500" />
              {t("Language")}
            </h2>
            <p className={`text-sm font-black uppercase tracking-widest mt-2 ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
              {t("INTERFACE_LANGUAGE")}
            </p>
          </div>

          <div className={`rounded-3xl border overflow-hidden ${isDark ? "border-zinc-800 bg-zinc-900/50" : "border-gray-200 bg-white/50"}`}>
            <div className="max-h-96 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-cyan-500/50 hover:scrollbar-thumb-cyan-500">
              <div className="space-y-2 p-3">
                {LANGUAGES.map(({ code, name, greeting }, index) => {
                  const isSelected = locale === code;
                  return (
                    <motion.button
                      key={code}
                      onClick={() => setLocale(code as any)}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.03 }}
                      whileHover={{ scale: 1.02, x: 8 }}
                      whileTap={{ scale: 0.98 }}
                      className={`w-full relative group rounded-2xl px-5 py-4 transition-all duration-200 flex items-center justify-between overflow-hidden
                        ${isSelected
                          ? `${isDark
                            ? "bg-gradient-to-r from-cyan-500/30 to-cyan-500/10 border border-cyan-500/50 shadow-lg shadow-cyan-500/20"
                            : "bg-gradient-to-r from-cyan-100/50 to-cyan-50/30 border border-cyan-400/50 shadow-md shadow-cyan-300/20"
                          }`
                          : `${isDark
                            ? "bg-zinc-800/30 border border-zinc-700/50 hover:bg-zinc-700/40 hover:border-zinc-600/50"
                            : "bg-gray-100/30 border border-gray-300/50 hover:bg-gray-100/50 hover:border-gray-400/50"
                          }`
                        }`}
                    >
                      {/* Animated background gradient on hover */}
                      <div className={`absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity ${isDark ? "bg-gradient-to-r from-cyan-500 to-transparent" : "bg-gradient-to-r from-cyan-400 to-transparent"}`} />

                      <div className="relative flex-1 text-left">
                        <div className="flex items-center gap-3">
                          <div className={`text-xl font-black ${isSelected ? "text-cyan-400" : isDark ? "text-zinc-400" : "text-gray-500"}`}>
                            {greeting}
                          </div>
                          <div>
                            <p className={`font-bold text-sm ${isSelected ? isDark ? "text-cyan-300" : "text-cyan-600" : isDark ? "text-white" : "text-gray-900"}`}>
                              {name}
                            </p>
                            <p className={`text-xs ${isSelected ? isDark ? "text-cyan-400/70" : "text-cyan-500/70" : isDark ? "text-zinc-500" : "text-gray-600"}`}>
                              {code.toUpperCase()}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Animated checkmark */}
                      {isSelected && (
                        <motion.div
                          layoutId="langCheck"
                          initial={{ scale: 0, rotate: -180 }}
                          animate={{ scale: 1, rotate: 0 }}
                          exit={{ scale: 0, rotate: 180 }}
                          transition={{ type: "spring", stiffness: 500, damping: 30 }}
                          className={`relative w-6 h-6 rounded-full flex items-center justify-center font-bold text-white ${isDark ? "bg-cyan-500" : "bg-cyan-500"}`}
                        >
                          ✓
                        </motion.div>
                      )}

                      {/* Hover accent line */}
                      <motion.div
                        initial={{ scaleX: 0 }}
                        whileHover={{ scaleX: 1 }}
                        transition={{ duration: 0.2 }}
                        className={`absolute bottom-0 left-0 right-0 h-1 origin-left ${isSelected ? (isDark ? "bg-cyan-500" : "bg-cyan-400") : (isDark ? "bg-zinc-600" : "bg-gray-400")}`}
                      />
                    </motion.button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Language info card */}
          <motion.div
            key={locale}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className={`p-4 rounded-2xl backdrop-blur-sm text-center border ${isDark
              ? "bg-cyan-500/10 border-cyan-500/30"
              : "bg-cyan-100/30 border-cyan-400/30"
              }`}
          >
            <p className={`font-semibold ${isDark ? "text-cyan-300" : "text-cyan-700"}`}>
              {LANGUAGES.find(l => l.code === locale)?.name} • {LANGUAGES.find(l => l.code === locale)?.greeting}
            </p>
          </motion.div>
        </section>

        {/* Whisper Models - full card liquid fill */}
        <section className="space-y-8">
          <div className="flex items-center justify-between">
            <div>
              <h2 className={`text-3xl font-black flex items-center gap-3 ${isDark ? "text-white" : "text-gray-900"}`}>
                <Database className="w-7 h-7 text-pink-500" />
                Whisper Models
              </h2>
              <p className={`text-sm font-black uppercase tracking-widest mt-1 ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
                {t("MANAGE LOCAL AI MODELS")}
              </p>
            </div>
            <button
              onClick={loadModels}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition
                ${isDark ? "bg-zinc-800 hover:bg-zinc-700 text-white" : "bg-white hover:bg-gray-50 shadow-sm border border-gray-200"}`}
            >
              <RefreshCw className="w-4 h-4" />
              {t("Refresh List")}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {WHISPER_MODELS.map((model) => {
              const isDownloaded = downloadedModels.includes(model);
              const status = modelStatus[model] || { loading: false };
              const progress = downloadProgress[model] ?? 0;
              const isDownloading = status.loading && progress < 100;

              return (
                <div
                  key={model}
                  className={`relative rounded-3xl overflow-hidden border transition-all duration-300
                    ${isDark
                      ? "bg-zinc-900/70 border-zinc-800 hover:border-zinc-600"
                      : "bg-white border-gray-200 shadow-md hover:shadow-xl hover:border-gray-300"}`}
                >
                  {/* Real progress gradient fill */}
                  <motion.div
                    className="absolute inset-0 bg-gradient-to-t from-pink-600/90 via-pink-500/70 to-transparent z-0"
                    initial={{ y: "100%" }}
                    animate={{ y: `${100 - progress}%` }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                  />

                  <div className="relative z-10 p-6 pb-4">
                    <h3 className={`font-bold text-lg mb-1 ${isDark ? "text-white" : "text-gray-900"}`}>
                      {model}
                    </h3>
                    <p className={`text-sm ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                      {model.includes(".en") ? "English only" : "Multilingual"}
                    </p>
                  </div>

                  <div className="relative z-10 h-20 flex items-center justify-center">
                    {isDownloading ? (
                      <div className="text-center">
                        <span className="text-3xl font-black text-white drop-shadow-lg">
                          {Math.round(progress)}%
                        </span>
                      </div>
                    ) : isDownloaded ? (
                      <CheckCircle className="w-12 h-12 text-green-400 drop-shadow-md" />
                    ) : (
                      <Download className={`w-12 h-12 ${isDark ? "text-zinc-500" : "text-gray-400"}`} />
                    )}
                  </div>

                  <div className="relative z-10 p-5 pt-3 flex gap-3">
                    {isDownloaded ? (
                      <button
                        onClick={() => requestDeleteModel(model)}
                        className="flex-1 py-3.5 bg-red-600/90 hover:bg-red-700 text-white rounded-xl font-medium transition flex items-center justify-center gap-2"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete
                      </button>
                    ) : (
                      <button
                        onClick={() => downloadModel(model)}
                        disabled={isDownloading}
                        className={`flex-1 py-3.5 rounded-xl font-medium transition flex items-center justify-center gap-2
                        ${isDownloading
                            ? "bg-zinc-700/80 text-white cursor-wait"
                            : "bg-gradient-to-r from-pink-600 to-pink-700 hover:from-pink-700 hover:to-pink-800 text-white"}`}
                      >
                        {isDownloading ? (
                          <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            {t("Downloading")}
                          </>
                        ) : (
                          <>
                            <Download className="w-4 h-4" />
                            {t("Download")}
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {status.error && (
                    <p className="relative z-10 px-5 pb-4 text-sm text-red-400">{status.error}</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Parakeet-TDT Model Section */}
        <section className="space-y-8">
          <div className="flex items-center justify-between">
            <div>
              <h2 className={`text-3xl font-black flex items-center gap-3 ${isDark ? "text-white" : "text-gray-900"}`}>
                <Users className="w-7 h-7 text-cyan-500" />
                Parakeet-TDT Model
              </h2>
              <p className={`text-sm font-black uppercase tracking-widest mt-1 ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
                Manage automatic ASR model for dubbing pipeline
              </p>
            </div>

            <button
              onClick={loadTdtModelStatus}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition ${isDark
                ? "bg-zinc-800 hover:bg-zinc-700 text-white"
                : "bg-white hover:bg-gray-50 shadow-sm border border-gray-200"
                }`}
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <div
              className={`relative rounded-3xl overflow-hidden border transition-all duration-300 shadow-md hover:shadow-lg ${isDark
                ? "bg-zinc-900/70 border-zinc-800 hover:border-zinc-600"
                : "bg-white border-gray-200 hover:border-gray-300"
                }`}
            >
              <motion.div
                className="absolute inset-0 bg-gradient-to-t from-cyan-600/85 via-cyan-500/70 to-transparent z-0"
                initial={{ y: "100%" }}
                animate={{ y: `${100 - tdtProgress}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
              />

              <div className="relative z-10 p-6">
                <h3 className={`font-bold text-lg mb-1 ${isDark ? "text-white" : "text-gray-900"}`}>
                  nvidia/parakeet-tdt-0.6b-v2
                </h3>
                <p className={`text-sm ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                  Required for transcription + diarization in dubbing pipeline
                </p>
              </div>

              <div className="relative z-10 h-24 flex items-center justify-center">
                {tdtBusy ? (
                  <div className="text-center">
                    <span className="text-4xl font-black text-white drop-shadow-lg">
                      {Math.round(tdtProgress)}%
                    </span>
                  </div>
                ) : tdtStatus?.is_ready ? (
                  <CheckCircle className="w-14 h-14 text-green-400 drop-shadow-md" />
                ) : (
                  <Download className={`w-14 h-14 ${isDark ? "text-zinc-500" : "text-gray-400"}`} />
                )}
              </div>

              <div className="relative z-10 px-6 pb-6 space-y-3">
                {tdtCurrentFile && tdtBusy && (
                  <p className="text-xs text-white/90 truncate">{tdtCurrentFile}</p>
                )}

                <div className="text-xs text-zinc-300">
                  {(tdtStatus?.downloaded_files ?? 0)}/{tdtStatus?.total_files ?? 0} files
                </div>

                <div className="grid grid-cols-1 gap-2">
                  <button
                    onClick={ensureTdtModel}
                    disabled={tdtBusy}
                    className={`w-full py-3 rounded-xl font-medium transition flex items-center justify-center gap-2 ${tdtBusy
                      ? "bg-zinc-700/80 text-white cursor-wait"
                      : "bg-cyan-600 hover:bg-cyan-700 text-white"
                      }`}
                  >
                    {tdtBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                    Ensure Model
                  </button>

                  {!tdtStatus?.is_ready && (
                    <button
                      onClick={downloadTdtModel}
                      disabled={tdtBusy}
                      className={`w-full py-3 rounded-xl font-medium transition flex items-center justify-center gap-2 ${tdtBusy
                        ? "bg-zinc-700/80 text-white cursor-wait"
                        : "bg-gradient-to-r from-cyan-600 to-cyan-700 hover:from-cyan-700 hover:to-cyan-800 text-white"
                        }`}
                    >
                      <Download className="w-4 h-4" />
                      Download
                    </button>
                  )}

                  {tdtStatus?.is_ready && (
                    <button
                      onClick={deleteTdtModel}
                      disabled={tdtBusy}
                      className="w-full py-3 bg-red-600/90 hover:bg-red-700 text-white rounded-xl font-medium transition flex items-center justify-center gap-2"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* NLLB Translation Models Section */}
        <section className="space-y-8">
          <div className="flex items-center justify-between">
            <div>
              <h2 className={`text-3xl font-black flex items-center gap-3 ${isDark ? "text-white" : "text-gray-900"}`}>
                <AudioLines className="w-7 h-7 text-emerald-500" />
                Qwen3-TTS Model
              </h2>
              <p className={`text-sm font-black uppercase tracking-widest mt-1 ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
                Download and manage local TTS foundation model
              </p>
            </div>

            <button
              onClick={loadQwenModelStatus}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition ${isDark
                ? "bg-zinc-800 hover:bg-zinc-700 text-white"
                : "bg-white hover:bg-gray-50 shadow-sm border border-gray-200"
                }`}
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <div
              className={`relative rounded-3xl overflow-hidden border transition-all duration-300 shadow-md hover:shadow-lg ${isDark
                ? "bg-zinc-900/70 border-zinc-800 hover:border-zinc-600"
                : "bg-white border-gray-200 hover:border-gray-300"
                }`}
            >
              <motion.div
                className="absolute inset-0 bg-gradient-to-t from-emerald-600/85 via-emerald-500/70 to-transparent z-0"
                initial={{ y: "100%" }}
                animate={{ y: `${100 - qwenProgress}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
              />

              <div className="relative z-10 p-6">
                <h3 className={`font-bold text-lg mb-1 ${isDark ? "text-white" : "text-gray-900"}`}>
                  Qwen3-TTS-12Hz-0.6B-Base
                </h3>
                <p className={`text-sm ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                  Hugging Face: Qwen/Qwen3-TTS-12Hz-0.6B-Base
                </p>
              </div>

              <div className="relative z-10 h-24 flex items-center justify-center">
                {qwenBusy ? (
                  <div className="text-center">
                    <span className="text-4xl font-black text-white drop-shadow-lg">
                      {Math.round(qwenProgress)}%
                    </span>
                  </div>
                ) : qwenStatus?.is_ready ? (
                  <CheckCircle className="w-14 h-14 text-green-400 drop-shadow-md" />
                ) : (
                  <Download className={`w-14 h-14 ${isDark ? "text-zinc-500" : "text-gray-400"}`} />
                )}
              </div>

              <div className="relative z-10 px-6 pb-6 space-y-3">
                {qwenCurrentFile && qwenBusy && (
                  <p className="text-xs text-white/90 truncate">{qwenCurrentFile}</p>
                )}

                <div className="text-xs text-zinc-300">
                  {(qwenStatus?.downloaded_files ?? 0)}/{qwenStatus?.total_files ?? 0} files
                </div>

                {!qwenStatus?.is_ready ? (
                  <button
                    onClick={downloadQwenModel}
                    disabled={qwenBusy}
                    className={`w-full py-3.5 rounded-xl font-medium transition flex items-center justify-center gap-2 ${qwenBusy
                      ? "bg-zinc-700/80 text-white cursor-wait"
                      : "bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-700 hover:to-emerald-800 text-white"
                      }`}
                  >
                    {qwenBusy ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Downloading
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        Download
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    onClick={deleteQwenModel}
                    disabled={qwenBusy}
                    className="w-full py-3.5 bg-red-600/90 hover:bg-red-700 text-white rounded-xl font-medium transition flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                )}
              </div>
            </div>

            {/* <div className={`rounded-3xl border p-6 ${isDark ? "border-zinc-800 bg-zinc-900/60" : "border-gray-200 bg-white"}`}>
              <p className={`text-xs font-black uppercase tracking-widest mb-2 ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
                Local Paths
              </p>
              <p className="text-sm font-semibold mb-2 break-all">Model: {qwenStatus?.model_dir || "..."}</p>
              <p className="text-sm font-semibold break-all">Prompts: {qwenStatus?.prompt_dir || "..."}</p>
              <p className={`text-xs mt-3 ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                Saved prompts are reusable voices stored in tts_voice_prompts.
              </p>
            </div> */}

            {/* <div className={`rounded-3xl border p-6 ${isDark ? "border-zinc-800 bg-zinc-900/60" : "border-gray-200 bg-white"}`}>
              <p className={`text-xs font-black uppercase tracking-widest mb-3 ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
                Supported Languages
              </p>
              <div className="flex flex-wrap gap-2">
                {(qwenStatus?.supported_languages || []).map((lang) => (
                  <span key={lang} className="px-2.5 py-1 rounded-full text-xs font-medium border border-emerald-400/40">
                    {lang}
                  </span>
                ))}
              </div>
            </div> */}
          </div>
        </section>

        {/* NLLB Translation Models Section */}
        <section className="space-y-8 mb-16">
          <div className="flex items-center justify-between">
            <div>
              <h2 className={`text-3xl font-black flex items-center gap-3 ${isDark ? "text-white" : "text-gray-900"}`}>
                <Languages className="w-7 h-7 text-purple-500" />
                Translation Models (NLLB-200)
              </h2>
              <p className={`text-sm font-black uppercase tracking-widest mt-1 ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
                Manage Local Translation Models
              </p>
            </div>

            <button
              onClick={loadNllbModels}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition ${isDark
                ? "bg-zinc-800 hover:bg-zinc-700 text-white"
                : "bg-white hover:bg-gray-50 shadow-sm border border-gray-200"
                }`}
              title="Refresh List"
            >
              <RefreshCw className="w-4 h-4" />
              {t("Refresh List")}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {NLLB_VARIANTS.map((variant) => {
              const isDownloaded = nllbModels.some((m) => m.folder_name === variant.id && m.exists);
              const isActive = activeNllbModel === variant.id;
              const status = nllbDownloadStatus[variant.id] || { loading: false, progress: 0 };
              const isDownloading = status.loading && status.progress < 100;

              return (
                <div
                  key={variant.id}
                  className={`relative rounded-3xl overflow-hidden border transition-all duration-300 shadow-md hover:shadow-lg ${isDark
                    ? "bg-zinc-900/70 border-zinc-800 hover:border-zinc-600"
                    : "bg-white border-gray-200 hover:border-gray-300"
                    }`}
                >
                  {/* Solid color progress overlay (same as diarization) */}
                  <motion.div
                    className={`absolute inset-0 ${isDark ? "bg-purple-700/80" : "bg-purple-600/80"} z-0`}
                    initial={{ y: "100%" }}
                    animate={{ y: `${100 - status.progress}%` }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                  />

                  <div className="relative z-10 p-6">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className={`font-bold text-lg mb-1 ${isDark ? "text-white" : "text-gray-900"}`}>
                          {variant.name}
                        </h3>
                        <p className={`text-sm ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                          {variant.size}
                        </p>
                        <p className={`text-xs mt-1 ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
                          {variant.description}
                        </p>
                      </div>

                      {isActive && !isDownloading && (
                        <CheckCircle className="w-6 h-6 text-green-500 flex-shrink-0" />
                      )}
                    </div>
                  </div>

                  {/* Center progress / icon */}
                  <div className="relative z-10 h-24 flex items-center justify-center">
                    {isDownloading ? (
                      <div className="text-center">
                        <span className="text-4xl font-black text-white drop-shadow-lg">
                          {Math.round(status.progress)}%
                        </span>
                      </div>
                    ) : isDownloaded ? (
                      isActive ? (
                        <CheckCircle className="w-14 h-14 text-green-400 drop-shadow-md" />
                      ) : (
                        <div className="text-center">
                          <span className={`text-2xl font-bold ${isDark ? "text-zinc-400" : "text-gray-500"}`}>
                            Ready
                          </span>
                        </div>
                      )
                    ) : (
                      <Download className={`w-14 h-14 ${isDark ? "text-zinc-500" : "text-gray-400"}`} />
                    )}
                  </div>

                  {/* Action area */}
                  <div className="relative z-10 px-6 pb-6 space-y-3">
                    {isDownloading ? (
                      <div className="w-full bg-zinc-800/70 rounded-full h-2.5 overflow-hidden">
                        <div
                          className="bg-purple-600 h-2.5 rounded-full transition-all duration-300"
                          style={{ width: `${status.progress}%` }}
                        />
                      </div>
                    ) : isDownloaded ? (
                      <div className="flex gap-3">
                        <button
                          onClick={() => handleSetActiveNllb(variant.id)}
                          disabled={isActive}
                          className={`flex-1 py-3.5 rounded-xl font-medium transition ${isActive
                            ? "bg-green-700/50 text-green-200 cursor-default"
                            : "bg-green-600 hover:bg-green-500 text-white"
                            }`}
                        >
                          {isActive ? "Active" : "Activate"}
                        </button>

                        <button
                          onClick={() => setNllbModelToDelete(variant.id)}
                          className="p-3.5 bg-red-900/60 hover:bg-red-800/70 rounded-xl text-red-200"
                        >
                          <Trash2 size={20} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleDownloadNllb(variant.id)}
                        disabled={isDownloading}
                        className={`w-full py-3.5 rounded-xl font-medium transition flex items-center justify-center gap-2 ${isDark
                          ? "bg-purple-700 hover:bg-purple-600 text-white"
                          : "bg-purple-600 hover:bg-purple-500 text-white"
                          }`}
                      >
                        <Download className="w-5 h-5" />
                        Download
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Diarization Models */}
        <section className="space-y-8">
          <div className="flex items-center justify-between">
            <div>
              <h2 className={`text-3xl font-black flex items-center gap-3 ${isDark ? "text-white" : "text-gray-900"}`}>
                <Users className="w-7 h-7 text-purple-500" />
                Diarization Models
              </h2>
              <p className={`text-sm font-black uppercase tracking-widest mt-1 ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
                {t("Manage Speaker Diarization Models")}(Parakeet / Sortformer)
              </p>
            </div>

            <button
              onClick={loadDiarModels}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium transition ${isDark ? "bg-zinc-800 hover:bg-zinc-700 text-white" : "bg-white hover:bg-gray-50 shadow-sm border border-gray-200"
                }`}
            >
              <RefreshCw className="w-4 h-4" />
              {t("Refresh List")}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {DIARIZATION_MODELS.map((model) => {
              const isDownloaded = downloadedDiarModels.includes(model);
              const status = diarModelStatus[model] || { loading: false };
              const progress = diarDownloadProgress[model] ?? 0;
              const isDownloading = status.loading && progress < 100;

              const displayName = getDiarModelDisplayName(model);
              const subtitle = getDiarModelSubtitle(model);

              return (
                <div
                  key={model}
                  className={`relative rounded-3xl overflow-hidden border transition-all duration-300 shadow-md hover:shadow-lg ${isDark
                    ? "bg-zinc-900/70 border-zinc-800 hover:border-zinc-600"
                    : "bg-white border-gray-200 hover:border-gray-300"
                    }`}
                >
                  {/* Progress gradient overlay */}
                  <motion.div
                    className="absolute inset-0 bg-gradient-to-t from-purple-600/80 via-purple-500/60 to-transparent z-0"
                    initial={{ y: "100%" }}
                    animate={{ y: `${100 - progress}%` }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                  />

                  <div className="relative z-10 p-6">
                    <h3 className={`font-bold text-lg mb-1 ${isDark ? "text-white" : "text-gray-900"}`}>
                      {displayName}
                    </h3>
                    <p className={`text-sm ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                      {subtitle}
                    </p>
                  </div>

                  {/* Center icon / progress */}
                  <div className="relative z-10 h-24 flex items-center justify-center">
                    {isDownloading ? (
                      <div className="text-center">
                        <span className="text-4xl font-black text-white drop-shadow-lg">
                          {Math.round(progress)}%
                        </span>
                      </div>
                    ) : isDownloaded ? (
                      <CheckCircle className="w-14 h-14 text-green-400 drop-shadow-md" />
                    ) : (
                      <Download className={`w-14 h-14 ${isDark ? "text-zinc-500" : "text-gray-400"}`} />
                    )}
                  </div>

                  {/* Action button */}
                  <div className="relative z-10 px-6 pb-6">
                    {isDownloaded ? (
                      <button
                        onClick={() => setDiarModelToDelete(model)}
                        className="w-full py-3.5 bg-red-600/90 hover:bg-red-700 text-white rounded-xl font-medium transition flex items-center justify-center gap-2"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete
                      </button>
                    ) : (
                      <button
                        onClick={() => downloadDiarModel(model)}
                        disabled={isDownloading}
                        className={`w-full py-3.5 rounded-xl font-medium transition flex items-center justify-center gap-2 ${isDownloading
                          ? "bg-zinc-700/80 text-white cursor-wait"
                          : "bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white"
                          }`}
                      >
                        {isDownloading ? (
                          <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            {t("Downloading")}
                          </>
                        ) : (
                          <>
                            <Download className="w-4 h-4" />
                            {t("Download")}
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {status.error && (
                    <p className="relative z-10 px-6 pb-4 text-sm text-red-400">{status.error}</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Security Vault - unchanged dimensions & spacing */}
        <section className="space-y-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-white/10 backdrop-blur-md rounded-2xl flex items-center justify-center">
              <Shield className="w-6 h-6 text-pink-400" />
            </div>
            <h2 className="text-3xl font-black">{t("Security Vault")}</h2>
          </div>
          <p className="text-lg font-medium text-zinc-300 leading-relaxed mb-8">
            {t("SpeakShift is secure")}
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="p-6 rounded-3xl bg-white/5 border border-white/10">
              <p className="text-xs font-black text-pink-400 uppercase tracking-widest mb-1">
                {t("Network Status")}
              </p>
              <p className="font-bold">{t("100% Offline Capable")}</p>
            </div>
            <div className="p-6 rounded-3xl bg-white/5 border border-white/10">
              <p className="text-xs font-black text-pink-400 uppercase tracking-widest mb-1">
                {t("Encryption")}
              </p>
              <p className="font-bold">{t("End-to-End Local")}</p>
            </div>
          </div>
        </section>
      </main>

      {/* Delete Confirmation Modal */}
      {modelToDelete && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 border border-zinc-700 rounded-3xl p-8 max-w-md w-full mx-4"
          >
            <div className="flex items-center gap-4 mb-6">
              <AlertTriangle className="w-10 h-10 text-red-500" />
              <h3 className="text-2xl font-black">{t("Delete Model?")}</h3>
            </div>

            <p className="text-zinc-300 mb-8">
              {t("Are you sure you want to delete")} <strong>{modelToDelete}</strong>?<br />
              {t("This action cannot be undone")}
            </p>

            <div className="flex gap-4">
              <button
                onClick={() => setModelToDelete(null)}
                className="flex-1 py-4 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold transition"
              >
                {t("Cancel")}
              </button>
              <button
                onClick={confirmDeleteModel}
                className="flex-1 py-4 bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold transition flex items-center justify-center gap-2"
              >
                {modelStatus[modelToDelete]?.loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : null}
                {t("Yes, Delete")}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Diarization Delete Confirmation Modal */}
      {diarModelToDelete && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 border border-zinc-700 rounded-3xl p-8 max-w-md w-full mx-4"
          >
            <div className="flex items-center gap-4 mb-6">
              <AlertTriangle className="w-10 h-10 text-red-500" />
              <h3 className="text-2xl font-black">{t("Delete Diarization Model?")}</h3>
            </div>

            <p className="text-zinc-300 mb-8">
              {t("Are you sure you want to delete")} <strong>{diarModelToDelete}</strong>?<br />
              {t("This action cannot be undone")}
            </p>

            <div className="flex gap-4">
              <button
                onClick={() => setDiarModelToDelete(null)}
                className="flex-1 py-4 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold transition"
              >
                {t("Cancel")}
              </button>
              <button
                onClick={confirmDeleteDiarModel}
                className="flex-1 py-4 bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold transition flex items-center justify-center gap-2"
              >
                {diarModelStatus[diarModelToDelete]?.loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : null}
                {t("Yes, Delete")}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* NLLB Delete Confirmation Modal */}
      {nllbModelToDelete && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className="bg-zinc-900 border border-zinc-700 rounded-3xl p-8 max-w-md w-full mx-6 shadow-2xl"
          >
            <div className="flex items-center gap-4 mb-6">
              <AlertTriangle className="w-10 h-10 text-red-500" />
              <h3 className="text-2xl font-bold text-white">
                Delete Translation Model?
              </h3>
            </div>

            <p className="text-zinc-300 mb-8 leading-relaxed">
              Are you sure you want to delete{" "}
              <strong className="text-white">
                {NLLB_VARIANTS.find((v) => v.id === nllbModelToDelete)?.name}
              </strong>
              ?
              <br />
              <span className="text-red-400 font-medium">
                This action cannot be undone.
              </span>
            </p>

            <div className="flex gap-4">
              <button
                onClick={() => setNllbModelToDelete(null)}
                className="flex-1 py-4 bg-zinc-800 hover:bg-zinc-700 rounded-2xl font-bold transition text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteNllb}
                className="flex-1 py-4 bg-red-600 hover:bg-red-700 rounded-2xl font-bold transition text-white flex items-center justify-center gap-2 shadow-lg shadow-red-600/30"
              >
                {modelStatus[nllbModelToDelete]?.loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : null}
                Yes, Delete
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Custom Scrollbar Styles */}
      <style>{`
        .scrollbar-thin::-webkit-scrollbar {
          width: 6px;
        }
        .scrollbar-thin::-webkit-scrollbar-track {
          background: transparent;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb {
          background: rgb(34, 197, 94, 0.3);
          border-radius: 3px;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb:hover {
          background: rgb(34, 197, 94, 0.6);
        }
      `}</style>
    </div>
  );
}