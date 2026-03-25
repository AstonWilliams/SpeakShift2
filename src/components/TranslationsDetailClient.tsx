"use client";
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  Copy,
  Loader2,
  ChevronDown,
  Languages,
  AlertTriangle,
  Check,
  FileText,
  Clock,
  File,
  AlignLeft,
  List,
  Search as SearchIcon,
  ChevronRight,
  FileDown,
  Edit,
  Save,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import {
  getTranscription,
  getTranslation,
  getAsrSegments,
  updateTranscription,
  getSpeakerTurns,
  saveSpeakerTurns,
  saveTranscription,           // if you want to save renaming from UI
  type Transcription,
  type AsrSegment,
  type SpeakerTurn,
  saveTranslation,
} from "@/lib/transcriptionDb";

import { showToast } from "@/lib/toast";
import { invoke } from "@tauri-apps/api/core";
import { useTranslations } from "next-intl";
import { NLLB_LANGUAGES } from "@/lib/language_keys";
import OnboardingCard from "./OnboardingCard";





export default function TranslationsDetailClient({ id }: { id: string }) {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { resolvedTheme } = useTheme();

  const isDark = resolvedTheme === "dark";

  // ──────────────────────────────────────────────────────────────
  // COLORS
  // ──────────────────────────────────────────────────────────────
  const bgBase = isDark ? "bg-zinc-950" : "bg-white";
  const bgPanel = isDark ? "bg-zinc-900/95" : "bg-white";
  const bgHeader = isDark ? "bg-zinc-950/80" : "bg-white";
  const borderColor = isDark ? "border-zinc-700" : "border-gray-300";
  const textPrimary = isDark ? "text-zinc-100" : "text-gray-900";
  const textSecondary = isDark ? "text-zinc-300" : "text-gray-700";
  const textMuted = isDark ? "text-zinc-500" : "text-gray-600";
  const searchBg = isDark ? "bg-zinc-800" : "bg-gray-50";
  const searchBorder = isDark ? "border-zinc-700" : "border-gray-300";
  const selectedBg = isDark ? "bg-purple-900/40" : "bg-purple-100";
  const selectedText = isDark ? "text-purple-300" : "text-purple-800";
  const progressBg = isDark ? "bg-zinc-800/80" : "bg-gray-200";
  const progressFill = "from-orange-600 via-amber-500 to-orange-700";

  const [transcription, setTranscription] = useState<Transcription | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceLang, setSourceLang] = useState("eng_Latn");
  const [targetLang, setTargetLang] = useState("heb_Hebr");
  const [translated, setTranslated] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, percent: 0 });
  const [translateStartTime, setTranslateStartTime] = useState<number | null>(null);

  const [displayMode, setDisplayMode] = useState<"free" | "segments">("segments");
  const [originalSearch, setOriginalSearch] = useState("");
  const [translatedSearch, setTranslatedSearch] = useState("");
  const [collapsedSegments, setCollapsedSegments] = useState<Set<number>>(new Set());

  // Edit mode
  const [editOriginal, setEditOriginal] = useState(false);
  const [editTranslated, setEditTranslated] = useState(false);
  const [editedOriginalText, setEditedOriginalText] = useState("");
  const [editedTranslatedText, setEditedTranslatedText] = useState("");

  const [asrSegments, setAsrSegments] = useState<AsrSegment[]>([]);

  const [speakerTurns, setSpeakerTurns] = useState<SpeakerTurn[]>([]);
  const [displaySegments, setDisplaySegments] = useState<{
    start: number;
    end: number;
    speaker: string;
    text: string;
  }[]>([]);

  const loadAndSetTranslation = async (transId: string, lang: string) => {
    const entry = await getTranslation(transId, lang);
    console.log("[loadTranslation]", lang, entry ? "found" : "MISSING", entry?.translatedText?.slice(0, 60));
    if (entry?.translatedText) {
      setTranslated(entry.translatedText);
      setEditedTranslatedText(entry.translatedText);
      return true;
    }
    return false;
  };

  useEffect(() => {
    async function loadData() {
      try {
        const tx = await getTranscription(id);
        if (!tx) {
          showToast("Transcription not found", "error");
          return;
        }
        setTranscription(tx);
        setEditedTranslatedText("");

        const segments = await getAsrSegments(id);
        setAsrSegments(segments);

        // NEW: Load speaker turns
        const turns = await getSpeakerTurns(id);
        setSpeakerTurns(turns);

        // NEW: Merge into display segments (speaker + text)
        const merged = turns.map((turn) => {
          // Find overlapping ASR segments and join their text
          const overlapping = segments.filter(
            (s) => s.start < turn.end && s.end > turn.start
          );
          const text = overlapping.map((s) => s.text.trim()).join(" ") || "[no text overlap]";

          return {
            start: turn.start,
            end: turn.end,
            speaker: turn.displayName || turn.clusterId || "Unknown",
            text,
          };
        });

        setDisplaySegments(merged);
        await loadAndSetTranslation(id, targetLang);

        // const translation = await getTranslation(id, targetLang);
        // if (translation) {
        //   setTranslated(translation.translatedText);
        //   setEditedTranslatedText(translation.translatedText);
        // }

        if (tx.detectedLanguage) {
          setSourceLang(tx.detectedLanguage);
        }
      } catch (err) {
        console.error(err);
        showToast("Failed to load translation data", "error");
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, [id, targetLang]);

  // ──────────────────────────────────────────────────────────────
  // Chunking & Translation Logic (unchanged)
  // ──────────────────────────────────────────────────────────────
  const MAX_CHUNK_CHARS = 400;
  const MIN_CHUNK_CHARS = 150;
  const OVERLAP_SENTENCES = 1;
  const DEFAULT_BEAM_SIZE = 6;
  const DEFAULT_MAX_NEW_TOKENS = 400;

  const splitTextIntoChunks = (text: string): string[] => {
    if (!text.trim()) return [];
    const chunks: string[] = [];
    let current = "";
    let lastSentences: string[] = [];
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim());

    for (const sentence of sentences) {
      const candidate = (current ? current + " " : "") + sentence;
      if (candidate.length > MAX_CHUNK_CHARS) {
        if (current.length >= MIN_CHUNK_CHARS) {
          chunks.push(current.trim());
          lastSentences = current.split(/(?<=[.!?])\s+/).slice(-OVERLAP_SENTENCES);
          current = lastSentences.join(" ") + " " + sentence;
        } else {
          if (current) chunks.push(current.trim());
          current = sentence;
        }
      } else {
        current = candidate;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    if (chunks.length === 0 && text.trim()) chunks.push(text.trim());
    return chunks;
  };

  // Approximate split of translated text using original segment count + lengths
  function approximateTranslatedSegments(
    originalSegments: AsrSegment[],
    fullTranslated: string
  ): { start: number; end: number; text: string }[] {
    if (!originalSegments.length || !fullTranslated.trim()) {
      return [];
    }

    const totalOriginalChars = originalSegments.reduce((sum, s) => sum + s.text.length, 0);
    if (totalOriginalChars === 0) return [];

    const translatedChars = fullTranslated.length;
    const ratio = translatedChars / totalOriginalChars;

    const result: { start: number; end: number; text: string }[] = [];
    let translatedPos = 0;

    originalSegments.forEach((seg) => {
      const estimatedLength = Math.round(seg.text.length * ratio);
      const chunk = fullTranslated.slice(translatedPos, translatedPos + estimatedLength).trim();
      if (chunk) {
        result.push({
          start: seg.start,
          end: seg.end,
          text: chunk,
        });
      }
      translatedPos += estimatedLength;
    });

    // Last bit safety net
    if (translatedPos < fullTranslated.length) {
      const last = result[result.length - 1];
      if (last) {
        last.text += " " + fullTranslated.slice(translatedPos).trim();
      }
    }

    return result;
  }

  const handleTranslate = async () => {
    if (!transcription?.fullText?.trim()) {
      return showToast("No text to translate", "error");
    }

    setIsTranslating(true);
    setProgress({ current: 0, total: 0, percent: 0 });
    setTranslateStartTime(Date.now());
    // ← Optional: clear old translation so user sees we're working
    setTranslated("");
    setEditedTranslatedText("");

    try {
      const fullText = transcription.fullText.trim();
      const chunks = splitTextIntoChunks(fullText);
      if (chunks.length === 0) throw new Error("No valid chunks");

      setProgress({ current: 0, total: chunks.length, percent: 0 });
      const translatedParts: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const result = await invoke<any>("translate_text", {
          text: chunk,
          srcLang: sourceLang,
          tgtLang: targetLang,
          beam: DEFAULT_BEAM_SIZE,
          maxNewTokens: DEFAULT_MAX_NEW_TOKENS,
        });

        if (!result.success) throw new Error(result.error || `Chunk ${i + 1} failed`);

        let clean = result.translated?.trim() ?? "";
        clean = clean.replace(/^(\s*__[a-z]{3}_[A-Za-z]{4}__\s*)+/, "").trim();
        translatedParts.push(clean);

        const percent = Math.round(((i + 1) / chunks.length) * 100);
        setProgress({ current: i + 1, total: chunks.length, percent });
      }

      // Build final text
      const final = translatedParts
        .join("\n\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\s+/g, " ")
        .replace(/\n\s*\n/g, "\n\n")
        .trim();

      // Save first
      await saveTranslation(id, targetLang, final, "nllb-200");
      console.log("[translate] saved to DB →", targetLang);

      const fresh = await getTranslation(id, targetLang);
      console.log("[translate] fresh from DB →", fresh?.translatedText?.slice(0, 80) || "(not found)");

      // Then immediately load from DB → this is the source of truth
      const loaded = await loadAndSetTranslation(id, targetLang);

      if (!loaded) {
        // Fallback: if DB read fails for some reason, use what we just computed
        setTranslated(final);
        setEditedTranslatedText(final);
      }

      // Optional detected language update
      if (transcription.detectedLanguage && transcription.detectedLanguage !== sourceLang) {
        await updateTranscription(id, { detectedLanguage: sourceLang });
      }

      showToast("Translation completed and saved", "success");
      showToast("Translation completed and saved", "success");

    } catch (err: any) {
      console.error("Translation error:", err);
      showToast(err.message || "Translation failed", "error");
      // Optional: revert to previous translation if you stored it before
    } finally {
      setIsTranslating(false);
    }
  };

  const saveOriginalEdit = async () => {
    if (!transcription?.id) return;

    const trimmed = editedOriginalText.trim();

    try {
      // Use fullText (the correct field name in the current schema)
      await updateTranscription(id, {
        fullText: trimmed
      });

      // Update local state with the correct field
      setTranscription((prev) =>
        prev ? { ...prev, fullText: trimmed } : null
      );

      setEditOriginal(false);
      showToast("Original text updated", "success");
    } catch (err) {
      console.error("Failed to save original text:", err);
      showToast("Failed to save changes", "error");
    }
  };

  const saveTranslatedEdit = async () => {
    if (!transcription?.id) return;

    const trimmed = editedTranslatedText.trim();

    try {
      // Save to translations table instead of transcription.translationText
      await saveTranslation(
        transcription.id,
        targetLang,           // ← make sure this is set somewhere (state or prop)
        trimmed,
        editedTranslatedText.trim()           // or whatever model/source identifier
      );

      setTranslated(trimmed);
      setEditTranslated(false);
      showToast("Translation updated", "success");
    } catch (err) {
      console.error("Failed to save translation:", err);
      showToast("Failed to save changes", "error");
    }
  };

  const toggleSegment = (index: number) => {
    setCollapsedSegments((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const highlight = (text: string, query: string) => {
    if (!query.trim()) return text;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return text.split(regex).map((part, i) =>
      regex.test(part) ? (
        <span key={i} className="bg-yellow-500/40 rounded-sm px-0.5">
          {part}
        </span>
      ) : part
    );
  };

  const timeTaken = useMemo(() => {
    if (!translateStartTime || !translated) return null;
    const seconds = Math.round((Date.now() - translateStartTime) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }, [translateStartTime, translated]);

  const sourceStats = useMemo(() => {
    const txt = transcription?.fullText || "";
    return { words: txt.split(/\s+/).filter(Boolean).length, chars: txt.length };
  }, [transcription]);

  const transStats = useMemo(() => {
    const txt = translated;
    return { words: txt.split(/\s+/).filter(Boolean).length, chars: txt.length };
  }, [translated]);

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).then(() => showToast("Copied", "success"))
      .catch(() => showToast("Copy failed", "error"));
  };



  async function exportAs(format: "txt" | "vtt" | "srt" | "csv" | "json") {
    if (!transcription) return;

    let content = "";
    let defaultFilename = `translation_${id.slice(0, 8)}.${format}`;

    // ── Build content (your existing logic, just cleaned up) ─────
    if (format === "txt") {
      content = `Original (${sourceLang}):\n${transcription.fullText || ""}\n\n` +
        `Translation (${targetLang}):\n${translated || ""}`;
    } else if (format === "json") {
      content = JSON.stringify({
        id,
        original: transcription.fullText,
        translation: translated,
        sourceLang,
        targetLang,
        createdAt: transcription.createdAt.toISOString(),
      }, null, 2);
    } else if (format === "csv") {
      content = "Start,End,Speaker,Original,Translation\n" +
        displaySegments.map(s =>
          [
            formatTime(s.start),
            formatTime(s.end),
            `"${(s.speaker || "").replace(/"/g, '""')}"`,
            `"${(s.text || "").replace(/"/g, '""')}"`,
            '""'  // translation per segment not available yet
          ].join(",")
        ).join("\n");
    } else if (format === "srt") {
      content = asrSegments.map((seg, i) => {
        const idx = i + 1;
        const start = formatTime(seg.start).replace(".", ",");
        const end = formatTime(seg.end).replace(".", ",");
        return `${idx}\n${start} --> ${end}\n${seg.text.trim()}\n`;
      }).join("\n\n");
    } // add vtt similarly...

    if (!content) {
      showToast("Nothing to export", "error");
      return;
    }

    try {
      // Open native save dialog
      const filePath = await save({
        defaultPath: defaultFilename,
        filters: [{
          name: format.toUpperCase(),
          extensions: [format]
        }]
      });

      if (!filePath) {
        // user cancelled
        return;
      }

      await writeTextFile(filePath, content);
      showToast(`Saved to ${filePath.split(/[\\/]/).pop()}`, "success");
    } catch (err) {
      console.error("Export failed:", err);
      showToast("Failed to save file", "error");
    }
  }
  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "—:--";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    const timeStr = h > 0
      ? `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
      : `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return ms > 0 ? `${timeStr},${ms.toString().padStart(3, "0").slice(0, 2)}` : timeStr;
  }

  if (loading) {
    return (
      <div className={`min-h-screen ${bgBase} flex items-center justify-center`}>
        <Loader2 className="w-14 h-14 animate-spin text-purple-600 dark:text-purple-500" />
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${bgBase} ${textPrimary} pb-20`}>
      <div className="max-w-[1800px] mx-auto px-6">



        {/* Header */}
        <div className="flex items-center justify-between mb-6 pt-6">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.back()}
              className={`p-3 rounded-full hover:bg-gray-200/70 dark:hover:bg-zinc-800/60 transition ${textPrimary}`}
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-2xl font-bold tracking-tight">
              {transcription?.title || "Translation Detail"}
            </h1>
          </div>
        </div>

        {/* Progress Bar */}
        <AnimatePresence>
          {isTranslating && (
            <motion.div
              initial={{ opacity: 0, y: -30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -30 }}
              className="mb-10"
            >
              <div className={`relative h-6 ${progressBg} rounded-xl overflow-hidden border ${borderColor} shadow-lg`}>
                <motion.div
                  className={`absolute inset-0 bg-gradient-to-r ${progressFill}`}
                  initial={{ scaleX: 0, originX: 0 }}
                  animate={{ scaleX: progress.percent / 100, originX: 0 }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
                <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-white drop-shadow-md">
                  <span className="px-5 py-1 bg-black/50 rounded-full backdrop-blur-sm border border-white/10">
                    Translating {progress.current}/{progress.total} • {progress.percent}% • {timeTaken || "…"}
                  </span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex flex-col lg:flex-row gap-8">
          {/* Main Panels */}
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Original Panel */}
            <div className={`${bgPanel} border ${borderColor} rounded-2xl overflow-hidden flex flex-col shadow-xl shadow-black/10 dark:shadow-black/30 h-[calc(100vh-180px)]`}>
              <div className={`px-6 py-4 border-b ${borderColor} flex items-center justify-between ${bgHeader} backdrop-blur-sm`}>
                <div className="flex items-center gap-3">
                  <FileText className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  <h2 className="font-semibold text-lg">Original</h2>
                  <div className="text-sm flex items-center gap-1.5">
                    <span className="font-medium text-green-600 dark:text-green-400">
                      {NLLB_LANGUAGES.find(l => l.code === sourceLang)?.name || sourceLang}
                    </span>
                    <Check className="w-4 h-4 text-green-600 dark:text-green-400" />
                  </div>
                </div>

                <div className="flex items-center gap-5 text-sm text-gray-700 dark:text-zinc-400">
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-4 h-4" />
                    <span>{timeTaken || "—"}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <File className="w-4 h-4" />
                    <span>{sourceStats.words} words</span>
                  </div>
                  <span>{sourceStats.chars} chars</span>
                </div>
              </div>

              {/* Header controls */}
              <div className="px-6 py-3 border-b ${borderColor} bg-gray-50/80 dark:bg-zinc-900/40 flex items-center justify-between">
                <div className="relative flex-1">
                  <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-zinc-500" />
                  <input
                    value={originalSearch}
                    onChange={e => setOriginalSearch(e.target.value)}
                    placeholder="Search original..."
                    className={`w-full ${searchBg} border ${searchBorder} rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 ${textPrimary}`}
                  />
                </div>
                <div className="flex items-center gap-2 ml-4">
                  {editOriginal ? (
                    <>
                      <button
                        onClick={() => { setEditOriginal(false); setEditedOriginalText(transcription?.fullText || ""); }}
                        className="p-2 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
                      >
                        <X size={18} />
                      </button>
                      <button
                        onClick={saveOriginalEdit}
                        className="p-2 rounded-lg bg-green-600 hover:bg-green-700 text-white"
                      >
                        <Save size={18} />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setEditOriginal(true)}
                      className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-600 dark:text-zinc-400"
                    >
                      <Edit size={18} />
                    </button>
                  )}
                </div>
              </div>

              {/* Original text area */}
              <div className="flex-1 overflow-y-auto custom-scrollbar p-6 leading-relaxed text-[15px]">
                {editOriginal ? (
                  <textarea
                    value={editedOriginalText}
                    onChange={e => setEditedOriginalText(e.target.value)}
                    className={`w-full h-full min-h-[400px] bg-transparent border-none focus:outline-none resize-none ${textPrimary}`}
                    spellCheck={false}
                  />
                ) : (
                  renderText(
                    transcription?.fullText || "",
                    displayMode === "segments",
                    true,
                    originalSearch
                  )
                )}
              </div>
            </div>

            {/* Translation Panel */}
            <div className={`${bgPanel} border ${borderColor} rounded-2xl overflow-hidden flex flex-col shadow-xl shadow-black/10 dark:shadow-black/30 h-[calc(100vh-180px)]`}>
              <div className={`px-6 py-4 border-b ${borderColor} flex items-center justify-between ${bgHeader} backdrop-blur-sm`}>
                <div className="flex items-center gap-3">
                  <Languages className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                  <h2 className="font-semibold text-lg">Translation</h2>
                  <div className="text-sm flex items-center gap-1.5">
                    <span className="font-medium text-green-600 dark:text-green-400">
                      {NLLB_LANGUAGES.find(l => l.code === targetLang)?.name || targetLang}
                    </span>
                    <Check className="w-4 h-4 text-green-600 dark:text-green-400" />
                  </div>
                </div>

                <div className="flex items-center gap-5 text-sm text-gray-700 dark:text-zinc-400">
                  {translated && (
                    <>
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-4 h-4" />
                        <span>{timeTaken || "—"}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <File className="w-4 h-4" />
                        <span>{transStats.words} words</span>
                      </div>
                      <span>{transStats.chars} chars</span>
                    </>
                  )}
                </div>
              </div>

              <div className="px-6 py-3 border-b ${borderColor} bg-gray-50/80 dark:bg-zinc-900/40 flex items-center justify-between">
                <div className="relative flex-1">
                  <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-zinc-500" />
                  <input
                    value={translatedSearch}
                    onChange={e => setTranslatedSearch(e.target.value)}
                    placeholder="Search translation..."
                    className={`w-full ${searchBg} border ${searchBorder} rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/40 ${textPrimary}`}
                  />
                </div>
                <div className="flex items-center gap-2 ml-4">
                  {editTranslated ? (
                    <>
                      <button
                        onClick={() => { setEditTranslated(false); setEditedTranslatedText(translated); }}
                        className="p-2 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
                      >
                        <X size={18} />
                      </button>
                      <button
                        onClick={saveTranslatedEdit}
                        className="p-2 rounded-lg bg-green-600 hover:bg-green-700 text-white"
                      >
                        <Save size={18} />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setEditTranslated(true)}
                      className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-600 dark:text-zinc-400"
                    >
                      <Edit size={18} />
                    </button>
                  )}
                </div>
              </div>

              {/* Translated text area */}
              <div className="flex-1 overflow-y-auto custom-scrollbar p-6 leading-relaxed text-[15px]">
                {isTranslating && !translated ? (
                  <div className="space-y-4 pt-4">
                    {[...Array(12)].map((_, i) => (
                      <div
                        key={i}
                        className="h-5 bg-gray-200 dark:bg-zinc-800/70 rounded animate-pulse"
                        style={{ width: `${40 + Math.random() * 50}%`, animationDelay: `${i * 100}ms` }}
                      />
                    ))}
                  </div>
                ) : editTranslated ? (
                  <textarea
                    value={editedTranslatedText}
                    onChange={e => setEditedTranslatedText(e.target.value)}
                    className={`w-full h-full min-h-[400px] bg-transparent border-none focus:outline-none resize-none ${textPrimary}`}
                    spellCheck={false}
                  />
                ) : translated ? (
                  renderText(
                    translated,
                    true,
                    false,
                    translatedSearch
                  )
                ) : (
                  <div className="h-full flex items-center justify-center text-gray-500 dark:text-zinc-600 italic text-lg">
                    Translation will appear here
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="lg:w-80 lg:sticky lg:top-24 lg:self-start flex flex-col gap-6">
            {/* Language & Mode */}
            <div className={`${bgPanel} border ${borderColor} rounded-2xl p-6 backdrop-blur-sm shadow-lg`}>
              <div className="space-y-6">
                <div>
                  <label className={`block text-sm ${textMuted} mb-2`}>From</label>
                  <div className="relative">
                    <select
                      value={sourceLang}
                      onChange={e => setSourceLang(e.target.value)}
                      disabled={isTranslating}
                      className={`w-full ${searchBg} border ${searchBorder} rounded-xl px-4 py-3 pr-10 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-purple-500/40 ${textPrimary}`}
                    >
                      {NLLB_LANGUAGES.map(l => (
                        <option key={l.code} value={l.code}>{l.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 pointer-events-none" />
                  </div>
                </div>

                <div>
                  <label className={`block text-sm ${textMuted} mb-2`}>To</label>
                  <div className="relative">
                    <select
                      value={targetLang}
                      onChange={e => setTargetLang(e.target.value)}
                      disabled={isTranslating}
                      className={`w-full ${searchBg} border ${searchBorder} rounded-xl px-4 py-3 pr-10 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-purple-500/40 ${textPrimary}`}
                    >
                      {NLLB_LANGUAGES.map(l => (
                        <option key={l.code} value={l.code}>{l.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 pointer-events-none" />
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setDisplayMode("free")}
                    className={`flex-1 py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-medium border transition ${displayMode === "free"
                      ? `${selectedBg} ${selectedText} border-purple-400/50`
                      : `bg-gray-100/60 dark:bg-zinc-800/60 hover:bg-gray-200 dark:hover:bg-zinc-700 border-gray-300 dark:border-zinc-700 ${textSecondary}`
                      }`}
                  >
                    <AlignLeft size={16} />
                    Free
                  </button>
                  <button
                    onClick={() => setDisplayMode("segments")}
                    className={`flex-1 py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-medium border transition ${displayMode === "segments"
                      ? `${selectedBg} ${selectedText} border-purple-400/50`
                      : `bg-gray-100/60 dark:bg-zinc-800/60 hover:bg-gray-200 dark:hover:bg-zinc-700 border-gray-300 dark:border-zinc-700 ${textSecondary}`
                      }`}
                  >
                    <List size={16} />
                    Segments
                  </button>
                </div>

                <button
                  onClick={handleTranslate}
                  disabled={isTranslating || !transcription?.fullText?.trim()}
                  className={`w-full py-4 rounded-xl font-semibold flex items-center justify-center gap-3 transition-all shadow-md ${isTranslating
                    ? "bg-gray-200 dark:bg-zinc-800 text-gray-600 dark:text-zinc-500 cursor-wait"
                    : "bg-gradient-to-r from-purple-700 to-pink-600 hover:from-purple-600 hover:to-pink-500 text-white shadow-purple-600/30 dark:shadow-purple-900/40"
                    } disabled:opacity-50`}
                >
                  {isTranslating ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Translating...
                    </>
                  ) : (
                    <>
                      <Languages className="w-5 h-5" />
                      Translate
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Export */}
            <div className={`${bgPanel} border ${borderColor} rounded-2xl p-6 backdrop-blur-sm shadow-lg`}>
              <h3 className={`text-sm font-medium ${textMuted} mb-4`}>Export As</h3>
              <div className="grid grid-cols-2 gap-3">
                {["txt", "vtt", "srt", "csv", "json"].map(fmt => (
                  <button
                    key={fmt}
                    onClick={() => exportAs(fmt as any)}
                    className={`py-3 ${searchBg} hover:bg-gray-200 dark:hover:bg-zinc-700 rounded-xl text-sm flex items-center justify-center gap-2 transition border ${borderColor}`}
                  >
                    <FileText size={16} />
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Scrollbar & Selection */}
      <style jsx global>{`
        .custom-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: ${isDark ? "#4b5563 #1f2937" : "#9ca3af #f3f4f6"};
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: ${isDark ? "#111827" : "#f3f4f6"};
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: ${isDark ? "#4b5563" : "#9ca3af"};
          border-radius: 4px;
          border: 2px solid ${isDark ? "#111827" : "#f3f4f6"};
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: ${isDark ? "#6b7280" : "#6b7280"};
        }
        ::selection {
          background: ${isDark ? "#7c3aed" : "#3b82f6"};
          color: white;
        }
      `}</style>
    </div>
  );
  function renderText(
    text: string,
    useSegments: boolean,
    isOriginal: boolean,
    search: string,
  ) {
    if (!text?.trim()) {
      return (
        <div className={`h-full flex items-center justify-center italic ${textMuted} py-12`}>
          No {isOriginal ? "original" : "translated"} content available
        </div>
      );
    }

    const shouldUseSegments = useSegments && displayMode === "segments";

    // ──────────────────────────────────────────────────────────────
    //  ORIGINAL TEXT RENDERING
    // ──────────────────────────────────────────────────────────────
    if (isOriginal) {
      // Best case: we have speaker-turn + merged text
      if (displaySegments.length > 0) {
        return (
          <div className="space-y-7">
            {displaySegments.map((seg, i) => (
              <div
                key={i}
                className={`pb-6 border-b last:border-b-0 ${borderColor}`}
              >
                <div className="flex items-center gap-4 mb-2.5 flex-wrap">
                  <span className="font-semibold text-purple-600 dark:text-purple-400 px-3 py-1 rounded-full bg-purple-900/20 text-sm tracking-tight">
                    {seg.speaker || "Unknown"}
                  </span>
                  <span className="text-xs font-mono text-gray-500 dark:text-gray-400">
                    {formatTime(seg.start)} → {formatTime(seg.end)}
                    <span className="ml-2 opacity-70">
                      ({formatDuration(seg.end - seg.start)})
                    </span>
                  </span>
                </div>
                <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
                  {highlight(seg.text.trim(), search)}
                </p>
              </div>
            ))}
          </div>
        );
      }

      // Fallback: plain ASR segments (no speaker info)
      if (shouldUseSegments && asrSegments.length > 0) {
        return (
          <div className="space-y-7">
            {asrSegments.map((seg, i) => (
              <div
                key={i}
                className={`pb-6 border-b last:border-b-0 ${borderColor}`}
              >
                <div className="flex items-center gap-4 text-xs font-mono text-gray-500 dark:text-gray-400 mb-2.5">
                  <span>{formatTime(seg.start)}</span>
                  <span className="opacity-70">→</span>
                  <span>{formatTime(seg.end)}</span>
                  <span className="opacity-70 ml-1">
                    ({formatDuration(seg.end - seg.start)})
                  </span>
                </div>
                <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
                  {highlight(seg.text.trim(), search)}
                </p>
              </div>
            ))}
          </div>
        );
      }

      // Plain text fallback for original
      return renderPlainText(text, search);
    }

    // ──────────────────────────────────────────────────────────────
    //  TRANSLATED TEXT RENDERING
    // ──────────────────────────────────────────────────────────────
    if (shouldUseSegments && asrSegments.length > 0) {
      const approxSegments = approximateTranslatedSegments(asrSegments, text);

      if (approxSegments.length > 0) {
        return (
          <div className="space-y-7">
            {approxSegments.map((seg, i) => (
              <div
                key={i}
                className={`pb-6 border-b last:border-b-0 ${borderColor}`}
              >
                <div className="flex items-center gap-4 text-xs font-mono text-gray-500 dark:text-gray-400 mb-2.5">
                  <span>{formatTime(seg.start)}</span>
                  <span className="opacity-70">→</span>
                  <span>{formatTime(seg.end)}</span>
                  <span className="opacity-70 ml-1">
                    ({formatDuration(seg.end - seg.start)})
                  </span>
                </div>
                <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
                  {highlight(seg.text.trim(), search)}
                </p>
              </div>
            ))}
          </div>
        );
      }
    }

    // Default: plain translated text (free mode or no usable segments)
    return renderPlainText(text, search);
  }

  // ──────────────────────────────────────────────────────────────
  //  Shared plain text renderer
  // ──────────────────────────────────────────────────────────────
  function renderPlainText(text: string, search: string) {
    // 1. Normalize line breaks
    let normalized = text
      .replace(/\r\n/g, '\n')           // Windows → Unix
      .replace(/\s*\n\s*\n+/g, '\n\n'); // collapse multiple empty lines

    // 2. If there are already paragraph breaks → use them
    let paragraphs = normalized.split(/\n\n+/).map(p => p.trim()).filter(Boolean);

    // 3. If almost no paragraphs (long single block) → smart split on sentence level
    if (paragraphs.length <= 2 && normalized.length > 400) {
      // Split after .!? followed by space + uppercase or end of string
      // But avoid splitting abbreviations like "Dr.", "Mr.", "etc."
      const sentenceRegex = /(?<!\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|etc|i\.e|e\.g)\.)(?<=[.!?])\s+(?=[A-Z])/g;

      paragraphs = normalized
        .split(sentenceRegex)
        .map(p => p.trim())
        .filter(p => p.length > 0);

      // Group every 3–6 sentences into a paragraph (adjust as you like)
      const grouped: string[] = [];
      let current = '';
      let sentenceCount = 0;

      for (const sentence of paragraphs) {
        current += (current ? ' ' : '') + sentence;
        sentenceCount++;

        if (sentenceCount >= 4 || /[\.\!\?]$/.test(sentence)) {
          if (current) grouped.push(current.trim());
          current = '';
          sentenceCount = 0;
        }
      }
      if (current) grouped.push(current.trim());

      paragraphs = grouped;
    }

    if (paragraphs.length === 0) {
      return (
        <div className={`italic ${textMuted}`}>
          (empty after cleaning)
        </div>
      );
    }

    if (paragraphs.length === 1) {
      return (
        <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
          {highlight(text, search)}
        </div>
      );
    }

    return (
      <div className="space-y-5">
        {paragraphs.map((para, i) => (
          <p key={i} className="text-[15px] leading-relaxed">
            {highlight(para, search)}
          </p>
        ))}
      </div>
    );
  }
}