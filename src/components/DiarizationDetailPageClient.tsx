"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import WaveSurfer from "wavesurfer.js";
import { useTheme } from "next-themes";
import {
  ArrowLeft,
  Copy,
  Download,
  FileText,
  Loader2,
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  getAsrSegments,
  getDb,
  replaceAsrSegments,
  saveSpeakerTurns,
  getSpeakerTurns,
  getTranscription,
  updateTranscription,
  type AsrSegment,
  type SpeakerTurn,
  type Transcription,
} from "@/lib/transcriptionDb";
import { showToast } from "@/lib/toast";

type ExportFormat = "json" | "srt" | "vtt" | "txt" | "pdf";

type DiarizedDisplaySegment = {
  start: number;
  end: number;
  speaker: string;
  clusterId?: string;
  text: string;
};

function normalizeLocalAudioPath(input: string): string {
  let normalized = input.trim();

  if (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      normalized = normalized.slice(1, -1);
    }
  }

  if (normalized.startsWith("file://")) {
    normalized = normalized.replace(/^file:\/\//, "");

    if (/^\/[A-Za-z]:/.test(normalized)) {
      normalized = normalized.slice(1);
    }

    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // Keep best-effort fallback path when URI decoding fails.
    }
  }

  return normalized;
}

function normalizeSpeakerTurns(turns: SpeakerTurn[]): SpeakerTurn[] {
  const sorted = [...turns]
    .filter((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end) && turn.end > turn.start)
    .sort((a, b) => a.start - b.start);

  const normalized: SpeakerTurn[] = [];

  for (const turn of sorted) {
    const current = { ...turn };

    if (normalized.length === 0) {
      normalized.push(current);
      continue;
    }

    const last = normalized[normalized.length - 1];
    if (current.start < last.end) {
      if (current.end <= last.end) {
        continue;
      }
      current.start = last.end;
    }

    if (current.end <= current.start) {
      continue;
    }

    if (last.clusterId === current.clusterId && current.start - last.end <= 0.08) {
      last.end = Math.max(last.end, current.end);
      continue;
    }

    normalized.push(current);
  }

  return normalized;
}

function overlapDuration(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function buildDiarizedSegments(asrSegments: AsrSegment[], turns: SpeakerTurn[]): DiarizedDisplaySegment[] {
  const normalizedTurns = normalizeSpeakerTurns(turns);

  return asrSegments.map((seg) => {
    const bestTurn = normalizedTurns
      .map((turn) => ({
        turn,
        overlap: overlapDuration(seg.start, seg.end, turn.start, turn.end),
      }))
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)[0]?.turn;

    return {
      start: seg.start,
      end: seg.end,
      speaker: bestTurn?.displayName || bestTurn?.clusterId || "UNKNOWN",
      clusterId: bestTurn?.clusterId,
      text: seg.text,
    };
  });
}

export default function DiarizationDetailPageClient({
  params,
  autoRun = false,
  modelName,
}: {
  params: { id: string };
  autoRun?: boolean;
  modelName?: string;
}) {
  const id = params.id;
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [transcription, setTranscription] = useState<Transcription | null>(null);
  const [asrSegments, setAsrSegments] = useState<AsrSegment[]>([]);
  const [speakerTurns, setSpeakerTurns] = useState<SpeakerTurn[]>([]);

  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("srt");
  const [runningPipeline, setRunningPipeline] = useState(false);
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({});
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [editSpeakerValue, setEditSpeakerValue] = useState("");
  const [selectedSpeakerFilter, setSelectedSpeakerFilter] = useState<string>("all");
  const autoRunTriggeredRef = useRef(false);
  const displaySegmentsRef = useRef<DiarizedDisplaySegment[]>([]);
  const lastAutoScrolledSegmentRef = useRef<string | null>(null);

  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const loadData = async () => {
      try {
        const trans = await getTranscription(id);
        if (!trans) {
          setNotFound(true);
          return;
        }

        const [asr, turns] = await Promise.all([getAsrSegments(id), getSpeakerTurns(id)]);

        setTranscription(trans);
        setAsrSegments(asr);
        setSpeakerTurns(turns);
      } catch (err) {
        console.error("Failed to load diarization detail:", err);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    };

  useEffect(() => {
    void loadData();
  }, [id]);

  useEffect(() => {
    const runPipeline = async () => {
      if (!autoRun || autoRunTriggeredRef.current) return;
      if (!transcription?.audioPath) return;

      autoRunTriggeredRef.current = true;
      setRunningPipeline(true);

      try {
        const availableModels = await invoke<string[]>("list_downloaded_diar_models");
        const pickedModel = modelName || availableModels[0];
        if (pickedModel) {
          await invoke("set_active_diar_model", { modelName: pickedModel });
        } else {
          throw new Error("No diarization model available");
        }

        const response = await invoke<{
          diarization_model: string;
          full_text: string;
          segments: Array<{ start_ms: number; end_ms: number; speaker: string; text: string }>;
        }>("parakeet_diarize_then_transcribe_segments", {
          mediaPath: transcription.audioPath,
          forceCpu: false,
        });

        const now = new Date().toISOString();
        const mappedAsr = response.segments.map((seg) => ({
          start: seg.start_ms / 1000,
          end: seg.end_ms / 1000,
          text: seg.text.trim(),
        }));
        const mappedTurns = response.segments.map((seg) => ({
          start: seg.start_ms / 1000,
          end: seg.end_ms / 1000,
          clusterId: seg.speaker,
          displayName: seg.speaker,
        }));

        await replaceAsrSegments(id, mappedAsr);
        await saveSpeakerTurns(id, mappedTurns, response.diarization_model);
        await updateTranscription(id, {
          fullText: response.full_text.trim(),
          whisperModel: "parakeet-tdt",
          whisperTimestamp: now,
          diarizationModel: response.diarization_model,
          diarizationTimestamp: now,
        });

        showToast("Diarization completed", "success");
        await loadData();
      } catch (err: any) {
        console.error("Auto diarization pipeline failed:", err);
        showToast(err?.message || "Failed to run diarization", "error");
      } finally {
        setRunningPipeline(false);
      }
    };

    void runPipeline();
  }, [autoRun, id, transcription?.audioPath, modelName]);

  const displaySegments = useMemo(
    () => buildDiarizedSegments(asrSegments, speakerTurns),
    [asrSegments, speakerTurns]
  );

  useEffect(() => {
    displaySegmentsRef.current = displaySegments;
  }, [displaySegments]);

  const getSegmentDomId = (segment: DiarizedDisplaySegment) => {
    const raw = `${segment.start}-${segment.end}-${segment.clusterId || segment.speaker}`;
    return `diar-segment-${raw.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  };

  useEffect(() => {
    setSpeakerMap((prev) => {
      const next = { ...prev };
      for (const turn of speakerTurns) {
        if (!turn.clusterId) continue;
        next[turn.clusterId] = turn.displayName || next[turn.clusterId] || turn.clusterId;
      }
      return next;
    });
  }, [speakerTurns]);

  const speakerFilterOptions = useMemo(() => {
    const names = new Set<string>();
    for (const segment of displaySegments) {
      if (segment.clusterId) {
        names.add(speakerMap[segment.clusterId] || segment.speaker);
      } else {
        names.add(segment.speaker);
      }
    }
    return Array.from(names);
  }, [displaySegments, speakerMap]);

  const filteredSegments = useMemo(() => {
    return displaySegments.filter((s) => {
      const speakerName = s.clusterId ? speakerMap[s.clusterId] || s.speaker : s.speaker;
      const matchSpeaker = selectedSpeakerFilter === "all" || speakerName === selectedSpeakerFilter;
      const matchSearch = !search.trim() || s.text.toLowerCase().includes(search.toLowerCase());
      return matchSpeaker && matchSearch;
    });
  }, [displaySegments, search, selectedSpeakerFilter, speakerMap]);

  const saveSpeakerEdit = async () => {
    if (!editingSpeaker || !transcription?.id) return;

    const newName = editSpeakerValue.trim();
    if (!newName) {
      setEditingSpeaker(null);
      setEditSpeakerValue("");
      return;
    }

    try {
      setSpeakerMap((prev) => ({ ...prev, [editingSpeaker]: newName }));

      const db = await getDb();
      await db.execute(
        `UPDATE speaker_turns
         SET display_name = ?
         WHERE transcription_id = ? AND cluster_id = ?`,
        [newName, transcription.id, editingSpeaker]
      );

      const refreshedTurns = await getSpeakerTurns(transcription.id);
      setSpeakerTurns(refreshedTurns);

      showToast(`Speaker renamed to "${newName}"`, "success");
    } catch (err) {
      console.error("Failed to rename speaker:", err);
      showToast("Failed to rename speaker", "error");
    } finally {
      setEditingSpeaker(null);
      setEditSpeakerValue("");
    }
  };

  useEffect(() => {
    if (!waveformRef.current || !transcription?.audioPath) return;

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: "#4f46e5",
      progressColor: "#ec4899",
      cursorColor: "#c084fc",
      barWidth: 3,
      barGap: 2,
      height: 96,
      normalize: true,
      backend: "MediaElement",
    });

    wavesurferRef.current = ws;

    const init = async () => {
      try {
        let audioUrl: string;

        try {
          audioUrl = await invoke<string>("serve_audio_file", { path: transcription.audioPath });
        } catch (serveErr) {
          console.warn("serve_audio_file failed, falling back to convertFileSrc", serveErr);
          const localPath = normalizeLocalAudioPath(transcription.audioPath);
          audioUrl = convertFileSrc(localPath);
        }

        ws.load(audioUrl);
        ws.on("ready", () => setDuration(ws.getDuration()));
        ws.on("play", () => setIsPlaying(true));
        ws.on("pause", () => setIsPlaying(false));
        ws.on("finish", () => setIsPlaying(false));
        ws.on("audioprocess", (time) => {
          setCurrentTime(time);

          const activeSegment = displaySegmentsRef.current.find(
            (segment) => time >= segment.start && time < segment.end
          );

          if (!activeSegment) {
            return;
          }

          const activeId = getSegmentDomId(activeSegment);
          if (lastAutoScrolledSegmentRef.current === activeId) {
            return;
          }

          const el = document.getElementById(activeId);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            lastAutoScrolledSegmentRef.current = activeId;
          }
        });
      } catch (err) {
        console.error("Failed to load waveform audio:", err);
        showToast("Could not load audio file", "error");
      }
    };

    void init();

    return () => {
      ws.destroy();
      wavesurferRef.current = null;
    };
  }, [transcription?.audioPath]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const formatSrtTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s
      .toString()
      .padStart(2, "0")},${ms.toString().padStart(3, "0")}`;
  };

  const formatVttTime = (seconds: number) => formatSrtTime(seconds).replace(",", ".");

  const saveBlob = async (blob: Blob, filename: string, description: string) => {
    if ("showSaveFilePicker" in window) {
      try {
        const ext = filename.includes(".") ? filename.substring(filename.lastIndexOf(".")) : ".txt";
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: filename,
          types: [{ description, accept: { [blob.type || "application/octet-stream"]: [ext] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (err: any) {
        if (err?.name === "AbortError") return;
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExport = async (format: ExportFormat) => {
    if (!displaySegments.length) {
      showToast("No segments available to export", "info");
      return;
    }

    const baseName =
      transcription?.filename?.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_") ||
      "diarization";

    const rows = displaySegments.map((seg, index) => ({
      index: index + 1,
      start: seg.start,
      end: seg.end,
      startSrt: formatSrtTime(seg.start),
      endSrt: formatSrtTime(seg.end),
      startVtt: formatVttTime(seg.start),
      endVtt: formatVttTime(seg.end),
      speaker: seg.speaker,
      text: seg.text.trim(),
    }));

    try {
      if (format === "json") {
        const payload = {
          transcriptionId: transcription?.id,
          title: transcription?.title || transcription?.filename,
          generatedAt: new Date().toISOString(),
          segments: rows,
        };
        await saveBlob(
          new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }),
          `${baseName}.json`,
          "JSON file"
        );
      } else if (format === "srt") {
        const content = rows
          .map((r) => `${r.index}\n${r.startSrt} --> ${r.endSrt}\n[${r.speaker}] ${r.text}\n`)
          .join("\n");
        await saveBlob(new Blob([content], { type: "text/plain;charset=utf-8" }), `${baseName}.srt`, "SubRip subtitle");
      } else if (format === "vtt") {
        const body = rows
          .map((r) => `${r.index}\n${r.startVtt} --> ${r.endVtt}\n<${r.speaker}> ${r.text}\n`)
          .join("\n");
        await saveBlob(new Blob([`WEBVTT\n\n${body}`], { type: "text/vtt;charset=utf-8" }), `${baseName}.vtt`, "WebVTT subtitle");
      } else if (format === "txt") {
        const content = rows
          .map((r) => `[${r.startSrt} - ${r.endSrt}] [${r.speaker}] ${r.text}`)
          .join("\n");
        await saveBlob(new Blob([content], { type: "text/plain;charset=utf-8" }), `${baseName}.txt`, "Text file");
      } else if (format === "pdf") {
        const { jsPDF } = await import("jspdf");
        const doc = new jsPDF({ unit: "pt", format: "a4" });
        const margin = 48;
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const maxWidth = pageWidth - margin * 2;
        let y = margin;

        doc.setFontSize(14);
        doc.text(transcription?.title || transcription?.filename || "Diarization", margin, y);
        y += 24;
        doc.setFontSize(10);

        for (const row of rows) {
          const line = `[${row.startSrt} - ${row.endSrt}] [${row.speaker}] ${row.text}`;
          const wrapped = doc.splitTextToSize(line, maxWidth);
          if (y + wrapped.length * 14 > pageHeight - margin) {
            doc.addPage();
            y = margin;
          }
          doc.text(wrapped, margin, y);
          y += wrapped.length * 14 + 8;
        }

        await saveBlob(doc.output("blob"), `${baseName}.pdf`, "PDF document");
      }

      showToast(`Exported ${format.toUpperCase()} successfully`, "success");
    } catch (err) {
      console.error("Export failed:", err);
      showToast(`Failed to export ${format.toUpperCase()}`, "error");
    }
  };

  if (!mounted) return null;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-pink-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (notFound || !transcription) {
    return (
      <div className="min-h-screen p-8">
        <p className="text-center text-zinc-500">Diarization entry not found</p>
      </div>
    );
  }

  return (
    <div className={`min-h-screen p-8 lg:p-12 ${isDark ? "bg-zinc-950 text-white" : "bg-gray-50 text-gray-900"}`}>
      <div className="max-w-7xl mx-auto">
        <Link
          href="/diarization"
          className="inline-flex items-center gap-2 text-zinc-500 hover:text-zinc-900 dark:hover:text-white font-semibold mb-8"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Diarization
        </Link>

        <header className="mb-8">
          <h1 className="text-4xl font-black tracking-tight">{transcription.title || transcription.filename}</h1>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">
            Speaker diarization detail with waveform, segment timeline, and exports.
          </p>
          {runningPipeline && (
            <p className="mt-3 inline-flex items-center gap-2 text-sm text-pink-500 font-semibold">
              <Loader2 className="w-4 h-4 animate-spin" />
              Running diarization pipeline...
            </p>
          )}
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className={`rounded-3xl border p-6 ${isDark ? "bg-zinc-900/70 border-zinc-800" : "bg-white border-gray-200"}`}>
            <h2 className="text-2xl font-bold mb-4 inline-flex items-center gap-2">
              <Play className="w-5 h-5 text-pink-500" />
              Waveform
            </h2>

            <div ref={waveformRef} className={`rounded-xl border ${isDark ? "bg-zinc-950 border-zinc-800" : "bg-gray-100 border-gray-200"}`} />

            <div className="mt-5 flex items-center justify-between">
              <div className="text-sm font-mono text-zinc-500">
                {formatTime(currentTime)} / {formatTime(duration || transcription.duration || 0)}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => wavesurferRef.current?.skip(-10)} className="p-2 rounded-lg hover:bg-zinc-200/30">
                  <SkipBack className="w-5 h-5" />
                </button>
                <button
                  onClick={() => wavesurferRef.current?.playPause()}
                  className="w-12 h-12 rounded-full bg-pink-600 hover:bg-pink-700 text-white flex items-center justify-center"
                >
                  {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
                </button>
                <button onClick={() => wavesurferRef.current?.skip(10)} className="p-2 rounded-lg hover:bg-zinc-200/30">
                  <SkipForward className="w-5 h-5" />
                </button>
                <button
                  onClick={() => {
                    if (!wavesurferRef.current) return;
                    const nextMuted = !isMuted;
                    wavesurferRef.current.setMuted(nextMuted);
                    setIsMuted(nextMuted);
                  }}
                  className="p-2 rounded-lg hover:bg-zinc-200/30"
                >
                  {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                </button>
              </div>
            </div>
          </div>

          <div className={`rounded-3xl border p-6 ${isDark ? "bg-zinc-900/70 border-zinc-800" : "bg-white border-gray-200"}`}>
            <div className="flex items-center justify-between mb-4 gap-3">
              <h2 className="text-2xl font-bold inline-flex items-center gap-2">
                <FileText className="w-5 h-5 text-pink-500" />
                Segments
              </h2>
              <div className="flex items-center gap-2">
                <select
                  value={selectedSpeakerFilter}
                  onChange={(e) => setSelectedSpeakerFilter(e.target.value)}
                  className={`px-3 py-2 rounded-lg border text-sm ${isDark ? "bg-zinc-800 border-zinc-700" : "bg-white border-gray-300"}`}
                >
                  <option value="all">All Speakers</option>
                  {speakerFilterOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search segments..."
                    className={`pl-9 pr-3 py-2 rounded-lg border ${isDark ? "bg-zinc-800 border-zinc-700" : "bg-white border-gray-300"}`}
                  />
                </div>
              </div>
            </div>

            <div className="max-h-130 overflow-y-auto space-y-3 pr-1">
              {filteredSegments.map((segment, index) => {
                const active = currentTime >= segment.start && currentTime < segment.end;
                const speakerName = segment.clusterId ? speakerMap[segment.clusterId] || segment.speaker : segment.speaker;
                return (
                  <div
                    key={`${segment.start}-${segment.end}-${index}`}
                    id={getSegmentDomId(segment)}
                    className={`p-4 rounded-xl border ${
                      active
                        ? isDark
                          ? "bg-pink-900/30 border-pink-500"
                          : "bg-pink-100 border-pink-300"
                        : isDark
                          ? "bg-zinc-800/60 border-zinc-700"
                          : "bg-gray-50 border-gray-200"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      {editingSpeaker && segment.clusterId === editingSpeaker ? (
                        <div className="flex items-center gap-2">
                          <input
                            value={editSpeakerValue}
                            onChange={(e) => setEditSpeakerValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void saveSpeakerEdit();
                              if (e.key === "Escape") {
                                setEditingSpeaker(null);
                                setEditSpeakerValue("");
                              }
                            }}
                            className={`px-2 py-1 text-xs rounded border ${isDark ? "bg-zinc-700 border-zinc-600" : "bg-white border-gray-300"}`}
                            autoFocus
                          />
                          <button
                            onClick={() => void saveSpeakerEdit()}
                            className="text-xs px-2 py-1 rounded bg-green-600 text-white"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => {
                              setEditingSpeaker(null);
                              setEditSpeakerValue("");
                            }}
                            className="text-xs px-2 py-1 rounded bg-zinc-600 text-white"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            if (!segment.clusterId) return;
                            setEditingSpeaker(segment.clusterId);
                            setEditSpeakerValue(speakerName);
                          }}
                          className="text-xs font-semibold px-2 py-1 rounded bg-pink-600 text-white"
                        >
                          {speakerName}
                        </button>
                      )}
                      <span className="text-xs font-mono text-zinc-500">
                        {formatTime(segment.start)} - {formatTime(segment.end)}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed">{segment.text}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className={`sticky bottom-0 mt-8 p-5 rounded-2xl border backdrop-blur ${isDark ? "bg-zinc-950/90 border-zinc-800" : "bg-white/90 border-gray-200"}`}>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(transcription.fullText || "");
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
              className="px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white inline-flex items-center gap-2"
            >
              <Copy className="w-4 h-4" />
              {copied ? "Copied" : "Copy Text"}
            </button>

            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              className={`px-4 py-2.5 rounded-xl border ${isDark ? "bg-zinc-800 border-zinc-700" : "bg-white border-gray-300"}`}
            >
              <option value="json">JSON</option>
              <option value="srt">SRT</option>
              <option value="vtt">VTT</option>
              <option value="txt">TXT</option>
              <option value="pdf">PDF</option>
            </select>

            <button
              onClick={() => handleExport(exportFormat)}
              className="px-5 py-2.5 rounded-xl bg-pink-600 hover:bg-pink-700 text-white inline-flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              Export {exportFormat.toUpperCase()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
