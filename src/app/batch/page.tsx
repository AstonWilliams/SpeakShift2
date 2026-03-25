"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Boxes,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderArchive,
  Link2,
  ListOrdered,
  Mic,
  Play,
  Cpu,
  Settings2,
  Trash2,
} from "lucide-react";
import { FaGoogleDrive, FaInstagram, FaYoutube } from "react-icons/fa";
import { FaXTwitter } from "react-icons/fa6";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Document, Packer, Paragraph, TextRun } from "docx";
import jsPDF from "jspdf";
import { useTranslations } from "next-intl";

type QueueSourceType = "zip" | "folder" | "drive-link";
type ExportFormat = "srt" | "vtt" | "json" | "pdf" | "docx" | "txt";
type AccelerationMode = "auto" | "cpu-safe" | "balanced" | "aggressive";

type QueueConfig = {
  model: string;
  language: string;
  acceleration: AccelerationMode;
  exportFormats: ExportFormat[];
  outputLocation: string | null;
  remoteDownloadLocation: string | null;
  itemsPerQueue: number;
  requestedParallel: number;
  processMode: "single" | "sequential";
};

type QueueSource = {
  value: string;
  type: QueueSourceType;
};

type BatchQueue = {
  id: string;
  name: string;
  sequence: number;
  useGlobalConfig: boolean;
  config: QueueConfig;
  sources: QueueSource[];
};

type Segment = {
  start_ms: number;
  end_ms: number;
  text: string;
};

type TranscriptionResult = {
  segments: Segment[];
  detected_language?: string;
  language?: string;
  full_text?: string;
  audio_path?: string;
  error?: string;
};

type BatchRuntimeLimits = {
  os: string;
  total_ram_mib: number;
  free_ram_mib: number;
  logical_cores: number;
  model_estimated_ram_mib: number;
  reserve_ram_mib: number;
  recommended_parallel_items: number;
  max_parallel_items: number;
  recommended_threads_per_item: number;
  acceleration_mode: string;
  notes: string[];
};

type SourceExpandResult = {
  items: string[];
  warnings: string[];
  extracted_dir?: string | null;
};

type BatchTask = {
  taskId: string;
  queueId: string;
  queueName: string;
  queueSequence: number;
  inputPath: string;
  outputDir: string;
  config: QueueConfig;
};

type QueueProgress = {
  total: number;
  completed: number;
  running: number;
  error: number;
  status: "idle" | "running" | "done" | "error";
};

type LinkPlatform = "all" | "x" | "drive" | "youtube" | "instagram";

const ZIP_EXTENSIONS = ["zip", "7z", "rar", "tar", "gz"];

const WHISPER_MODELS = [
  { value: "ggml-tiny.bin", label: "Tiny (~39 MB) - fastest, lowest quality" },
  { value: "ggml-tiny.en.bin", label: "Tiny EN (~39 MB) - English only" },
  { value: "ggml-base.bin", label: "Base (~74 MB) - good balance" },
  { value: "ggml-base.en.bin", label: "Base EN (~74 MB) - English only" },
  { value: "ggml-small.bin", label: "Small (~244 MB) - better quality" },
  { value: "ggml-small.en.bin", label: "Small EN (~244 MB) - English only" },
  { value: "ggml-medium.bin", label: "Medium (~769 MB) - high quality" },
  { value: "ggml-medium.en.bin", label: "Medium EN (~769 MB) - English only" },
  { value: "ggml-large-v1.bin", label: "Large v1 (~1.55 GB) - very high quality" },
  { value: "ggml-large-v2.bin", label: "Large v2 (~1.55 GB) - improved" },
  { value: "ggml-large-v3.bin", label: "Large v3 (~1.55 GB) - latest and best" },
  { value: "ggml-large-v3-turbo.bin", label: "Large v3 Turbo (~809 MB) - faster large model" },
] as const;
const LANGUAGE_OPTIONS = [
  { code: "auto", label: "Auto detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "hi", label: "Hindi" },
  { code: "ar", label: "Arabic" },
  { code: "zh", label: "Chinese" },
];

const EXPORT_FORMATS: ExportFormat[] = ["srt", "vtt", "json", "pdf", "docx", "txt"];

const defaultConfig: QueueConfig = {
  model: "ggml-base.en.bin",
  language: "auto",
  acceleration: "auto",
  exportFormats: ["srt", "txt"],
  outputLocation: null,
  remoteDownloadLocation: null,
  itemsPerQueue: 1,
  requestedParallel: 1,
  processMode: "single",
};

function generateQueueId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

function isDriveLink(value: string) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("drive.google.com") ||
    normalized.includes("onedrive") ||
    normalized.includes("dropbox") ||
    normalized.includes("sharepoint")
  );
}

function getPathName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || "queue-item";
}

function detectSourceType(value: string): QueueSourceType | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (isHttpUrl(trimmed)) {
    return "drive-link";
  }

  const extension = trimmed.split(".").pop()?.toLowerCase() || "";
  if (ZIP_EXTENSIONS.includes(extension)) {
    return "zip";
  }

  return "folder";
}

function parseHttpLinks(input: string) {
  const matches = input.match(/https?:\/\/[^\s<>"]+/gi) || [];
  const sanitized = matches
    .map((link) => link.replace(/[),.;]+$/, "").trim())
    .filter(Boolean);
  return Array.from(new Set(sanitized));
}

function linkMatchesPlatform(link: string, platform: LinkPlatform) {
  const normalized = link.toLowerCase();
  if (platform === "all") return true;
  if (platform === "x") return normalized.includes("x.com") || normalized.includes("twitter.com");
  if (platform === "drive") return normalized.includes("drive.google.com") || normalized.includes("docs.google.com");
  if (platform === "youtube") return normalized.includes("youtube.com") || normalized.includes("youtu.be");
  if (platform === "instagram") return normalized.includes("instagram.com");
  return true;
}

function getQueueNameFromSource(source: QueueSource, fallbackIndex: number) {
  if (source.type === "drive-link") {
    try {
      const url = new URL(source.value);
      const host = (url.hostname || "link").replace(/^www\./, "");
      return `${host}-${fallbackIndex}`;
    } catch {
      return `link-${fallbackIndex}`;
    }
  }
  return getPathName(source.value).replace(/\.[^/.]+$/, "");
}

function resequence(queues: BatchQueue[]) {
  return queues.map((queue, idx) => ({ ...queue, sequence: idx + 1 }));
}

function getQueueOutputPreview(queue: BatchQueue, effectiveConfig: QueueConfig) {
  if (!effectiveConfig.outputLocation) {
    return "Select output location";
  }

  const safeQueueName = queue.name.trim() || `queue-${queue.sequence}`;
  const exportPart = effectiveConfig.exportFormats.join(", ") || "srt";
  return `${effectiveConfig.outputLocation}/${safeQueueName} (${exportPart})`;
}

function sanitizeFileStem(path: string) {
  const base = path.split(/[\\/]/).pop() || "item";
  const noExt = base.replace(/\.[^/.]+$/, "");
  const cleaned = noExt.replace(/[^a-zA-Z0-9-_ ]/g, "_").trim();
  return cleaned || "item";
}

function formatSrtTimestamp(ms: number) {
  const safe = Math.max(0, Math.floor(ms));
  const h = Math.floor(safe / 3600000);
  const m = Math.floor((safe % 3600000) / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  const milli = safe % 1000;
  const pad = (v: number, w: number) => String(v).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}

function formatVttTimestamp(ms: number) {
  const safe = Math.max(0, Math.floor(ms));
  const h = Math.floor(safe / 3600000);
  const m = Math.floor((safe % 3600000) / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  const milli = safe % 1000;
  const pad = (v: number, w: number) => String(v).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(milli, 3)}`;
}

function buildSrt(segments: Segment[]) {
  return segments
    .map(
      (seg, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(seg.start_ms)} --> ${formatSrtTimestamp(seg.end_ms)}\n${seg.text.trim()}\n`,
    )
    .join("\n");
}

function buildVtt(segments: Segment[]) {
  const body = segments
    .map(
      (seg) =>
        `${formatVttTimestamp(seg.start_ms)} --> ${formatVttTimestamp(seg.end_ms)}\n${seg.text.trim()}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

async function buildDocxBytes(title: string, segments: Segment[]) {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 32 })],
    }),
    new Paragraph({ text: "" }),
  ];

  for (const seg of segments) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${formatSrtTimestamp(seg.start_ms)} - ${formatSrtTimestamp(seg.end_ms)}  `,
            bold: true,
          }),
          new TextRun({ text: seg.text.trim() }),
        ],
      }),
    );
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

function buildPdfBytes(title: string, segments: Segment[]) {
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  let y = 40;
  const maxWidth = 520;

  pdf.setFontSize(14);
  pdf.text(title, 40, y);
  y += 24;

  pdf.setFontSize(10);
  for (const seg of segments) {
    const line = `[${formatSrtTimestamp(seg.start_ms)} - ${formatSrtTimestamp(seg.end_ms)}] ${seg.text.trim()}`;
    const chunks = pdf.splitTextToSize(line, maxWidth);
    for (const chunk of chunks) {
      if (y > 790) {
        pdf.addPage();
        y = 40;
      }
      pdf.text(chunk, 40, y);
      y += 14;
    }
    y += 4;
  }

  const arrayBuffer = pdf.output("arraybuffer");
  return new Uint8Array(arrayBuffer);
}

async function runWithConcurrency<T>(
  tasks: T[],
  limit: number,
  worker: (task: T, idx: number) => Promise<void>,
) {
  if (!tasks.length) return;

  let cursor = 0;
  const size = Math.max(1, limit);
  const runners = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= tasks.length) return;
      await worker(tasks[idx], idx);
    }
  });

  await Promise.all(runners);
}

export default function BatchPage() {
  const t = useTranslations();
  const [mounted, setMounted] = useState(false);
  const [queues, setQueues] = useState<BatchQueue[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [, setDragDepth] = useState(0);
  const [globalConfig, setGlobalConfig] = useState<QueueConfig>(defaultConfig);
  const [runtimeLimits, setRuntimeLimits] = useState<BatchRuntimeLimits | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runWarnings, setRunWarnings] = useState<string[]>([]);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [itemStatus, setItemStatus] = useState<Record<string, "queued" | "running" | "done" | "error">>({});
  const [queueProgress, setQueueProgress] = useState<Record<string, QueueProgress>>({});
  const [showLinksPanel, setShowLinksPanel] = useState(false);
  const [activeLinkPlatform, setActiveLinkPlatform] = useState<LinkPlatform>("all");
  const [linksInput, setLinksInput] = useState("");

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      setDragDepth((prev) => prev + 1);
      setIsDragOver(true);
    };

    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      setIsDragOver(true);
    };

    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      setDragDepth((prev) => {
        const next = Math.max(0, prev - 1);
        if (next === 0) {
          setIsDragOver(false);
        }
        return next;
      });
    };

    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragDepth(0);
      setIsDragOver(false);
      handleBrowserDrop(event);
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
            const droppedPaths = event.payload.paths || [];
            addSourcesToQueue(droppedPaths);
          }
        });
      } catch (error) {
        console.error("Failed to attach Tauri drag-drop listener:", error);
      }
    };

    void subscribe();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const totalSources = useMemo(() => {
    return queues.reduce((acc, queue) => acc + queue.sources.length, 0);
  }, [queues]);

  const allDetectedLinks = useMemo(() => parseHttpLinks(linksInput), [linksInput]);
  const platformLinks = useMemo(
    () => allDetectedLinks.filter((link) => linkMatchesPlatform(link, activeLinkPlatform)),
    [allDetectedLinks, activeLinkPlatform],
  );

  const openLinksPanel = (platform: LinkPlatform) => {
    setActiveLinkPlatform(platform);
    setShowLinksPanel(true);
  };

  const addLinksFromPanel = () => {
    if (!platformLinks.length) return;
    addSourcesToQueue(platformLinks);
    setShowLinksPanel(false);
    setLinksInput("");
  };

  if (!mounted) return null;

  function addSourcesToQueue(values: string[]) {
    const expandedValues = values
      .flatMap((raw) => raw.split(/\r?\n/).map((line) => line.trim()))
      .filter(Boolean);

    const preparedSources = expandedValues
      .map((rawValue) => {
        const sourceType = detectSourceType(rawValue);
        if (!sourceType) return null;
        const normalizedValue = rawValue.trim();
        return {
          value: normalizedValue,
          type: sourceType,
        } satisfies QueueSource;
      })
      .filter((source): source is QueueSource => Boolean(source));

    if (!preparedSources.length) {
      return;
    }

    setQueues((prev) => {
      const next = [...prev];
      const seen = new Set(next.flatMap((queue) => queue.sources.map((source) => `${source.type}:${source.value}`)));

      const uniquePrepared: QueueSource[] = [];
      for (const source of preparedSources) {
        const key = `${source.type}:${source.value}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        uniquePrepared.push(source);
      }

      for (const source of uniquePrepared) {
        const suggestedName = getQueueNameFromSource(source, next.length + 1);

        next.push({
          id: generateQueueId(),
          name: suggestedName,
          sequence: next.length + 1,
          useGlobalConfig: true,
          config: {
            ...defaultConfig,
          },
          sources: [source],
        });
      }

      return resequence(next);
    });
  }

  function handleBrowserDrop(event: DragEvent | React.DragEvent<HTMLDivElement>) {
    const transfer = event.dataTransfer;
    if (!transfer) return;

    const collected: string[] = [];

    const uriList = transfer.getData("text/uri-list").trim();
    if (uriList) {
      const urls = uriList
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      collected.push(...urls);
    }

    const plainText = transfer.getData("text/plain").trim();
    if (plainText) {
      const urls = plainText.match(/https?:\/\/[^\s<>"]+/gi) || [];
      if (urls.length) {
        collected.push(...urls);
      }
    }

    const files = Array.from(transfer.files || []);
    for (const file of files) {
      const detected = detectSourceType(file.name);
      if (detected === "zip") {
        collected.push(file.name);
      }
    }

    addSourcesToQueue(collected);
  }

  async function pickZipFiles() {
    try {
      const selected = await open({
        title: "Select zip archives",
        filters: [
          {
            name: "Archive",
            extensions: ZIP_EXTENSIONS,
          },
        ],
        multiple: true,
        directory: false,
      });

      if (!selected) return;
      const normalized = Array.isArray(selected) ? selected : [selected];
      addSourcesToQueue(normalized);
    } catch (error) {
      console.error("Zip picker error:", error);
    }
  }

  async function pickFolders() {
    try {
      const selected = await open({
        title: "Select folders",
        multiple: true,
        directory: true,
      });

      if (!selected) return;
      const normalized = Array.isArray(selected) ? selected : [selected];
      addSourcesToQueue(normalized);
    } catch (error) {
      console.error("Folder picker error:", error);
    }
  }

  async function pickOutputLocationForAll() {
    try {
      const selected = await open({
        title: "Select output location",
        multiple: false,
        directory: true,
      });

      if (!selected || Array.isArray(selected)) {
        return;
      }

      setGlobalConfig((prev) => ({ ...prev, outputLocation: selected }));
    } catch (error) {
      console.error("Output location picker error:", error);
    }
  }

  async function pickRemoteDownloadLocationForAll() {
    try {
      const selected = await open({
        title: "Select remote download location",
        multiple: false,
        directory: true,
      });

      if (!selected || Array.isArray(selected)) {
        return;
      }

      setGlobalConfig((prev) => ({ ...prev, remoteDownloadLocation: selected }));
    } catch (error) {
      console.error("Remote download location picker error:", error);
    }
  }

  async function pickOutputLocationForQueue(queueId: string) {
    try {
      const selected = await open({
        title: "Select queue output location",
        multiple: false,
        directory: true,
      });

      if (!selected || Array.isArray(selected)) {
        return;
      }

      setQueues((prev) =>
        prev.map((queue) =>
          queue.id === queueId
            ? {
              ...queue,
              config: {
                ...queue.config,
                outputLocation: selected,
              },
            }
            : queue,
        ),
      );
    } catch (error) {
      console.error("Queue output location picker error:", error);
    }
  }

  async function pickRemoteDownloadLocationForQueue(queueId: string) {
    try {
      const selected = await open({
        title: "Select queue remote download location",
        multiple: false,
        directory: true,
      });

      if (!selected || Array.isArray(selected)) {
        return;
      }

      setQueues((prev) =>
        prev.map((queue) =>
          queue.id === queueId
            ? {
              ...queue,
              config: {
                ...queue.config,
                remoteDownloadLocation: selected,
              },
            }
            : queue,
        ),
      );
    } catch (error) {
      console.error("Queue remote download location picker error:", error);
    }
  }

  function moveQueue(queueId: string, direction: "up" | "down") {
    setQueues((prev) => {
      const currentIndex = prev.findIndex((queue) => queue.id === queueId);
      if (currentIndex < 0) return prev;

      const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) {
        return prev;
      }

      const next = [...prev];
      const [moved] = next.splice(currentIndex, 1);
      next.splice(targetIndex, 0, moved);
      return resequence(next);
    });
  }

  function removeQueue(queueId: string) {
    setQueues((prev) => resequence(prev.filter((queue) => queue.id !== queueId)));
  }

  function updateQueueName(queueId: string, name: string) {
    setQueues((prev) =>
      prev.map((queue) => (queue.id === queueId ? { ...queue, name } : queue)),
    );
  }

  function toggleQueueExportFormat(
    queueId: string,
    format: ExportFormat,
    checked: boolean,
  ) {
    setQueues((prev) =>
      prev.map((queue) => {
        if (queue.id !== queueId) return queue;

        const nextFormats = checked
          ? Array.from(new Set([...queue.config.exportFormats, format]))
          : queue.config.exportFormats.filter((value) => value !== format);

        return {
          ...queue,
          config: {
            ...queue.config,
            exportFormats: nextFormats,
          },
        };
      }),
    );
  }

  function toggleGlobalExportFormat(format: ExportFormat, checked: boolean) {
    setGlobalConfig((prev) => {
      const nextFormats = checked
        ? Array.from(new Set([...prev.exportFormats, format]))
        : prev.exportFormats.filter((value) => value !== format);

      return {
        ...prev,
        exportFormats: nextFormats,
      };
    });
  }

  function appendLog(message: string) {
    setRunLog((prev) => [...prev, message]);
  }

  function getEffectiveQueueConfig(queue: BatchQueue): QueueConfig {
    return queue.useGlobalConfig ? globalConfig : queue.config;
  }

  async function analyzeRuntime() {
    setIsAnalyzing(true);
    try {
      const limits = await invoke<BatchRuntimeLimits>("batch_get_runtime_limits", {
        modelName: globalConfig.model,
        acceleration: globalConfig.acceleration,
        requestedParallel: globalConfig.requestedParallel,
      });
      setRuntimeLimits(limits);
      setGlobalConfig((prev) => ({
        ...prev,
        requestedParallel: Math.max(1, Math.min(limits.max_parallel_items, limits.recommended_parallel_items)),
      }));
    } catch (error) {
      console.error("Failed to analyze runtime:", error);
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function exportTranscription(
    outputDir: string,
    stem: string,
    formats: ExportFormat[],
    result: TranscriptionResult,
  ) {
    const fullText = result.segments.map((s) => s.text.trim()).join("\n");

    for (const format of formats) {
      const targetPath = `${outputDir}/${stem}.${format}`;

      if (format === "srt") {
        await invoke("batch_write_text_file", {
          path: targetPath,
          content: buildSrt(result.segments),
        });
        continue;
      }

      if (format === "vtt") {
        await invoke("batch_write_text_file", {
          path: targetPath,
          content: buildVtt(result.segments),
        });
        continue;
      }

      if (format === "json") {
        await invoke("batch_write_text_file", {
          path: targetPath,
          content: JSON.stringify(result, null, 2),
        });
        continue;
      }

      if (format === "txt") {
        await invoke("batch_write_text_file", {
          path: targetPath,
          content: fullText,
        });
        continue;
      }

      if (format === "pdf") {
        const bytes = buildPdfBytes(stem, result.segments);
        await invoke("batch_write_bytes_file", {
          path: targetPath,
          bytes: Array.from(bytes),
        });
        continue;
      }

      if (format === "docx") {
        const bytes = await buildDocxBytes(stem, result.segments);
        await invoke("batch_write_bytes_file", {
          path: targetPath,
          bytes: Array.from(bytes),
        });
      }
    }
  }

  async function buildTasksFromQueues() {
    const warnings: string[] = [];
    const tasks: BatchTask[] = [];

    const sortedQueues = [...queues].sort((a, b) => a.sequence - b.sequence);

    for (const queue of sortedQueues) {
      const effectiveConfig = getEffectiveQueueConfig(queue);
      if (!effectiveConfig.outputLocation) {
        throw new Error(`Queue \"${queue.name}\" has no output location`);
      }

      const outputDir = await invoke<string>("batch_prepare_queue_output", {
        baseOutput: effectiveConfig.outputLocation,
        queueName: queue.name,
      });

      for (const source of queue.sources) {
        const expanded = await invoke<SourceExpandResult>("batch_expand_source", {
          value: source.value,
          sourceType: source.type,
          downloadDir: effectiveConfig.remoteDownloadLocation || effectiveConfig.outputLocation,
        });

        warnings.push(...expanded.warnings.map((w) => `${queue.name}: ${w}`));

        for (const item of expanded.items.slice(0, Math.max(1, effectiveConfig.itemsPerQueue))) {
          tasks.push({
            taskId: generateQueueId(),
            queueId: queue.id,
            queueName: queue.name,
            queueSequence: queue.sequence,
            inputPath: item,
            outputDir,
            config: effectiveConfig,
          });
        }
      }
    }

    return { tasks, warnings };
  }

  async function startBatchRun() {
    if (!queues.length || isRunning) return;

    setIsRunning(true);
    setRunWarnings([]);
    setRunLog([]);
    setItemStatus({});
    setQueueProgress({});

    try {
      const limitsCache = new Map<string, BatchRuntimeLimits>();
      const getLimitsForConfig = async (config: QueueConfig) => {
        const key = `${config.model}:${config.acceleration}:${config.requestedParallel}`;
        const cached = limitsCache.get(key);
        if (cached) return cached;
        const fetched = await invoke<BatchRuntimeLimits>("batch_get_runtime_limits", {
          modelName: config.model,
          acceleration: config.acceleration,
          requestedParallel: config.requestedParallel,
        });
        limitsCache.set(key, fetched);
        return fetched;
      };

      const limits = runtimeLimits
        || (await getLimitsForConfig(globalConfig));

      setRuntimeLimits(limits);

      const { tasks, warnings } = await buildTasksFromQueues();
      setRunWarnings(warnings);

      const queueTotals = tasks.reduce<Record<string, QueueProgress>>((acc, task) => {
        if (!acc[task.queueId]) {
          acc[task.queueId] = {
            total: 0,
            completed: 0,
            running: 0,
            error: 0,
            status: "idle",
          };
        }
        acc[task.queueId].total += 1;
        return acc;
      }, {});
      setQueueProgress(queueTotals);

      if (!tasks.length) {
        appendLog("No media items resolved from current queues.");
        return;
      }

      appendLog(
        `Starting ${tasks.length} item(s) with parallel limit ${Math.max(1, Math.min(limits.max_parallel_items, globalConfig.requestedParallel))}`,
      );

      const processTask = async (task: BatchTask) => {
        const taskKey = task.taskId;
        setItemStatus((prev) => ({ ...prev, [taskKey]: "running" }));
        setQueueProgress((prev) => {
          const current = prev[task.queueId];
          if (!current) return prev;
          return {
            ...prev,
            [task.queueId]: {
              ...current,
              running: current.running + 1,
              status: "running",
            },
          };
        });
        appendLog(`Running: ${task.queueName} -> ${task.inputPath}`);

        try {
          const fileName = task.inputPath.split(/[\\/]/).pop() || "item";
          const taskLimits = await getLimitsForConfig(task.config);

          const result = await invoke<TranscriptionResult>("transcribe_path", {
            filePath: task.inputPath,
            fileName,
            modelName: task.config.model,
            language: task.config.language === "auto" ? null : task.config.language,
            threads: taskLimits.recommended_threads_per_item,
            acceleration: task.config.acceleration,
          });

          if (!result?.segments?.length) {
            throw new Error("Transcription produced no segments");
          }

          const stem = sanitizeFileStem(task.inputPath);
          await exportTranscription(task.outputDir, stem, task.config.exportFormats, result);

          setItemStatus((prev) => ({ ...prev, [taskKey]: "done" }));
          setQueueProgress((prev) => {
            const current = prev[task.queueId];
            if (!current) return prev;
            const completed = current.completed + 1;
            const running = Math.max(0, current.running - 1);
            const doneAll = completed + current.error >= current.total;
            return {
              ...prev,
              [task.queueId]: {
                ...current,
                completed,
                running,
                status: doneAll ? "done" : "running",
              },
            };
          });
          appendLog(`Done: ${task.queueName} -> ${fileName}`);
        } catch (error: any) {
          setItemStatus((prev) => ({ ...prev, [taskKey]: "error" }));
          setQueueProgress((prev) => {
            const current = prev[task.queueId];
            if (!current) return prev;
            const error = current.error + 1;
            const running = Math.max(0, current.running - 1);
            const doneAll = current.completed + error >= current.total;
            return {
              ...prev,
              [task.queueId]: {
                ...current,
                error,
                running,
                status: doneAll ? "error" : "running",
              },
            };
          });
          appendLog(`Error: ${task.queueName} -> ${String(error?.message || error)}`);
        }
      };

      if (globalConfig.processMode === "sequential") {
        const queueMap = new Map<string, BatchTask[]>();
        for (const task of tasks) {
          const key = `${task.queueSequence}:${task.queueId}`;
          if (!queueMap.has(key)) queueMap.set(key, []);
          queueMap.get(key)!.push(task);
        }

        const orderedKeys = Array.from(queueMap.keys()).sort((a, b) => {
          const aSeq = Number(a.split(":")[0]);
          const bSeq = Number(b.split(":")[0]);
          return aSeq - bSeq;
        });

        for (const key of orderedKeys) {
          const queueTasks = queueMap.get(key) || [];
          const localLimit = Math.max(
            1,
            Math.min(
              globalConfig.requestedParallel,
              runtimeLimits?.max_parallel_items || limits.max_parallel_items,
              queueTasks[0]?.config.itemsPerQueue || 1,
            ),
          );

          appendLog(`Queue group ${key} with limit ${localLimit}`);
          await runWithConcurrency(queueTasks, localLimit, processTask);
        }
      } else {
        const globalLimit = Math.max(
          1,
          Math.min(globalConfig.requestedParallel, runtimeLimits?.max_parallel_items || limits.max_parallel_items),
        );
        await runWithConcurrency(tasks, globalLimit, processTask);
      }

      appendLog("Batch run finished.");
    } catch (error: any) {
      appendLog(`Batch failed: ${String(error?.message || error)}`);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="min-h-screen p-8 lg:p-12">
      <header className="mb-12">
        <h1 className="text-5xl font-black tracking-tight mb-4">{t("Batch Transcriptions")}</h1>
        <p className="text-xl text-zinc-500 font-medium">
          {t("Batch Header Description")}
        </p>
      </header>

      <main className="max-w-7xl space-y-10">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="group relative">
          <div
            className={`absolute inset-0 rounded-[64px] blur-3xl pointer-events-none transition-colors duration-500 ${
              isDragOver ? "bg-pink-500/30" : "bg-pink-100/20 group-hover:bg-pink-100/40"
            }`}
          />

          <div
            className={`relative border-4 border-dashed rounded-[64px] px-8 py-14 flex flex-col items-center justify-center gap-6 transition-all duration-300 ${
              isDragOver
                ? "border-pink-500 bg-pink-50/80 dark:bg-pink-950/20 scale-[1.01]"
                : "border-zinc-300 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/60"
            }`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setIsDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragOver(false);
              handleBrowserDrop(event);
            }}
          >
            <div className="w-20 h-20 rounded-3xl bg-white dark:bg-zinc-800 flex items-center justify-center shadow-xl">
              <Boxes className="w-10 h-10 text-pink-500" />
            </div>

            <div className="text-center max-w-3xl">
              <p className="text-3xl font-black mb-2">
                {isDragOver ? t("Drop to create queue(s)") : t("Drop zip, folder, or links")}
              </p>
              <p className="text-zinc-500 dark:text-zinc-400 font-medium text-lg">
                {t("Batch Drop Hint")}
              </p>
            </div>

            <div className="w-full max-w-2xl grid grid-cols-2 sm:grid-cols-4 gap-3">
              <button
                onClick={() => openLinksPanel("x")}
                className="px-4 py-3 rounded-2xl bg-black text-white border border-zinc-700 font-semibold inline-flex items-center justify-center gap-2"
              >
                <FaXTwitter className="w-5 h-5" />
                {t("X")}
              </button>
              <button
                onClick={() => openLinksPanel("drive")}
                className="px-4 py-3 rounded-2xl bg-white text-zinc-900 border border-zinc-300 font-semibold inline-flex items-center justify-center gap-2"
              >
                <FaGoogleDrive className="w-5 h-5 text-emerald-600" />
                {t("Google Drive")}
              </button>
              <button
                onClick={() => openLinksPanel("youtube")}
                className="px-4 py-3 rounded-2xl bg-white text-zinc-900 border border-zinc-300 font-semibold inline-flex items-center justify-center gap-2"
              >
                <FaYoutube className="w-5 h-5 text-red-600" />
                {t("YouTube")}
              </button>
              <button
                onClick={() => openLinksPanel("instagram")}
                className="px-4 py-3 rounded-2xl bg-white text-zinc-900 border border-zinc-300 font-semibold inline-flex items-center justify-center gap-2"
              >
                <FaInstagram className="w-5 h-5 text-pink-600" />
                {t("Instagram")}
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                onClick={pickZipFiles}
                className="px-5 py-3 rounded-2xl bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold hover:opacity-90"
              >
                {t("Pick zip files (Tauri)")}
              </button>
              <button
                onClick={pickFolders}
                className="px-5 py-3 rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 font-semibold"
              >
                {t("Pick folders (Tauri)")}
              </button>
              <button
                onClick={() => openLinksPanel("all")}
                className="px-5 py-3 rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 font-semibold"
              >
                {t("Paste Links")}
              </button>
            </div>

            {showLinksPanel && (
              <div className="w-full max-w-4xl rounded-3xl border border-zinc-300 dark:border-zinc-700 bg-white/95 dark:bg-zinc-950/95 p-5 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-lg font-bold">{t("Paste links modal title")}</h3>
                  <button
                    onClick={() => setShowLinksPanel(false)}
                    className="px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700"
                  >
                    {t("Close")}
                  </button>
                </div>

                <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("Paste links modal subtitle")}</p>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-500">{t("Link platform filter")}</span>
                  {([
                    { key: "all", label: t("All links") },
                    { key: "x", label: t("X") },
                    { key: "drive", label: t("Google Drive") },
                    { key: "youtube", label: t("YouTube") },
                    { key: "instagram", label: t("Instagram") },
                  ] as Array<{ key: LinkPlatform; label: string }>).map((item) => (
                    <button
                      key={item.key}
                      onClick={() => setActiveLinkPlatform(item.key)}
                      className={`px-3 py-1.5 rounded-full text-sm border ${activeLinkPlatform === item.key
                        ? "bg-pink-600 text-white border-pink-600"
                        : "border-zinc-300 dark:border-zinc-700"
                        }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <textarea
                  value={linksInput}
                  onChange={(event) => setLinksInput(event.target.value)}
                  placeholder={t("Paste links textarea placeholder")}
                  className="w-full min-h-32 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 text-sm"
                />

                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3">
                  <p className="text-sm font-semibold mb-2">
                    {t("Detected links")}: {platformLinks.length}
                  </p>
                  {platformLinks.length === 0 ? (
                    <p className="text-sm text-zinc-500">{t("No links detected")}</p>
                  ) : (
                    <div className="max-h-36 overflow-auto space-y-1">
                      {platformLinks.map((link, index) => (
                        <div key={link} className="grid grid-cols-[2rem_1fr] gap-2 text-sm">
                          <span className="text-zinc-500 font-semibold">{index + 1}.</span>
                          <span className="break-all">{link}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  onClick={addLinksFromPanel}
                  disabled={!platformLinks.length}
                  className="px-5 py-2.5 rounded-xl bg-pink-600 text-white font-semibold disabled:opacity-50"
                >
                  {t("Add links to queue")}
                </button>
              </div>
            )}
          </div>
        </motion.div>

        <section className="grid grid-cols-1 xl:grid-cols-[1.2fr_2fr] gap-8">
          <div className="rounded-4xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-6 lg:p-8">
            <div className="flex items-center gap-3 mb-6">
              <Settings2 className="w-5 h-5 text-pink-500" />
              <h2 className="text-2xl font-black">Global Queue Config</h2>
            </div>

            <div className="space-y-5">
              <label className="block">
                <span className="text-sm font-semibold text-zinc-500">Whisper model</span>
                <select
                  value={globalConfig.model}
                  onChange={(event) =>
                    setGlobalConfig((prev) => ({ ...prev, model: event.target.value }))
                  }
                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2"
                >
                  {WHISPER_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-semibold text-zinc-500">Language</span>
                <select
                  value={globalConfig.language}
                  onChange={(event) =>
                    setGlobalConfig((prev) => ({ ...prev, language: event.target.value }))
                  }
                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2"
                >
                  {LANGUAGE_OPTIONS.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-semibold text-zinc-500">Acceleration profile</span>
                <select
                  value={globalConfig.acceleration}
                  onChange={(event) =>
                    setGlobalConfig((prev) => ({
                      ...prev,
                      acceleration: event.target.value as AccelerationMode,
                    }))
                  }
                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2"
                >
                  <option value="auto">Auto (platform default)</option>
                  <option value="cpu-safe">CPU-safe (lowest OOM risk)</option>
                  <option value="balanced">Balanced</option>
                  <option value="aggressive">Aggressive throughput</option>
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-semibold text-zinc-500">Queue mode</span>
                <select
                  value={globalConfig.processMode}
                  onChange={(event) =>
                    setGlobalConfig((prev) => ({
                      ...prev,
                      processMode: event.target.value as QueueConfig["processMode"],
                    }))
                  }
                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2"
                >
                  <option value="single">One item per queue</option>
                  <option value="sequential">Sequence queues in order</option>
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-semibold text-zinc-500">Items per queue</span>
                <input
                  type="number"
                  min={1}
                  value={globalConfig.itemsPerQueue}
                  onChange={(event) =>
                    setGlobalConfig((prev) => ({
                      ...prev,
                      itemsPerQueue: Math.max(1, Number(event.target.value || 1)),
                    }))
                  }
                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2"
                />
              </label>

              <label className="block">
                <span className="text-sm font-semibold text-zinc-500">Requested parallel items</span>
                <input
                  type="number"
                  min={1}
                  max={runtimeLimits?.max_parallel_items || 8}
                  value={globalConfig.requestedParallel}
                  onChange={(event) =>
                    setGlobalConfig((prev) => ({
                      ...prev,
                      requestedParallel: Math.max(1, Number(event.target.value || 1)),
                    }))
                  }
                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2"
                />
              </label>

              <div>
                <p className="text-sm font-semibold text-zinc-500 mb-2">Export formats</p>
                <div className="grid grid-cols-2 gap-2">
                  {EXPORT_FORMATS.map((format) => (
                    <label key={format} className="inline-flex items-center gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        checked={globalConfig.exportFormats.includes(format)}
                        onChange={(event) => toggleGlobalExportFormat(format, event.target.checked)}
                      />
                      {format.toUpperCase()}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-zinc-500">Output location</p>
                <button
                  onClick={pickOutputLocationForAll}
                  className="mt-2 px-4 py-2 rounded-xl border border-zinc-300 dark:border-zinc-700 font-semibold"
                >
                  Choose output folder
                </button>
                <p className="mt-2 text-sm text-zinc-500 break-all">
                  {globalConfig.outputLocation || "No output location selected"}
                </p>
              </div>

              <div>
                <p className="text-sm font-semibold text-zinc-500">Remote links download location (yt-dlp)</p>
                <button
                  onClick={pickRemoteDownloadLocationForAll}
                  className="mt-2 px-4 py-2 rounded-xl border border-zinc-300 dark:border-zinc-700 font-semibold"
                >
                  Choose download folder
                </button>
                <p className="mt-2 text-sm text-zinc-500 break-all">
                  {globalConfig.remoteDownloadLocation || "No download location selected (uses output folder)"}
                </p>
              </div>

              <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/50 p-3 space-y-2">
                <button
                  onClick={analyzeRuntime}
                  disabled={isAnalyzing || isRunning}
                  className="px-4 py-2 rounded-xl border border-zinc-300 dark:border-zinc-700 font-semibold disabled:opacity-50"
                >
                  {isAnalyzing ? "Analyzing..." : "Analyze Memory & CPU"}
                </button>

                {runtimeLimits ? (
                  <div className="text-xs text-zinc-500 space-y-1">
                    <p>
                      {runtimeLimits.os} • RAM {runtimeLimits.free_ram_mib} / {runtimeLimits.total_ram_mib} MiB free
                    </p>
                    <p>
                      Recommended parallel: {runtimeLimits.recommended_parallel_items} (max {runtimeLimits.max_parallel_items})
                    </p>
                    <p>
                      Thread hint per item: {runtimeLimits.recommended_threads_per_item}
                    </p>
                    {runtimeLimits.notes.map((note) => (
                      <p key={note}>- {note}</p>
                    ))}
                  </div>
                ) : null}
              </div>

              <button
                onClick={startBatchRun}
                disabled={isRunning || !queues.length}
                className="w-full py-3 rounded-2xl bg-pink-600 text-white font-bold disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                <Play className="w-4 h-4" />
                {isRunning ? "Running batch..." : "Run Batch"}
              </button>
            </div>
          </div>

          <div className="rounded-4xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-6 lg:p-8">
            <div className="flex items-center justify-between gap-3 mb-6">
              <h2 className="text-2xl font-black">Queue List</h2>
              <div className="text-sm text-zinc-500 font-semibold">
                {queues.length} queues • {totalSources} source items
              </div>
            </div>

            {!queues.length ? (
              <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center text-zinc-500">
                Drop or pick sources to create queues.
              </div>
            ) : (
              <div className="space-y-4">
                {queues.map((queue, index) => {
                  const effectiveConfig = queue.useGlobalConfig ? globalConfig : queue.config;

                  return (
                    <div key={queue.id} className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4 lg:p-5">
                      <div className="flex flex-wrap items-center gap-3 mb-4">
                        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs font-bold">
                          <ListOrdered className="w-3 h-3" /> #{queue.sequence}
                        </span>

                        <input
                          value={queue.name}
                          onChange={(event) => updateQueueName(queue.id, event.target.value)}
                          className="min-w-55 flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 font-semibold"
                        />

                        <div className="flex items-center gap-2">
                          <button
                            disabled={index === 0}
                            onClick={() => moveQueue(queue.id, "up")}
                            className="p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 disabled:opacity-40"
                            aria-label="Move queue up"
                          >
                            <ChevronUp className="w-4 h-4" />
                          </button>
                          <button
                            disabled={index === queues.length - 1}
                            onClick={() => moveQueue(queue.id, "down")}
                            className="p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 disabled:opacity-40"
                            aria-label="Move queue down"
                          >
                            <ChevronDown className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => removeQueue(queue.id)}
                            className="p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-red-500"
                            aria-label="Delete queue"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        <div className="space-y-2">
                          <p className="text-sm font-semibold text-zinc-500">Sources</p>
                          {queue.sources.map((source) => (
                            <div
                              key={`${queue.id}-${source.value}`}
                              className="rounded-xl bg-zinc-50 dark:bg-zinc-800/50 p-3 text-sm flex items-center gap-2"
                            >
                              {source.type === "zip" && <FolderArchive className="w-4 h-4 text-pink-500" />}
                              {source.type === "folder" && <Folder className="w-4 h-4 text-blue-500" />}
                              {source.type === "drive-link" && <Link2 className="w-4 h-4 text-green-500" />}
                              <span className="truncate">{source.value}</span>
                            </div>
                          ))}
                        </div>

                        <div className="space-y-3">
                          <label className="inline-flex items-center gap-2 text-sm font-semibold">
                            <input
                              type="checkbox"
                              checked={queue.useGlobalConfig}
                              onChange={(event) =>
                                setQueues((prev) =>
                                  prev.map((item) =>
                                    item.id === queue.id
                                      ? { ...item, useGlobalConfig: event.target.checked }
                                      : item,
                                  ),
                                )
                              }
                            />
                            Use global config
                          </label>

                          {!queue.useGlobalConfig && (
                            <div className="space-y-3 rounded-xl border border-zinc-200 dark:border-zinc-800 p-3">
                              <label className="block text-sm">
                                <span className="font-semibold text-zinc-500">Whisper model</span>
                                <select
                                  value={queue.config.model}
                                  onChange={(event) =>
                                    setQueues((prev) =>
                                      prev.map((item) =>
                                        item.id === queue.id
                                          ? {
                                            ...item,
                                            config: {
                                              ...item.config,
                                              model: event.target.value,
                                            },
                                          }
                                          : item,
                                      ),
                                    )
                                  }
                                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2"
                                >
                                  {WHISPER_MODELS.map((model) => (
                                    <option key={model.value} value={model.value}>
                                      {model.label}
                                    </option>
                                  ))}
                                </select>
                              </label>

                              <label className="block text-sm">
                                <span className="font-semibold text-zinc-500">Language</span>
                                <select
                                  value={queue.config.language}
                                  onChange={(event) =>
                                    setQueues((prev) =>
                                      prev.map((item) =>
                                        item.id === queue.id
                                          ? {
                                            ...item,
                                            config: {
                                              ...item.config,
                                              language: event.target.value,
                                            },
                                          }
                                          : item,
                                      ),
                                    )
                                  }
                                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2"
                                >
                                  {LANGUAGE_OPTIONS.map((lang) => (
                                    <option key={lang.code} value={lang.code}>
                                      {lang.label}
                                    </option>
                                  ))}
                                </select>
                              </label>

                              <label className="block text-sm">
                                <span className="font-semibold text-zinc-500">Acceleration profile</span>
                                <select
                                  value={queue.config.acceleration}
                                  onChange={(event) =>
                                    setQueues((prev) =>
                                      prev.map((item) =>
                                        item.id === queue.id
                                          ? {
                                            ...item,
                                            config: {
                                              ...item.config,
                                              acceleration: event.target.value as AccelerationMode,
                                            },
                                          }
                                          : item,
                                      ),
                                    )
                                  }
                                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2"
                                >
                                  <option value="auto">Auto</option>
                                  <option value="cpu-safe">CPU-safe</option>
                                  <option value="balanced">Balanced</option>
                                  <option value="aggressive">Aggressive</option>
                                </select>
                              </label>

                              <label className="block text-sm">
                                <span className="font-semibold text-zinc-500">Items per queue</span>
                                <input
                                  type="number"
                                  min={1}
                                  value={queue.config.itemsPerQueue}
                                  onChange={(event) =>
                                    setQueues((prev) =>
                                      prev.map((item) =>
                                        item.id === queue.id
                                          ? {
                                            ...item,
                                            config: {
                                              ...item.config,
                                              itemsPerQueue: Math.max(1, Number(event.target.value || 1)),
                                            },
                                          }
                                          : item,
                                      ),
                                    )
                                  }
                                  className="mt-2 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2"
                                />
                              </label>

                              <div>
                                <p className="text-sm font-semibold text-zinc-500 mb-2">Export formats</p>
                                <div className="grid grid-cols-2 gap-2">
                                  {EXPORT_FORMATS.map((format) => (
                                    <label
                                      key={`${queue.id}-${format}`}
                                      className="inline-flex items-center gap-2 text-sm"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={queue.config.exportFormats.includes(format)}
                                        onChange={(event) =>
                                          toggleQueueExportFormat(queue.id, format, event.target.checked)
                                        }
                                      />
                                      {format.toUpperCase()}
                                    </label>
                                  ))}
                                </div>
                              </div>

                              <button
                                onClick={() => pickOutputLocationForQueue(queue.id)}
                                className="px-4 py-2 rounded-xl border border-zinc-300 dark:border-zinc-700 font-semibold"
                              >
                                Choose queue output folder
                              </button>

                              <button
                                onClick={() => pickRemoteDownloadLocationForQueue(queue.id)}
                                className="px-4 py-2 rounded-xl border border-zinc-300 dark:border-zinc-700 font-semibold"
                              >
                                Choose queue links download folder
                              </button>
                            </div>
                          )}

                          <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/50 p-3 text-sm">
                            <p className="font-semibold mb-1">Output preview</p>
                            <p className="break-all text-zinc-500">
                              {getQueueOutputPreview(queue, effectiveConfig)}
                            </p>
                          </div>

                          {queueProgress[queue.id] && queueProgress[queue.id].total > 0 && (
                            <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/50 p-3 text-sm space-y-2">
                              <div className="flex items-center justify-between">
                                <p className="font-semibold">Queue progress</p>
                                <p className="text-zinc-500">
                                  {queueProgress[queue.id].completed + queueProgress[queue.id].error} / {queueProgress[queue.id].total}
                                </p>
                              </div>
                              <div className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                                <div
                                  className={`h-full transition-all ${queueProgress[queue.id].status === "error" ? "bg-red-500" : "bg-pink-500"}`}
                                  style={{
                                    width: `${Math.min(
                                      100,
                                      Math.round(
                                        ((queueProgress[queue.id].completed + queueProgress[queue.id].error) /
                                          Math.max(1, queueProgress[queue.id].total)) * 100,
                                      ),
                                    )}%`,
                                  }}
                                />
                              </div>
                              <p className="text-xs text-zinc-500">
                                running: {queueProgress[queue.id].running} • done: {queueProgress[queue.id].completed} • error: {queueProgress[queue.id].error}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-6 rounded-[28px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
            <Mic className="w-6 h-6 text-pink-500 mb-3" />
            <h3 className="text-lg font-bold mb-2">Whisper-first pipeline</h3>
            <p className="text-zinc-500">Model selection is applied globally or per queue based on your toggle.</p>
          </div>
          <div className="p-6 rounded-[28px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
            <ListOrdered className="w-6 h-6 text-blue-500 mb-3" />
            <h3 className="text-lg font-bold mb-2">Queue sequencing</h3>
            <p className="text-zinc-500">Move queues up/down to define exact processing order before execution.</p>
          </div>
          <div className="p-6 rounded-[28px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
            <Cpu className="w-6 h-6 text-green-500 mb-3" />
            <h3 className="text-lg font-bold mb-2">Structured exports</h3>
            <p className="text-zinc-500">Exports are planned inside queue-named folders at the selected destination.</p>
          </div>
        </section>

        {(runWarnings.length > 0 || runLog.length > 0) && (
          <section className="rounded-3xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-6 lg:p-8 space-y-4">
            <h3 className="text-xl font-black">Execution Log</h3>

            {runWarnings.length > 0 && (
              <div className="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 p-3 text-sm space-y-1">
                {runWarnings.map((warn) => (
                  <p key={warn}>- {warn}</p>
                ))}
              </div>
            )}

            <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/40 p-3 text-sm space-y-1 max-h-72 overflow-auto">
              {runLog.map((line, idx) => (
                <p key={`${idx}-${line}`}>{line}</p>
              ))}
            </div>

            {Object.keys(itemStatus).length > 0 && (
              <div className="text-xs text-zinc-500">
                done: {Object.values(itemStatus).filter((v) => v === "done").length} • error: {Object.values(itemStatus).filter((v) => v === "error").length} • running: {Object.values(itemStatus).filter((v) => v === "running").length}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
