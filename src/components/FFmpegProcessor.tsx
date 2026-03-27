"use client";

import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  Scissors,
  Download,
  Loader2,
  X,
  Video,
  Play,
  AlertTriangle,
  Music,
  Sun,
  Contrast,
  Droplet,
  Volume2,
  Wind,
  Maximize2,
  Smartphone,
  Monitor,
  CheckCircle2,
  Settings2,
  Type,
  Layers,
  Wand2,
  Trash2,
  Crop as CropIcon,
  Scaling,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useTranslations } from "next-intl";

type OverlayKind = "text" | "emoji";

interface CreativeOverlay {
  id: string;
  kind: OverlayKind;
  text: string;
  xPct: number;
  yPct: number;
  sizeRel: number;
  color: string;
}

const EMOJI_PRESETS = ["✨", "🔥", "🎬", "💯", "🎉", "🚀", "😍", "😎"];

interface Props {
  file: File;
  onCancel: () => void;
}

interface PreviewParamsPayload {
  brightness: number;
  contrast: number;
  saturation: number;
  color_filter: "none" | "grayscale" | "sepia" | "vignette";
}

function normalizeInvokeBytes(input: number[] | Uint8Array | ArrayBuffer): Uint8Array {
  if (Array.isArray(input)) {
    return new Uint8Array(input);
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  return input;
}

function getOutputMimeType(outputType: "video" | "audio", format: string): string {
  if (outputType === "audio") {
    if (format === "mp3") {
      return "audio/mpeg";
    }
    if (format === "wav") {
      return "audio/wav";
    }
    if (format === "m4a") {
      return "audio/mp4";
    }
    return "audio/ogg";
  }

  if (format === "mov") {
    return "video/quicktime";
  }
  if (format === "webm") {
    return "video/webm";
  }
  if (format === "mkv") {
    return "video/x-matroska";
  }

  return "video/mp4";
}

function describeMediaErrorCode(code?: number | null): string {
  if (!code) {
    return "Unknown";
  }

  switch (code) {
    case 1:
      return "MEDIA_ERR_ABORTED";
    case 2:
      return "MEDIA_ERR_NETWORK";
    case 3:
      return "MEDIA_ERR_DECODE";
    case 4:
      return "MEDIA_ERR_SRC_NOT_SUPPORTED";
    default:
      return "Unknown";
  }
}

export default function FFmpegProcessor({ file, onCancel }: Props) {
  const t = useTranslations();

  // ── State ──
  const [cachedInputBytes, setCachedInputBytes] = useState<number[] | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Ready to process");
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("video");

  const [outputType, setOutputType] = useState<"video" | "audio">("video");
  const [format, setFormat] = useState<string>("mp4");
  const [quality, setQuality] = useState<"high" | "medium" | "low">("medium");
  const [resolution, setResolution] = useState<"original" | "1080p" | "720p" | "480p">("original");
  const [aspectRatio, setAspectRatio] = useState<"original" | "9:16" | "1:1" | "16:9">("original");

  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(1);
  const [saturation, setSaturation] = useState(1);
  const [filter, setFilter] = useState<"none" | "grayscale" | "sepia" | "vignette">("none");

  const [volume, setVolume] = useState(1);
  const [denoise, setDenoise] = useState(false);
  const [dehummer, setDehummer] = useState(false);

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [videoDimensions, setVideoDimensions] = useState({ width: 0, height: 0 });
  const [orientation, setOrientation] = useState<"horizontal" | "vertical">("horizontal");
  const [isVideoLoading, setIsVideoLoading] = useState(true);

  const [outputPath, setOutputPath] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewCanvasRef = useRef<HTMLDivElement>(null);
  const fallbackPreviewTriedRef = useRef(false);

  const [overlays, setOverlays] = useState<CreativeOverlay[]>([]);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("Your text");
  const [draftEmoji, setDraftEmoji] = useState("✨");

  const interactionRef = useRef<{
    id: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    startXPct: number;
    startYPct: number;
    startSizeRel: number;
    width: number;
    height: number;
  } | null>(null);

  const previewSource = outputUrl ?? previewPath;
  const selectedOverlay = overlays.find((item) => item.id === selectedOverlayId) ?? null;

  const previewCssFilter = useMemo(() => {
    const parts: string[] = [];
    parts.push(`brightness(${Math.max(0.01, 1 + brightness).toFixed(2)})`);
    parts.push(`contrast(${contrast.toFixed(2)})`);
    parts.push(`saturate(${saturation.toFixed(2)})`);

    if (filter === "grayscale") {
      parts.push("grayscale(1)");
    } else if (filter === "sepia") {
      parts.push("sepia(0.9)");
    } else if (filter === "vignette") {
      parts.push("brightness(0.94)");
      parts.push("contrast(1.08)");
    }

    return parts.join(" ");
  }, [brightness, contrast, saturation, filter]);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;

    listen<{ progress?: number }>("ffmpeg-progress", (event) => {
      const next = Math.max(0, Math.min(100, Number(event.payload?.progress ?? 0)));
      setProgress(next);
      setStatus(next >= 100 ? "Finalizing output..." : `Rendering... ${next}%`);
    })
      .then((unlistenFn) => {
        unlistenProgress = unlistenFn;
      })
      .catch((err) => {
        console.error("Failed to subscribe to ffmpeg-progress:", err);
      });

    return () => {
      if (unlistenProgress) {
        unlistenProgress();
      }
    };
  }, []);

  // ── Cache input bytes once (critical for large files) ──
  useEffect(() => {
    if (!file) return;

    (async () => {
      try {
        const ab = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(ab));
        setCachedInputBytes(bytes);
        console.log("Input bytes cached:", bytes.length / 1024 / 1024, "MB");
      } catch (err) {
        console.error("Failed to cache input bytes:", err);
      }
    })();
  }, [file]);

  useEffect(() => {
    const sourceUrl = URL.createObjectURL(file);
    fallbackPreviewTriedRef.current = false;
    setPreviewPath(sourceUrl);
    setOutputUrl(null);
    setIsVideoLoading(true);

    return () => {
      URL.revokeObjectURL(sourceUrl);
    };
  }, [file]);

  // ── Video element setup (unchanged) ──
  useEffect(() => {
    if (videoRef.current && previewPath) {
      videoRef.current.load();
    }
  }, [previewPath]);

  useEffect(() => {
    if (!videoRef.current) return;
    // HTML media element volume is capped to 1.0.
    videoRef.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume, previewSource]);

  useEffect(() => {
    if (!videoRef.current) return;

    setIsVideoLoading(true);

    const handleLoadedMetadata = () => {
      if (videoRef.current) {
        const w = videoRef.current.videoWidth;
        const h = videoRef.current.videoHeight;
        if (w > 0 && h > 0) {
          setVideoDimensions({ width: w, height: h });
          setOrientation(w >= h ? "horizontal" : "vertical");
          console.log(`Video loaded: ${w}x${h}`);
        }
      }
    };

    const handleLoadedData = () => {
      setIsVideoLoading(false);
      console.log("Video data ready");
    };

    const handleError = () => {
      setIsVideoLoading(false);
      console.error("Video error:", videoRef.current?.error);
    };

    const v = videoRef.current;
    v.addEventListener("loadedmetadata", handleLoadedMetadata);
    v.addEventListener("loadeddata", handleLoadedData);
    v.addEventListener("error", handleError);

    return () => {
      v.removeEventListener("loadedmetadata", handleLoadedMetadata);
      v.removeEventListener("loadeddata", handleLoadedData);
      v.removeEventListener("error", handleError);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (outputUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(outputUrl);
      }
    };
  }, [outputUrl]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const active = interactionRef.current;
      if (!active) {
        return;
      }

      const dx = event.clientX - active.startX;
      const dy = event.clientY - active.startY;

      setOverlays((current) =>
        current.map((item) => {
          if (item.id !== active.id) {
            return item;
          }

          if (active.mode === "move") {
            const nextX = Math.max(0.02, Math.min(0.98, active.startXPct + dx / active.width));
            const nextY = Math.max(0.02, Math.min(0.98, active.startYPct + dy / active.height));
            return { ...item, xPct: nextX, yPct: nextY };
          }

          const nextSize = Math.max(0.03, Math.min(0.26, active.startSizeRel + (dx + -dy) / (active.width + active.height)));
          return { ...item, sizeRel: nextSize };
        })
      );
    };

    const onPointerUp = () => {
      interactionRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  const startOverlayInteraction = (
    event: ReactPointerEvent<HTMLDivElement | HTMLButtonElement>,
    id: string,
    mode: "move" | "resize"
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const overlay = overlays.find((item) => item.id === id);
    const rect = previewCanvasRef.current?.getBoundingClientRect();

    if (!overlay || !rect || rect.width < 1 || rect.height < 1) {
      return;
    }

    interactionRef.current = {
      id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startXPct: overlay.xPct,
      startYPct: overlay.yPct,
      startSizeRel: overlay.sizeRel,
      width: rect.width,
      height: rect.height,
    };

    setSelectedOverlayId(id);
  };

  const addOverlay = (kind: OverlayKind) => {
    const rawText = kind === "emoji" ? draftEmoji.trim() : draftText.trim();
    const text = rawText.length > 0 ? rawText : (kind === "emoji" ? "✨" : "Text");

    const overlay: CreativeOverlay = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      text,
      xPct: 0.5,
      yPct: 0.5,
      sizeRel: kind === "emoji" ? 0.12 : 0.08,
      color: "#ffffff",
    };

    setOverlays((current) => [...current, overlay]);
    setSelectedOverlayId(overlay.id);
  };

  const updateOverlay = (id: string, patch: Partial<CreativeOverlay>) => {
    setOverlays((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeOverlay = (id: string) => {
    setOverlays((current) => current.filter((item) => item.id !== id));
    if (selectedOverlayId === id) {
      setSelectedOverlayId(null);
    }
  };

  const createCompatibilityPreview = async () => {
    if (!cachedInputBytes || fallbackPreviewTriedRef.current) {
      return;
    }

    fallbackPreviewTriedRef.current = true;

    try {
      setStatus("Creating compatibility preview...");
      setIsVideoLoading(true);

      const previewParams: PreviewParamsPayload = {
        brightness,
        contrast,
        saturation,
        color_filter: filter,
      };

      const previewBytesRaw = await invoke<number[] | Uint8Array | ArrayBuffer>("create_video_preview", {
        inputBytes: cachedInputBytes,
        params: previewParams,
      });

      const previewBytes = normalizeInvokeBytes(previewBytesRaw);
      const fallbackBlobUrl = URL.createObjectURL(new Blob([previewBytes], { type: "video/mp4" }));

      setPreviewPath((prev) => {
        if (prev?.startsWith("blob:")) {
          URL.revokeObjectURL(prev);
        }
        return fallbackBlobUrl;
      });

      setError(null);
      setStatus("Using compatibility preview");
    } catch (previewErr) {
      console.error("Compatibility preview generation failed:", previewErr);
      setStatus("Preview failed");
    } finally {
      setIsVideoLoading(false);
    }
  };
  
  const processMedia = async () => {
    // Validate file type
    if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
      setError("Invalid file type. Please select a video or audio file.");
      return;
    }

    setIsProcessing(true);
    setProgress(0);
    setStatus("Starting render pipeline...");
    setError(null);
    const toastId = toast.loading("Processing your media...");

    try {
      const inputBytes = cachedInputBytes ?? Array.from(new Uint8Array(await file.arrayBuffer()));

      // Call Rust backend — note: NO extra "args" wrapper!
      const outputPathFromRust = await invoke<string>("process_ffmpeg", {
        payload: {
          input_bytes: inputBytes,
          output_type: outputType,
          format,
          quality,
          resolution,
          aspect_ratio: aspectRatio,
          brightness,
          contrast,
          saturation,
          volume,
          denoise,
          dehummer,
          color_filter: filter,
          text_overlays: overlays.map((item) => ({
            text: item.text,
            x_pct: item.xPct,
            y_pct: item.yPct,
            size_rel: item.sizeRel,
            color: item.color,
          })),
        },
      });

      setOutputPath(outputPathFromRust);

      // NEW: Read the processed file bytes
      const fileBytesRaw = await invoke<number[] | Uint8Array | ArrayBuffer>("get_processed_file_bytes", {
        path: outputPathFromRust,
      });

      const fileBytes = normalizeInvokeBytes(fileBytesRaw);

      // Create Blob and object URL
      const mimeType = getOutputMimeType(outputType, format);

      const blob = new Blob([fileBytes], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);

      // Store the blob URL for preview
      setOutputUrl((prev) => {
        if (prev?.startsWith("blob:")) {
          URL.revokeObjectURL(prev);
        }
        return blobUrl;
      });


      toast.success("Processing complete!", { id: toastId });
      setProgress(100);
      setStatus("Complete! Ready to preview/download.");
    } catch (err: any) {
      const rawMessage =
        typeof err === "string"
          ? err
          : typeof err?.message === "string"
            ? err.message
            : "Processing failed";

      const message = rawMessage.trim().length > 0
        ? rawMessage.trim()
        : "Processing failed with an unknown FFmpeg error.";

      const friendlyMessage = message.toLowerCase().includes("drawtext")
        ? "Overlay rendering failed in FFmpeg (drawtext). Try plain text without emoji, or remove overlays and render again."
        : message;

      console.error("processMedia failed:", friendlyMessage, err);
      setError(friendlyMessage);
      toast.error("Processing failed", { id: toastId });
      setStatus("Failed");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownload = async () => {
    if (!outputPath) {
      toast.error("No processed file available");
      return;
    }

    try {
      const suggestedName = `converted-${Date.now()}.${format}`;

      await invoke("save_processed_file", {
        path: outputPath,
        filename: suggestedName,
      });

      toast.success("File saved successfully!");
    } catch (err: any) {
      console.error("Save error:", err);
      if (err?.message?.includes("cancelled")) {
        toast.info("Save cancelled");
      } else {
        toast.error("Could not save file");
      }
    }
  };


  return (
    <div className="flex flex-col w-full max-w-7xl mx-auto h-[90vh] bg-gradient-to-br from-zinc-50 via-white to-zinc-100 dark:from-zinc-950 dark:via-zinc-900 dark:to-zinc-950 rounded-3xl overflow-hidden shadow-2xl border border-zinc-200/50 dark:border-zinc-800/50">
      {/* Main responsive layout container */}
      <div className="flex flex-col lg:flex-row h-full gap-5 p-5 min-h-0 overflow-hidden">
        {/* === VIDEO PREVIEW CONTAINER === */}
        <div className="flex-1 lg:flex-[7] min-h-[40vh] lg:min-h-0 bg-gradient-to-br from-black to-zinc-900 relative flex flex-col overflow-hidden rounded-2xl border border-zinc-700/30 shadow-xl">
          {/* Top badges & close button */}
          <div className="absolute top-4 left-4 z-20 flex gap-2">
            <Badge
              variant="secondary"
              className="bg-white/90 dark:bg-black/70 backdrop-blur-md px-3 py-1.5 text-[11px] font-bold shadow-lg border border-white/20"
            >
              {orientation === "horizontal" ? (
                <Monitor className="w-3.5 h-3.5 mr-1.5" />
              ) : (
                <Smartphone className="w-3.5 h-3.5 mr-1.5" />
              )}
              {videoDimensions.width}×{videoDimensions.height}
            </Badge>
          </div>

          <button
            onClick={onCancel}
            className="absolute top-4 right-4 z-20 p-2 rounded-full bg-white/10 hover:bg-red-500/20 dark:bg-black/40 dark:hover:bg-red-500/30 backdrop-blur-md transition-all text-zinc-200 dark:text-zinc-300 hover:text-red-400 shadow-lg"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Video content - takes most space */}
          <div className="relative w-full h-full bg-black rounded-xl overflow-hidden">
            {isVideoLoading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-pink-500 animate-spin" />
              </div>
            ) : null}

            {previewSource ? (
              <video
                ref={videoRef}
                src={previewSource}
                autoPlay
                muted={false}
                loop
                playsInline
                controls
                preload="auto"
                className="w-full h-full object-contain"
                style={outputUrl ? undefined : { filter: previewCssFilter }}
                onLoadedMetadata={() => {
                  setIsVideoLoading(false);
                  console.log("Preview metadata loaded");
                }}
                onLoadedData={() => console.log("Preview data ready")}
                onError={(e) => {
                  const err = e.currentTarget.error;
                  const code = err?.code;
                  const codeText = describeMediaErrorCode(code);
                  const message = err?.message || "Unknown error";

                  console.error("Video element error", {
                    code,
                    codeText,
                    message,
                    src: e.currentTarget.currentSrc,
                    previewSource,
                    outputType,
                    format,
                  });

                  setError(`Preview failed: ${message} (${codeText}${code ? ` / code ${code}` : ""})`);
                  setIsVideoLoading(false);

                  if (!outputUrl && !fallbackPreviewTriedRef.current) {
                    void createCompatibilityPreview();
                  }
                }}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm">
                Loading preview...
              </div>
            )}

            {!outputUrl && (
              <div ref={previewCanvasRef} className="absolute inset-0 pointer-events-none">
                {overlays.map((item) => {
                  const isSelected = item.id === selectedOverlayId;

                  return (
                    <div
                      key={item.id}
                      className={`absolute select-none pointer-events-auto cursor-grab active:cursor-grabbing rounded-md px-1.5 py-0.5 ${isSelected ? "ring-2 ring-pink-400 bg-black/20" : "bg-black/10"}`}
                      style={{
                        left: `${(item.xPct * 100).toFixed(2)}%`,
                        top: `${(item.yPct * 100).toFixed(2)}%`,
                        transform: "translate(-50%, -50%)",
                        fontSize: `${Math.max(14, Math.round(item.sizeRel * 420))}px`,
                        color: item.color,
                        textShadow: "0 2px 8px rgba(0,0,0,0.7)",
                        lineHeight: 1.1,
                        fontWeight: item.kind === "emoji" ? 500 : 700,
                      }}
                      onPointerDown={(event) => startOverlayInteraction(event, item.id, "move")}
                    >
                      {item.text}
                      {isSelected && (
                        <button
                          type="button"
                          className="absolute -right-2 -bottom-2 w-5 h-5 rounded-full bg-pink-500 text-white text-[10px] leading-none flex items-center justify-center shadow pointer-events-auto"
                          onPointerDown={(event) => startOverlayInteraction(event, item.id, "resize")}
                          aria-label="Resize overlay"
                        >
                          ↔
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Progress bar */}
          <div className="p-4 bg-gradient-to-r from-zinc-900 via-zinc-800 to-zinc-900 backdrop-blur-sm border-t border-zinc-700/50 shrink-0 rounded-b-2xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div
                  className={`w-2.5 h-2.5 rounded-full transition-all ${isProcessing ? "bg-amber-400 animate-pulse" : "bg-emerald-400"
                    }`}
                />
                <span className="text-sm font-medium text-zinc-300">{status}</span>
              </div>
              <span className="text-xs font-bold text-zinc-500">{progress}%</span>
            </div>
            <Progress value={progress} className="h-1.5 bg-zinc-700" />
          </div>
        </div>

        {/* === CONTROLS PANEL === */}
        <div className="flex-1 lg:flex-[4] min-h-[45vh] lg:min-h-0 bg-gradient-to-br from-white via-zinc-50 to-zinc-100 dark:from-zinc-900 dark:via-zinc-850 dark:to-zinc-900 rounded-2xl border border-zinc-200/50 dark:border-zinc-700/50 shadow-xl p-5 flex flex-col overflow-hidden">
          <header className="flex items-center justify-between shrink-0 pb-3 border-b border-zinc-200/50 dark:border-zinc-700/50">
            <div>
              <h1 className="text-lg font-bold tracking-tight text-zinc-900 dark:text-white">{t("Processor")}</h1>
              <p className="text-xs text-zinc-700 dark:text-zinc-300 uppercase font-semibold tracking-widest mt-0.5">
                FFmpeg {t("Powered")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="text-[10px] py-1 px-2 border-zinc-300 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-800 font-semibold"
              >
                v0.12.10
              </Badge>
            </div>
          </header>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0 overflow-hidden">
            <TabsList className="grid grid-cols-4 w-full mb-4 bg-zinc-100 dark:bg-zinc-800/50 rounded-lg p-1 h-10 gap-0.5 shrink-0 border border-zinc-200 dark:border-zinc-700/50">
              <TabsTrigger
                value="video"
                className="rounded-md text-xs font-medium data-[state=active]:bg-white data-[state=active]:shadow-md data-[state=active]:text-zinc-900 dark:data-[state=active]:bg-zinc-700 dark:data-[state=active]:text-white transition-all"
              >
                <Video className="w-3.5 h-3.5 mr-1" />
                <span className="hidden sm:inline">{t("Media")}</span>
              </TabsTrigger>
              <TabsTrigger
                value="filters"
                className="rounded-md text-xs font-medium data-[state=active]:bg-white data-[state=active]:shadow-md data-[state=active]:text-zinc-900 dark:data-[state=active]:bg-zinc-700 dark:data-[state=active]:text-white transition-all"
              >
                <Sun className="w-3.5 h-3.5 mr-1" />
                <span className="hidden sm:inline">{t("Visuals")}</span>
              </TabsTrigger>
              <TabsTrigger
                value="audio"
                className="rounded-md text-xs font-medium data-[state=active]:bg-white data-[state=active]:shadow-md data-[state=active]:text-zinc-900 dark:data-[state=active]:bg-zinc-700 dark:data-[state=active]:text-white transition-all"
              >
                <Volume2 className="w-3.5 h-3.5 mr-1" />
                <span className="hidden sm:inline">{t("Audio")}</span>
              </TabsTrigger>
              <TabsTrigger
                value="whisper"
                className="rounded-md text-xs font-medium data-[state=active]:bg-white data-[state=active]:shadow-md data-[state=active]:text-zinc-900 dark:data-[state=active]:bg-zinc-700 dark:data-[state=active]:text-white transition-all"
              >
                <Type className="w-3.5 h-3.5 mr-1" />
                <span className="hidden sm:inline">{t("Whisper")}</span>
              </TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
                className="flex-1 min-h-0 overflow-y-auto pr-4 custom-scrollbar"
              >
                {/* All your TabsContent sections remain exactly the same */}
                <TabsContent value="video" className="space-y-4 mt-0">
                  {/* ... your existing video tab content ... */}
                  <div className="grid grid-cols-2 gap-4">
                    {/* Output Type */}
                    <div className="space-y-3">
                      <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300">{t("Output Type")}</Label>
                      <Select
                        value={outputType}
                        onValueChange={(v: any) => {
                          setOutputType(v);
                          setFormat(v === "video" ? "mp4" : "mp3");
                        }}
                      >
                        <SelectTrigger className="rounded-2xl h-12">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="video">{t("Video")}</SelectItem>
                          <SelectItem value="audio">{t("Audio Only")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Format */}
                    <div className="space-y-3">
                      <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300">{t("Format")}</Label>
                      <Select value={format} onValueChange={setFormat}>
                        <SelectTrigger className="rounded-2xl h-12">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {outputType === "video" ? (
                            <>
                              <SelectItem value="mp4">MP4 (H.264)</SelectItem>
                              <SelectItem value="webm">WebM (VP9)</SelectItem>
                              <SelectItem value="mov">MOV</SelectItem>
                            </>
                          ) : (
                            <>
                              <SelectItem value="mp3">MP3</SelectItem>
                              <SelectItem value="wav">WAV</SelectItem>
                              <SelectItem value="aac">AAC</SelectItem>
                            </>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {outputType === "video" && (
                    <>
                      <div className="space-y-3">
                        <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300 flex items-center justify-between">
                          <span>Target Resolution</span>
                          <Scaling className="w-3 h-3" />
                        </Label>
                        <Select value={resolution} onValueChange={(v: any) => setResolution(v)}>
                          <SelectTrigger className="rounded-2xl h-12">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="original">{t("Keep Original")}</SelectItem>
                            <SelectItem value="1080p">1080p Full HD</SelectItem>
                            <SelectItem value="720p">720p HD</SelectItem>
                            <SelectItem value="480p">480p SD</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-3">
                        <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300 flex items-center justify-between">
                          <span>{t("Crop Preset")}</span>
                          <CropIcon className="w-3 h-3" />
                        </Label>
                        <Select value={aspectRatio} onValueChange={(v: any) => setAspectRatio(v)}>
                          <SelectTrigger className="rounded-2xl h-12">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="original">{t("Original Aspect")}</SelectItem>
                            <SelectItem value="9:16">9:16 (TikTok/Shorts)</SelectItem>
                            <SelectItem value="1:1">1:1 (Square)</SelectItem>
                            <SelectItem value="16:9">16:9 (Landscape)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}

                  <div className="space-y-3">
                    <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300">Export Quality</Label>
                    <div className="grid grid-cols-3 gap-2 bg-zinc-100 dark:bg-zinc-900 p-1 rounded-2xl">
                      {(["low", "medium", "high"] as const).map((q) => (
                        <button
                          key={q}
                          onClick={() => setQuality(q)}
                          className={`py-2 rounded-xl text-xs font-bold capitalize transition-all ${quality === q
                            ? "bg-white dark:bg-zinc-800 shadow-sm text-pink-500"
                            : "text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white"
                            }`}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="filters" className="space-y-4 mt-0 pr-2">
                  {/* ... your existing filters content ... */}
                  <div className="space-y-3 p-4 bg-zinc-50 dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Realtime Preview</p>
                        <p className="text-xs text-zinc-700 dark:text-zinc-300">Adjustments render in the player compositor instantly. FFmpeg runs only when you export.</p>
                      </div>
                      <Badge variant="outline" className="text-[10px]">Fast</Badge>
                    </div>
                  </div>

                  <div className="space-y-6">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300">{t("Brightness")}</Label>
                        <span className="text-xs font-mono text-pink-500">{brightness.toFixed(1)}</span>
                      </div>
                      <Slider
                        value={[brightness]}
                        min={-0.5}
                        max={0.5}
                        step={0.05}
                        onValueChange={([v]) => setBrightness(v)}
                        className="py-2"
                      />
                    </div>

                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300">{t("Contrast")}</Label>
                        <span className="text-xs font-mono text-pink-500">{contrast.toFixed(1)}</span>
                      </div>
                      <Slider
                        value={[contrast]}
                        min={0.5}
                        max={1.5}
                        step={0.05}
                        onValueChange={([v]) => setContrast(v)}
                        className="py-2"
                      />
                    </div>

                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300">{t("Saturation")}</Label>
                        <span className="text-xs font-mono text-pink-500">{saturation.toFixed(1)}</span>
                      </div>
                      <Slider
                        value={[saturation]}
                        min={0}
                        max={2}
                        step={0.1}
                        onValueChange={([v]) => setSaturation(v)}
                        className="py-2"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300">{t("Color Profile")}</Label>
                    <div className="grid grid-cols-2 gap-3">
                      {(["none", "grayscale", "sepia", "vignette"] as const).map((f) => (
                        <button
                          key={f}
                          onClick={() => setFilter(f)}
                          className={`p-3 rounded-2xl text-[10px] font-black uppercase tracking-widest border-2 transition-all ${filter === f
                            ? "border-pink-500 bg-pink-500/5 text-pink-500"
                            : "border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
                            }`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3 p-4 bg-white/70 dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300">Creative Overlays</Label>
                      <Badge variant="outline" className="text-[10px]">Drag to place</Badge>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-[11px] text-zinc-700 dark:text-zinc-300">Text</Label>
                      <div className="flex gap-2">
                        <input
                          value={draftText}
                          onChange={(event) => setDraftText(event.target.value)}
                          className="flex-1 h-9 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 text-sm"
                          placeholder="Type sticker text"
                        />
                        <Button type="button" variant="outline" className="h-9" onClick={() => addOverlay("text")}>Add</Button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-[11px] text-zinc-700 dark:text-zinc-300">Emoji</Label>
                      <div className="flex flex-wrap gap-2">
                        {EMOJI_PRESETS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => setDraftEmoji(emoji)}
                            className={`h-9 w-9 rounded-lg border text-lg ${draftEmoji === emoji ? "border-pink-500 bg-pink-100 dark:bg-pink-900/40" : "border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950"}`}
                          >
                            {emoji}
                          </button>
                        ))}
                        <Button type="button" variant="outline" className="h-9" onClick={() => addOverlay("emoji")}>Add Emoji</Button>
                      </div>
                    </div>

                    {selectedOverlay && (
                      <div className="space-y-3 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                        <Label className="text-[11px] text-zinc-700 dark:text-zinc-300">Selected Overlay</Label>
                        <input
                          value={selectedOverlay.text}
                          onChange={(event) => updateOverlay(selectedOverlay.id, { text: event.target.value })}
                          className="w-full h-9 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 text-sm"
                        />
                        <div className="flex items-center gap-3">
                          <Label className="text-[11px] text-zinc-700 dark:text-zinc-300">Size</Label>
                          <Slider
                            value={[selectedOverlay.sizeRel]}
                            min={0.03}
                            max={0.26}
                            step={0.01}
                            onValueChange={([value]) => updateOverlay(selectedOverlay.id, { sizeRel: value })}
                            className="flex-1"
                          />
                          <span className="text-[11px] text-zinc-500 w-9 text-right">{Math.round(selectedOverlay.sizeRel * 100)}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Label className="text-[11px] text-zinc-700 dark:text-zinc-300">Color</Label>
                            <input
                              type="color"
                              value={selectedOverlay.color}
                              onChange={(event) => updateOverlay(selectedOverlay.id, { color: event.target.value })}
                              className="h-8 w-10 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
                            />
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-8 text-xs"
                            onClick={() => removeOverlay(selectedOverlay.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="audio" className="space-y-4 mt-0 pr-2">
                  {/* ... your existing audio content ... */}
                  <div className="space-y-6">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-bold uppercase text-zinc-700 dark:text-zinc-300">{t("Master Volume")}</Label>
                        <span className="text-xs font-mono text-pink-500">{(volume * 100).toFixed(0)}%</span>
                      </div>
                      <Slider
                        value={[volume]}
                        min={0}
                        max={2}
                        step={0.1}
                        onValueChange={([v]) => setVolume(v)}
                        className="py-2"
                      />
                    </div>

                    <div className="space-y-4 pt-4">
                      <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-900 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                        <div className="flex items-center gap-3">
                          <Wind className="w-5 h-5 text-blue-500" />
                          <div>
                            <p className="text-sm font-bold">{t("Denoise Audio")}</p>
                            <p className="text-[10px] text-zinc-700 dark:text-zinc-300">{t("Remove background hiss")}</p>
                          </div>
                        </div>
                        <Switch checked={denoise} onCheckedChange={setDenoise} />
                      </div>

                      <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-900 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                        <div className="flex items-center gap-3">
                          <Droplet className="w-5 h-5 text-indigo-500" />
                          <div>
                            <p className="text-sm font-bold">{t("Dehummer")}</p>
                            <p className="text-[10px] text-zinc-700 dark:text-zinc-300">{t("Cut 50/60Hz hum")}</p>
                          </div>
                        </div>
                        <Switch checked={dehummer} onCheckedChange={setDehummer} />
                      </div>

                      <p className="text-[11px] text-zinc-700 dark:text-zinc-300">
                        Audio cleanup is intentionally conservative to avoid robotic artifacts.
                      </p>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="whisper" className="space-y-3 mt-0 pr-2">
                  <div className="p-6 bg-zinc-50 dark:bg-zinc-900 rounded-3xl border border-zinc-100 dark:border-zinc-800 space-y-4">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="p-2 rounded-xl bg-pink-500/10 text-pink-500">
                        <Type className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-bold">{t("AI Transcription")}</h3>
                        <p className="text-[10px] text-zinc-700 dark:text-zinc-300 uppercase font-black">{t("visit the transcriptions tab")}</p>
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </motion.div>
            </AnimatePresence>
          </Tabs>

          {/* Action Buttons */}
          <div className="pt-4 space-y-3 shrink-0">
            <Button
              onClick={processMedia}
              disabled={isProcessing}
              className="w-full h-11 rounded-lg text-sm font-bold bg-zinc-950 dark:bg-white text-white dark:text-zinc-950 hover:scale-[1.01] active:scale-[0.99] transition-all shadow-lg disabled:opacity-50"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                  {t("Processing")}
                </>
              ) : (
                <>
                  <Wand2 className="w-3.5 h-3.5 mr-2" />
                  {t("Render & Export")}
                </>
              )}
            </Button>

            {outputUrl && (
              <Button
                onClick={handleDownload}
                variant="outline"
                className="w-full h-11 rounded-lg text-sm font-bold border-2 border-pink-500/20 text-pink-500 hover:bg-pink-500 hover:text-white transition-all"
              >
                <Download className="w-3.5 h-3.5 mr-2" />
                Download Result
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Error toast */}
      {error && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-md p-4 bg-red-500 text-white rounded-2xl flex items-center gap-3 shadow-2xl animate-in fade-in slide-in-from-bottom-4">
          <AlertTriangle className="w-6 h-6 flex-shrink-0" />
          <p className="text-xs font-bold">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}