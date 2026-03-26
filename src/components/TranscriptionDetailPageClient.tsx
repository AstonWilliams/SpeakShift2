"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { listen } from '@tauri-apps/api/event';
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
    ArrowLeft,
    Search,
    Copy,
    Download,
    RefreshCw,
    Play,
    Pause,
    Volume2,
    VolumeX,
    Youtube,
    Mic,
    FileText,
    AlertTriangle,
    CheckCircle,
    Clock,
    SkipBack,
    SkipForward,
    Upload,
    Users,
    Check,
    Edit2,
    X,
    ChevronDown,
    Loader2,
    Languages,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
    getTranscription,
    getAsrSegments,
    getSpeakerTurns,
    saveSpeakerTurns,
    saveTranscription,           // if you want to save renaming from UI
    type Transcription,
    type AsrSegment,
    type SpeakerTurn,
    getDb,
    updateTranscription,
} from "@/lib/transcriptionDb";
import { showToast } from "@/lib/toast";
import WaveSurfer from "wavesurfer.js";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

type DisplaySegment = {
    start: number;
    end: number;
    speaker?: string;
    text: string;
    clusterId?: string;
};

type ExportFormat = "json" | "srt" | "vtt" | "txt" | "pdf" | "docx" | "csv" | "tsv" | "md";

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

function splitWordsByWeights(words: string[], weights: number[]): string[] {
    if (weights.length === 0) return [];

    const safeWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
    const totalWeight = safeWeights.reduce((sum, w) => sum + w, 0);

    if (totalWeight <= 0 || words.length === 0) {
        return safeWeights.map(() => "");
    }

    const rawCounts = safeWeights.map((w) => (w / totalWeight) * words.length);
    const counts = rawCounts.map((v) => Math.floor(v));

    let remaining = words.length - counts.reduce((sum, c) => sum + c, 0);

    const remainderOrder = rawCounts
        .map((v, i) => ({ i, r: v - Math.floor(v) }))
        .sort((a, b) => b.r - a.r);

    for (let k = 0; k < remainderOrder.length && remaining > 0; k += 1) {
        counts[remainderOrder[k].i] += 1;
        remaining -= 1;
    }

    const chunks: string[] = [];
    let cursor = 0;
    for (const count of counts) {
        const next = cursor + Math.max(0, count);
        chunks.push(words.slice(cursor, next).join(" ").trim());
        cursor = next;
    }

    if (cursor < words.length && chunks.length > 0) {
        chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${words.slice(cursor).join(" ")}`.trim();
    }

    return chunks;
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
            if (!last.displayName && current.displayName) {
                last.displayName = current.displayName;
            }
            continue;
        }

        normalized.push(current);
    }

    return normalized;
}

function buildDisplaySegments(
    asrSegments: AsrSegment[],
    speakerTurns: SpeakerTurn[],
    fullText?: string
): DisplaySegment[] {
    const normalizedTurns = normalizeSpeakerTurns(speakerTurns);

    if (normalizedTurns.length === 0) {
        return asrSegments.map((s) => ({
            start: s.start,
            end: s.end,
            text: s.text,
            speaker: undefined,
            clusterId: undefined,
        }));
    }

    const sortedTurns = normalizedTurns;
    // Diarization-first timeline: ignore Whisper timestamps and distribute transcript text by turn duration.
    const sourceText = (fullText || asrSegments.map((s) => s.text).join(" ")).trim();
    const words = sourceText.split(/\s+/).filter(Boolean);
    const durations = sortedTurns.map((turn) => Math.max(0.05, turn.end - turn.start));
    const chunks = splitWordsByWeights(words, durations);

    return sortedTurns.map((turn, idx) => {
        const mergedText = (chunks[idx] || "").replace(/\s+/g, " ").trim();
        return {
            start: turn.start,
            end: turn.end,
            text: mergedText || "[no transcript text assigned]",
            speaker: turn.clusterId,
            clusterId: turn.clusterId,
        };
    });
}

function extractYouTubeId(url: string): string | null {
    if (!url || typeof url !== "string") return null;

    // Common patterns — order matters somewhat (more specific first)
    const patterns = [
        // youtu.be short link
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/i,

        // Classic watch?v= (with or without www, https, extra params)
        /(?:youtube(?:-nocookie)?\.com\/watch(?:\.php)?\?.*?v=)([a-zA-Z0-9_-]{11})/i,

        // embed, v/, shorts/, live/, e/
        /(?:youtube(?:-nocookie)?\.com\/)(?:embed\/|v\/|shorts\/|live\/|e\/)([a-zA-Z0-9_-]{11})/i,

        // Rare /user/.../v/ style or other paths
        /(?:youtube(?:-nocookie)?\.com\/[^#?]*\/)([a-zA-Z0-9_-]{11})(?:[#?]|$)/i,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1].length === 11) {
            return match[1];
        }
    }

    return null;
}

export default function TranscriptionDetailPage({ params }: { params: { id: string } }) {
    const t = useTranslations();

    const { resolvedTheme } = useTheme();
    const isDark = resolvedTheme === "dark";
    const router = useRouter();
    const id = params.id as string;

    const [mounted, setMounted] = useState(false);
    const [transcription, setTranscription] = useState<Transcription | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [search, setSearch] = useState("");
    const [copied, setCopied] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const videoRef = useRef<HTMLIFrameElement>(null);
    const [isDiarizing, setIsDiarizing] = useState(false);
    const [diarizationError, setDiarizationError] = useState<string | null>(null);

    // New states for speaker editing & filtering
    const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({}); // e.g. { "SPEAKER_01": "Mike" }
    const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
    const [editSpeakerValue, setEditSpeakerValue] = useState("");
    const [selectedSpeakerFilter, setSelectedSpeakerFilter] = useState<string>("all");

    const audioRef = useRef<HTMLAudioElement>(null);
    const wavesurferRef = useRef<WaveSurfer | null>(null);
    const waveformRef = useRef<HTMLDivElement>(null);
    const segmentsRef = useRef<HTMLDivElement>(null);

    const [diarModels, setDiarModels] = useState<string[]>([]);
    const [selectedDiarModel, setSelectedDiarModel] = useState<string | null>(null);
    const [showDiarModelSelector, setShowDiarModelSelector] = useState(false);
    const [showDiarizeDialog, setShowDiarizeDialog] = useState(false);
    const [diarLoading, setDiarLoading] = useState(false);
    const [diarError, setDiarError] = useState<string | null>(null);

    const [asrSegments, setAsrSegments] = useState<AsrSegment[]>([]);
    const [speakerTurns, setSpeakerTurns] = useState<SpeakerTurn[]>([]);
    const [displaySegments, setDisplaySegments] = useState<DisplaySegment[]>([]);
    const displaySegmentsRef = useRef<DisplaySegment[]>([]);
    const [hasTranslation, setHasTranslation] = useState<boolean>(false);
    const [exportFormat, setExportFormat] = useState<ExportFormat>("srt");

    useEffect(() => {
        setMounted(true);
        loadTranscription();
        loadDiarModels();
    }, [id]);

    useEffect(() => {
        displaySegmentsRef.current = displaySegments;
    }, [displaySegments]);

    useEffect(() => {
        // Ensure newly diarized speakers appear in UI immediately, even before manual rename.
        setSpeakerMap((prev) => {
            const next = { ...prev };
            for (const turn of speakerTurns) {
                if (!turn.clusterId) continue;
                if (!next[turn.clusterId]) {
                    next[turn.clusterId] = turn.displayName || turn.clusterId;
                } else if (turn.displayName) {
                    next[turn.clusterId] = turn.displayName;
                }
            }
            return next;
        });
    }, [speakerTurns]);

    const loadTranscription = async () => {
        try {
            const data = await getTranscription(id);
            if (data) {
                setTranscription(data);
            } else {
                setNotFound(true);
            }
        } catch (error) {
            console.error("Failed to load transcription:", error);
            setNotFound(true);
        } finally {
            setLoading(false);
        }
    };

    const loadDiarModels = async () => {
        try {
            const models: string[] = await invoke("list_downloaded_diar_models");
            setDiarModels(models);
            // Optional: auto-select first one or last used
            if (models.length > 0 && !selectedDiarModel) {
                setSelectedDiarModel(models[0]);
            }
        } catch (err) {
            console.error("Failed to load diarization models:", err);
            showToast("Could not load speaker models", "error");
        }
    };

    // Load transcription
    useEffect(() => {
        const loadData = async () => {
            try {
                const trans = await getTranscription(id);
                if (!trans) {
                    setNotFound(true);
                    return;
                }
                setTranscription(trans);

                const [asr, turns] = await Promise.all([
                    getAsrSegments(id),
                    getSpeakerTurns(id),
                ]);

                setAsrSegments(asr);
                setSpeakerTurns(turns);

                // Initialize speaker map from clusterIds (raw labels)
                const uniqueClusters = [...new Set(turns.map(t => t.clusterId))];
                const initialMap: Record<string, string> = {};
                uniqueClusters.forEach(c => {
                    if (c) initialMap[c] = c; // default to itself
                });
                // If you have display_names already, prefer those
                turns.forEach(t => {
                    if (t.clusterId && t.displayName) {
                        initialMap[t.clusterId] = t.displayName;
                    }
                });
                setSpeakerMap(initialMap);

            } catch (err) {
                console.error("Failed to load data:", err);
                showToast("Failed to load transcription", "error");
            } finally {
                setLoading(false);
            }
        };

        loadData();
    }, [id]);

    // Initialize WaveSurfer
    useEffect(() => {
        if (!waveformRef.current || !transcription?.audioPath) return;
        const audioPath = transcription.audioPath;

        const initWaveSurfer = async () => {
            const ws = WaveSurfer.create({
                container: waveformRef.current!,
                waveColor: '#4f46e5',
                progressColor: '#a78bfa',
                cursorColor: '#c084fc',
                barWidth: 3,
                barGap: 2,
                height: 100,
                normalize: true,
                backend: 'MediaElement',
            });

            try {
                let audioUrl: string;

                try {
                    audioUrl = await invoke<string>("serve_audio_file", {
                        path: audioPath,
                    });
                } catch (serveErr) {
                    console.warn("serve_audio_file failed, falling back to convertFileSrc", serveErr);
                    const localPath = normalizeLocalAudioPath(audioPath);
                    audioUrl = convertFileSrc(localPath);
                }

                ws.load(audioUrl);

                ws.on('ready', () => {
                    setDuration(ws.getDuration());
                });

                ws.on('play', () => setIsPlaying(true));
                ws.on('pause', () => setIsPlaying(false));
                ws.on('finish', () => setIsPlaying(false));

                ws.on('audioprocess', (time) => {
                    setCurrentTime(time);

                    // Use ref so this handler does not force WaveSurfer recreation on every segment update.
                    const currentSegment = displaySegmentsRef.current.find(
                        s => time >= s.start && time < s.end
                    );

                    if (currentSegment && segmentsRef.current) {
                        const element = document.getElementById(`segment-${currentSegment.start}`);
                        if (element) {
                            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                });
            } catch (err) {
                console.error("Failed to load audio:", err);
                showToast("Could not load audio file", "error");
            }

            wavesurferRef.current = ws;
        };

        initWaveSurfer();

        return () => {
            if (wavesurferRef.current) {
                wavesurferRef.current.destroy();
                wavesurferRef.current = null;
            }
        };
    }, [transcription?.audioPath]);

    const togglePlay = () => {
        if (wavesurferRef.current) {
            wavesurferRef.current.playPause();
        }
    };

    // Compute what to actually render
    useEffect(() => {
        // Detail page intentionally renders raw ASR segments only.
        const merged = asrSegments.map((segment) => ({
            start: segment.start,
            end: segment.end,
            text: segment.text,
            speaker: undefined,
            clusterId: undefined,
        }));
        setDisplaySegments(merged);
    }, [asrSegments]);

    const normalizedSpeakerTurns = normalizeSpeakerTurns(speakerTurns);

    const speakerFilterOptions = Array.from(
        new Set(
            normalizedSpeakerTurns
                .map((turn) => turn.clusterId)
                .filter((clusterId): clusterId is string => Boolean(clusterId))
                .map((clusterId) => speakerMap[clusterId] || clusterId)
        )
    );

    useEffect(() => {
        if (selectedSpeakerFilter === "all") return;
        if (!speakerFilterOptions.includes(selectedSpeakerFilter)) {
            setSelectedSpeakerFilter("all");
        }
    }, [selectedSpeakerFilter, speakerFilterOptions]);

    // Global speaker rename
    // ────────────────────────────────────────────────
    // Speaker rename – now updates speaker_turns
    // ────────────────────────────────────────────────
    const startEditingSpeaker = (clusterId: string) => {
        setEditingSpeaker(clusterId);
        setEditSpeakerValue(speakerMap[clusterId] || clusterId);
    };

    const saveSpeakerEdit = async () => {
        if (!editingSpeaker || !transcription?.id) return;

        const newName = editSpeakerValue.trim();
        if (!newName || newName === speakerMap[editingSpeaker]) {
            setEditingSpeaker(null);
            return;
        }

        try {
            // 1. Update local map (for UI)
            setSpeakerMap(prev => ({
                ...prev,
                [editingSpeaker]: newName
            }));

            // 2. Update ALL turns in DB that have this cluster_id
            const db = await getDb();
            await db.execute(
                `UPDATE speaker_turns 
       SET display_name = ? 
       WHERE transcription_id = ? AND cluster_id = ?`,
                [newName, transcription.id, editingSpeaker]
            );

            // 3. Reload fresh turns from DB
            const freshTurns = await getSpeakerTurns(transcription.id);
            setSpeakerTurns(freshTurns);

            showToast(`Speaker renamed to "${newName}"`, "success");
        } catch (err) {
            console.error("Failed to save speaker name:", err);
            showToast("Failed to save speaker name", "error");
        }

        setEditingSpeaker(null);
        setEditSpeakerValue("");
    };

    const handleCopy = async () => {
        if (!transcription?.fullText) return;
        await navigator.clipboard.writeText(transcription.fullText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const formatSRTTimestamp = (seconds: number): string => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.round((seconds % 1) * 1000);

        return `${hours.toString().padStart(2, "0")}:${mins
            .toString()
            .padStart(2, "0")}:${secs.toString().padStart(2, "0")},${ms
                .toString()
                .padStart(3, "0")}`;
    };

    const formatVTTTimestamp = (seconds: number): string => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.round((seconds % 1) * 1000);

        return `${hours.toString().padStart(2, "0")}:${mins
            .toString()
            .padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${ms
                .toString()
                .padStart(3, "0")}`;
    };

    const saveBlob = async (blob: Blob, filename: string, description: string) => {
        if ("showSaveFilePicker" in window) {
            try {
                const ext = filename.includes(".") ? filename.substring(filename.lastIndexOf(".")) : ".txt";
                const handle = await (window as any).showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description,
                        accept: { [blob.type || "application/octet-stream"]: [ext] },
                    }],
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return;
            } catch (err: any) {
                if (err?.name !== "AbortError") {
                    console.warn("Save picker failed, falling back to download", err);
                } else {
                    throw err;
                }
            }
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const handleExport = async (format: ExportFormat) => {
        if (displaySegments.length === 0) {
            showToast("No segments available to export", "info");
            return;
        }

        const baseName = transcription?.filename
            ?.replace(/\.[^/.]+$/, "")
            ?.replace(/[^a-zA-Z0-9]/g, "_") || "transcription";
        const rows = displaySegments.map((seg, index) => {
            const speaker = seg.speaker ? (speakerMap[seg.speaker] || seg.speaker) : "Unknown";
            return {
                index: index + 1,
                start: seg.start,
                end: seg.end,
                startSrt: formatSRTTimestamp(seg.start),
                endSrt: formatSRTTimestamp(seg.end),
                startVtt: formatVTTTimestamp(seg.start),
                endVtt: formatVTTTimestamp(seg.end),
                speaker,
                text: seg.text.trim(),
            };
        });

        try {
            if (format === "json") {
                const payload = {
                    transcriptionId: transcription?.id,
                    title: transcription?.title || transcription?.filename,
                    generatedAt: new Date().toISOString(),
                    segments: rows,
                };
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
                await saveBlob(blob, `${baseName}.json`, "JSON file");
            } else if (format === "srt") {
                const content = rows
                    .map((row) => `${row.index}\n${row.startSrt} --> ${row.endSrt}\n${row.speaker}: ${row.text}\n`)
                    .join("\n");
                const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
                await saveBlob(blob, `${baseName}.srt`, "SubRip subtitle");
            } else if (format === "vtt") {
                const body = rows
                    .map((row) => `${row.index}\n${row.startVtt} --> ${row.endVtt}\n${row.speaker}: ${row.text}\n`)
                    .join("\n");
                const blob = new Blob([`WEBVTT\n\n${body}`], { type: "text/vtt;charset=utf-8" });
                await saveBlob(blob, `${baseName}.vtt`, "WebVTT subtitle");
            } else if (format === "txt") {
                const content = rows
                    .map((row) => `[${row.startSrt} - ${row.endSrt}] [${row.speaker}] ${row.text}`)
                    .join("\n");
                const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
                await saveBlob(blob, `${baseName}.txt`, "Text file");
            } else if (format === "csv") {
                const esc = (value: string) => `"${value.replace(/"/g, '""')}"`;
                const content = [
                    "index,start_seconds,end_seconds,start_srt,end_srt,speaker,text",
                    ...rows.map((row) => [
                        row.index,
                        row.start.toFixed(3),
                        row.end.toFixed(3),
                        esc(row.startSrt),
                        esc(row.endSrt),
                        esc(row.speaker),
                        esc(row.text),
                    ].join(",")),
                ].join("\n");
                const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
                await saveBlob(blob, `${baseName}.csv`, "CSV file");
            } else if (format === "tsv") {
                const sanitize = (value: string) => value.replace(/[\t\n\r]+/g, " ").trim();
                const content = [
                    "index\tstart_seconds\tend_seconds\tstart_srt\tend_srt\tspeaker\ttext",
                    ...rows.map((row) => [
                        row.index,
                        row.start.toFixed(3),
                        row.end.toFixed(3),
                        sanitize(row.startSrt),
                        sanitize(row.endSrt),
                        sanitize(row.speaker),
                        sanitize(row.text),
                    ].join("\t")),
                ].join("\n");
                const blob = new Blob([content], { type: "text/tab-separated-values;charset=utf-8" });
                await saveBlob(blob, `${baseName}.tsv`, "TSV file");
            } else if (format === "md") {
                const escapePipes = (value: string) => value.replace(/\|/g, "\\|").replace(/[\n\r]+/g, " ").trim();
                const tableRows = rows
                    .map(
                        (row) => `| ${row.index} | ${row.startSrt} | ${row.endSrt} | ${escapePipes(row.speaker)} | ${escapePipes(row.text)} |`
                    )
                    .join("\n");
                const content = [
                    `# ${transcription?.title || transcription?.filename || "Transcription"}`,
                    "",
                    "| # | Start | End | Speaker | Text |",
                    "|---:|:------|:----|:--------|:-----|",
                    tableRows,
                ].join("\n");
                const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
                await saveBlob(blob, `${baseName}.md`, "Markdown file");
            } else if (format === "pdf") {
                const { jsPDF } = await import("jspdf");
                const doc = new jsPDF({ unit: "pt", format: "a4" });
                const pageWidth = doc.internal.pageSize.getWidth();
                const pageHeight = doc.internal.pageSize.getHeight();
                const margin = 48;
                const maxWidth = pageWidth - margin * 2;
                let y = margin;

                doc.setFontSize(14);
                doc.text(transcription?.title || transcription?.filename || "Transcription", margin, y);
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

                const blob = doc.output("blob");
                await saveBlob(blob, `${baseName}.pdf`, "PDF document");
            } else if (format === "docx") {
                const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
                const children = [
                    new Paragraph({
                        heading: HeadingLevel.HEADING_1,
                        children: [new TextRun(transcription?.title || transcription?.filename || "Transcription")],
                    }),
                    ...rows.map((row) =>
                        new Paragraph({
                            children: [
                                new TextRun({
                                    text: `[${row.startSrt} - ${row.endSrt}] [${row.speaker}] ${row.text}`,
                                }),
                            ],
                        })
                    ),
                ];

                const doc = new Document({
                    sections: [{ properties: {}, children }],
                });
                const blob = await Packer.toBlob(doc);
                await saveBlob(blob, `${baseName}.docx`, "Word document");
            }

            showToast(`Exported ${format.toUpperCase()} successfully`, "success");
        } catch (err: any) {
            if (err?.name === "AbortError") return;
            console.error(`Export ${format} failed`, err);
            showToast(`Failed to export ${format.toUpperCase()}`, "error");
        }
    };

    const handleRerun = async () => {
        if (!transcription?.sourceUrl || transcription.sourceType !== "youtube") {
            showToast("Re-run is currently only supported for YouTube sources", "info");
            return;
        }

        setIsTranscribing(true);

        try {
            const result = (await invoke("transcribe_youtube", {
                url: transcription.sourceUrl,
                modelName: "base", // TODO: make this dynamic/selectable later
            })) as any; // Replace 'any' with proper type when you define TranscriptionResult interface

            // Properly map segments from backend result
            const newSegments = result.segments?.map((s: any) => ({
                start: s.start_ms / 1000,
                end: s.end_ms / 1000,
                text: s.text.trim(),
                // speaker: s.speaker || undefined, // add when speaker detection is implemented
            })) ?? [];

            // Create updated transcription object
            const saved = await updateTranscription(transcription.id, {
                fullText: result.full_text?.trim() || transcription.fullText,
                whisperTimestamp: new Date().toISOString(),
            });

            if (saved) {
                setTranscription(saved);
                showToast("Re-transcription completed successfully", "success");
            } else {
                showToast("Failed to save the updated transcription", "error");
            }
        } catch (err: any) {
            console.error("Re-run transcription failed:", err);
            showToast(err.message || "Failed to re-transcribe the video", "error");
        } finally {
            setIsTranscribing(false);
        }
    };

    const handleCreateDiarizationEntry = async () => {
        if (!transcription?.audioPath) {
            showToast("No audio file available", "error");
            return;
        }

        if (!selectedDiarModel) {
            showToast("Select a diarization model first", "error");
            return;
        }

        setIsDiarizing(true);
        setDiarError(null);

        try {
            const saved = await saveTranscription({
                filename: `${transcription.filename}_diarized`,
                title: `Diarized - ${transcription.title || transcription.filename}`,
                extension: transcription.extension,
                sourceType: transcription.sourceType,
                sourceUrl: transcription.sourceUrl,
                duration: transcription.duration,
                audioPath: transcription.audioPath,
                fullText: transcription.fullText || "",
                detectedLanguage: transcription.detectedLanguage,
                whisperModel: transcription.whisperModel,
                whisperTimestamp: transcription.whisperTimestamp,
                segments: [],
            });

            setShowDiarizeDialog(false);
            router.push(`/diarization/detail?id=${saved.id}&run=true&model=${encodeURIComponent(selectedDiarModel)}`);
        } catch (err: any) {
            console.error("Failed to create diarization entry:", err);
            setDiarError(err?.message || "Failed to create diarization entry");
            showToast(err?.message || "Failed to create diarization entry", "error");
        } finally {
            setIsDiarizing(false);
        }
    };

    const highlightSearch = (text: string) => {
        if (!search) return text;
        const parts = text.split(new RegExp(`(${search})`, "gi"));
        return parts.map((part, i) =>
            part.toLowerCase() === search.toLowerCase() ? (
                <mark key={i} className="bg-yellow-300 dark:bg-yellow-700 rounded px-1">
                    {part}
                </mark>
            ) : (
                part
            )
        );
    };

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    };

    if (!mounted) return null;

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="w-10 h-10 border-4 border-pink-500 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (notFound) {
        return (
            <div className="min-h-screen p-6 lg:p-12">
                <Link href="/transcriptions">
                    <button className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 dark:hover:text-white font-bold mb-8 transition-colors">
                        <ArrowLeft className="w-5 h-5" />
                        Back to Transcriptions
                    </button>
                </Link>
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col items-center justify-center h-64 text-center"
                >
                    <div className="w-20 h-20 bg-red-100 dark:bg-red-900/30 rounded-3xl flex items-center justify-center mb-6">
                        <AlertTriangle className="w-10 h-10 text-red-500" />
                    </div>
                    <h2 className="text-2xl font-bold mb-2">Transcription Not Found</h2>
                    <p className="text-zinc-500 dark:text-zinc-400 mb-6">
                        This transcription may have been deleted or the file is missing.
                    </p>
                    <Link href="/transcriptions">
                        <button className="px-8 py-4 bg-pink-500 hover:bg-pink-600 text-white rounded-2xl font-bold transition-colors">
                            Go Back
                        </button>
                    </Link>
                </motion.div>
            </div>
        );
    }

    if (!transcription) return null;

    const youtubeId = transcription.sourceType === "youtube" && transcription.sourceUrl
        ? extractYouTubeId(transcription.sourceUrl)
        : null;

    const handleDiarizeSpeakers = async () => {
        if (!transcription?.audioPath) {
            showToast("No audio file available", "error");
            return;
        }

        if (!selectedDiarModel) {
            if (diarModels.length === 0) {
                showToast("No diarization models available. Download one in Settings.", "error");
                return;
            }
            setShowDiarModelSelector(true);
            return;
        }

        setIsDiarizing(true);
        showToast("Identifying speakers...", "info");

        try {
            const result = await invoke<any>("diarize_speakers", {
                audioPath: transcription.audioPath,
                modelName: selectedDiarModel,
            });

            // ─── FIXED: handle direct array return ───────────────────────
            // result is already Vec<DiarizedSegment> → array in JS
            const rawTurns = Array.isArray(result) ? result : (result?.turns || result?.segments || []);

            const turns = rawTurns.map((t: any) => ({
                start: (t.start_ms || t.start || 0) / 1000,
                end: (t.end_ms || t.end || 0) / 1000,
                clusterId:
                    t.speaker ||
                    t.label ||
                    `SPEAKER_${String(t.speaker_id || t.id || 0).padStart(2, "0")}`,
                confidence: t.confidence,
                displayName: undefined,
            }));

            if (turns.length === 0) {
                throw new Error("No speaker turns returned from backend (empty array)");
            }

            console.log(`[DIAR] Received ${turns.length} speaker turns from Rust`);

            // Save
            await saveSpeakerTurns(transcription.id, turns, selectedDiarModel);

            // Reload
            const freshTurns = await getSpeakerTurns(transcription.id);
            setSpeakerTurns(freshTurns);

            showToast(`Speakers identified (${turns.length} turns)!`, "success");
        } catch (err: any) {
            console.error("Diarization failed:", err);
            showToast(err.message || "Failed to identify speakers", "error");
        } finally {
            setIsDiarizing(false);
        }
    };

    // Filtered segments
    const filteredSegments = displaySegments.filter((segment) => {
        if (!search.trim()) return true;
        return segment.text.toLowerCase().includes(search.toLowerCase());
    });

    if (loading) return <div className="p-10 text-center">Loading...</div>;
    if (notFound || !transcription) return <div className="p-10 text-center">Transcription not found</div>;

    const getSpeakerColor = (speaker: string) => {
        const colors = [
            "from-blue-600 to-blue-400",
            "from-green-600 to-green-400",
            "from-purple-600 to-purple-400",
            "from-orange-600 to-orange-400",
            "from-pink-600 to-pink-400",
            "from-indigo-600 to-indigo-400",
        ];
        const index = speaker.charCodeAt(0) % colors.length;
        return colors[index];
    };
    return (
        <>
        <div className={`min-h-screen flex flex-col ${isDark ? "bg-zinc-950 text-white" : "bg-gray-50 text-gray-900"}`}>
            {/* Sticky Header */}
            <div className={`sticky top-0 z-20 backdrop-blur-lg border-b ${isDark ? "bg-zinc-950/90 border-zinc-800" : "bg-white/90 border-gray-200"} px-6 lg:px-12 py-4`}>
                <div className="max-w-7xl mx-auto flex items-center justify-between">
                    <Link href="/transcriptions">
                        <button className={`flex items-center gap-3 font-medium transition-colors ${isDark ? "text-zinc-400 hover:text-white" : "text-gray-600 hover:text-gray-900"}`}>
                            <ArrowLeft className="w-5 h-5" />
                            {t("Back to Transcriptions")}
                        </button>
                    </Link>

                    <span className={`text-sm ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                        {transcription.createdAt.toLocaleDateString("en-US", {
                            weekday: "long",
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                        })}
                    </span>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 overflow-hidden">
                <div className="max-w-7xl mx-auto px-6 lg:px-12 py-8 h-full flex flex-col">
                    {/* Title & Metadata */}
                    <header className="mb-10">
                        <div className="flex items-center gap-5">
                            <div className={`w-20 h-20 rounded-2xl flex items-center justify-center border ${isDark ? "bg-zinc-900/50 border-zinc-700" : "bg-white border-gray-200 shadow-sm"}`}>
                                {transcription.sourceType === "youtube" ? (
                                    <Youtube className="w-10 h-10 text-red-500" />
                                ) : transcription.sourceType === "recording" ? (
                                    <Mic className="w-10 h-10 text-blue-500" />
                                ) : (
                                    <FileText className="w-10 h-10 text-pink-500" />
                                )}
                            </div>
                            <div>
                                <h1 className={`text-4xl lg:text-5xl font-black tracking-tight ${isDark ? "text-white" : "text-gray-900"}`}>
                                    {transcription.title || transcription.filename}.{transcription.extension}
                                </h1>
                                <p className={`mt-3 flex items-center gap-4 text-lg ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                                    <Clock className="w-5 h-5" />
                                    {t("Transcribed on")} {transcription.createdAt.toLocaleDateString("en-US", {
                                        weekday: "long",
                                        year: "numeric",
                                        month: "long",
                                        day: "numeric",
                                    })}
                                </p>
                            </div>
                        </div>
                    </header>

                    {/* Two-Column Layout */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 flex-1">
                        {/* LEFT: Audio Waveform + Controls */}
                        <div className={`rounded-3xl border p-8 flex flex-col shadow-sm ${isDark ? "bg-zinc-900/70 border-zinc-800" : "bg-white border-gray-200"}`}>
                            <h2 className={`text-2xl font-bold mb-6 flex items-center gap-3 ${isDark ? "text-white" : "text-gray-900"}`}>
                                <Play className="w-6 h-6 text-pink-500" />
                                {t("Audio Preview")}
                            </h2>

                            {/* Waveform Container */}
                            <div
                                ref={waveformRef}
                                className={`w-full flex-1 rounded-xl overflow-hidden border ${isDark ? "bg-zinc-950 border-zinc-800" : "bg-gray-100 border-gray-200"} ${!transcription?.audioPath ? "flex items-center justify-center text-zinc-500" : ""
                                    }`}
                            >
                                {!transcription?.audioPath && (
                                    <div className="text-center p-8">
                                        <AlertTriangle className="w-12 h-12 mx-auto mb-4 text-yellow-500 opacity-70" />
                                        <p className={`text-lg font-medium ${isDark ? "text-zinc-300" : "text-gray-700"}`}>{t("No audio file available")}</p>
                                        <p className={`text-sm mt-2 ${isDark ? "text-zinc-500" : "text-gray-500"}`}>
                                            {t("The original audio was not saved or is inaccessible")}
                                        </p>
                                    </div>
                                )}
                            </div>

                            {/* Controls */}
                            <div className="mt-6 flex items-center justify-between">
                                <div className={`text-sm font-mono ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                                    {formatTime(currentTime)} / {formatTime(duration || transcription?.duration || 0)}
                                </div>

                                <div className="flex items-center gap-5">
                                    <button
                                        onClick={() => wavesurferRef.current?.skip(-10)}
                                        className={`p-3 rounded-full transition ${isDark ? "hover:bg-zinc-800" : "hover:bg-gray-100"}`}
                                        disabled={!transcription?.audioPath}
                                    >
                                        <SkipBack className="w-5 h-5" />
                                    </button>

                                    <button
                                        onClick={togglePlay}
                                        className={`w-16 h-16 rounded-full flex items-center justify-center transition shadow-md ${transcription?.audioPath
                                            ? "bg-pink-600 hover:bg-pink-700 text-white"
                                            : isDark
                                                ? "bg-zinc-700 text-zinc-400 cursor-not-allowed"
                                                : "bg-gray-200 text-gray-500 cursor-not-allowed"
                                            }`}
                                        disabled={!transcription?.audioPath}
                                    >
                                        {isPlaying ? <Pause className="w-7 h-7" /> : <Play className="w-7 h-7 ml-1" />}
                                    </button>

                                    <button
                                        onClick={() => wavesurferRef.current?.skip(10)}
                                        className={`p-3 rounded-full transition ${isDark ? "hover:bg-zinc-800" : "hover:bg-gray-100"}`}
                                        disabled={!transcription?.audioPath}
                                    >
                                        <SkipForward className="w-5 h-5" />
                                    </button>

                                    <button
                                        onClick={() => {
                                            if (wavesurferRef.current) {
                                                wavesurferRef.current.setMuted(!isMuted);
                                                setIsMuted(!isMuted);
                                            }
                                        }}
                                        className={`p-3 rounded-full transition ${isDark ? "hover:bg-zinc-800" : "hover:bg-gray-100"}`}
                                        disabled={!transcription?.audioPath}
                                    >
                                        {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* RIGHT: Transcription Segments */}
                        <div className={`rounded-3xl border p-8 flex flex-col shadow-sm ${isDark ? "bg-zinc-900/70 border-zinc-800" : "bg-white border-gray-200"} h-130`}>
                            {/* Header with Filter */}
                            <div className="flex items-center justify-between mb-6">
                                <h2 className={`text-2xl font-bold flex items-center gap-3 ${isDark ? "text-white" : "text-gray-900"}`}>
                                    <FileText className="w-6 h-6 text-pink-500" />
                                    {t("Transcription")}
                                </h2>

                                <div className="relative">
                                    <Search className={`w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 ${isDark ? "text-zinc-400" : "text-gray-500"}`} />
                                    <input
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                        placeholder="Search transcript..."
                                        className={`pl-9 pr-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-pink-500 border ${isDark ? "bg-zinc-800 border-zinc-700 text-white" : "bg-white border-gray-300 text-gray-900"}`}
                                    />
                                </div>
                            </div>

                            {/* Scrollable Segments */}
                            <div ref={segmentsRef} className="flex-1 overflow-y-auto pr-2 space-y-4 custom-scrollbar">
                                {filteredSegments.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-full text-center py-12">
                                        <FileText className="w-12 h-12 mb-4 opacity-50" />
                                        <p className={`text-lg font-medium ${isDark ? "text-zinc-300" : "text-gray-700"}`}>
                                            No segments match your search
                                        </p>
                                    </div>
                                ) : (
                                    filteredSegments.map((segment, index) => {
                                        const isActive = currentTime >= segment.start && currentTime < segment.end;

                                        return (
                                            <motion.div
                                                key={index}
                                                id={`segment-${segment.start}`}
                                                initial={{ opacity: 0, y: 10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ delay: index * 0.03 }}
                                                className={`p-5 rounded-2xl transition-all border ${isActive
                                                    ? isDark
                                                        ? "bg-purple-900/40 border-purple-500 shadow-lg"
                                                        : "bg-purple-100 border-purple-400 shadow-lg"
                                                    : isDark
                                                        ? "bg-zinc-800/50 border-zinc-700 hover:border-zinc-600"
                                                        : "bg-gray-50 border-gray-200 hover:border-gray-300"
                                                    }`}
                                            >
                                                <div className="flex items-center justify-between mb-3">
                                                    <div className="text-sm font-semibold text-pink-500">Segment</div>

                                                    <span className={`text-sm font-mono ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                                                        {formatTime(segment.start)} – {formatTime(segment.end)}
                                                    </span>
                                                </div>

                                                <p className={`leading-relaxed ${isDark ? "text-zinc-100" : "text-gray-800"}`}>{highlightSearch(segment.text)}</p>
                                            </motion.div>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Sticky Action Buttons */}
                    <div className={`sticky bottom-0 left-0 right-0 backdrop-blur-lg border-t mt-10 py-6 px-6 lg:px-12 ${isDark ? "bg-zinc-950/90 border-zinc-800" : "bg-white/90 border-gray-200"}`}>
                        <div className="max-w-7xl mx-auto flex flex-wrap gap-4 justify-center lg:justify-start">
                            <button
                                onClick={handleRerun}
                                disabled={isTranscribing}
                                className={`flex items-center gap-2 px-6 py-3 rounded-xl font-medium transition disabled:opacity-50 ${isDark ? "bg-zinc-800 hover:bg-zinc-700 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-900"
                                    }`}
                            >
                                <RefreshCw className={`w-5 h-5 ${isTranscribing ? "animate-spin" : ""}`} />
                                {isTranscribing ? "Transcribing..." : "Re-run Transcription"}
                            </button>

                            <button
                                onClick={handleCopy}
                                disabled={!transcription.fullText}
                                className={`flex items-center gap-2 px-6 py-3 rounded-xl font-medium transition disabled:opacity-50 ${isDark ? "bg-zinc-800 hover:bg-zinc-700 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-900"
                                    }`}
                            >
                                {copied ? <CheckCircle className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
                                {copied ? "Copied!" : "Copy Text"}
                            </button>

                            <button
                                onClick={() => setShowDiarizeDialog(true)}
                                className="flex items-center gap-2 px-6 py-3 rounded-xl font-medium bg-pink-600 hover:bg-pink-700 text-white transition"
                            >
                                <Users className="w-5 h-5" />
                                Diarize Speakers
                            </button>

                            <div className="flex items-center gap-2">
                                <select
                                    value={exportFormat}
                                    onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                                    className={`px-4 py-3 rounded-xl border text-sm font-medium focus:outline-none focus:ring-2 focus:ring-pink-500 ${isDark ? "bg-zinc-800 border-zinc-700 text-white" : "bg-white border-gray-300 text-gray-900"
                                        }`}
                                >
                                    <option value="json">JSON</option>
                                    <option value="srt">SRT</option>
                                    <option value="vtt">VTT</option>
                                    <option value="txt">TXT</option>
                                    <option value="csv">CSV</option>
                                    <option value="tsv">TSV</option>
                                    <option value="md">MD</option>
                                    <option value="pdf">PDF</option>
                                    <option value="docx">DOCX</option>
                                </select>
                                <button
                                    onClick={() => handleExport(exportFormat)}
                                    className={`flex items-center gap-2 px-6 py-3 rounded-xl font-medium transition ${isDark ? "bg-zinc-800 hover:bg-zinc-700 text-white" : "bg-gray-100 hover:bg-gray-200 text-gray-900"
                                        }`}
                                >
                                    <Download className="w-5 h-5" />
                                    Export {exportFormat.toUpperCase()}
                                </button>
                            </div>



                            {/* Translation shortcuts */}
                            <div className="flex flex-wrap items-center gap-4 my-6">
                                <h2 className="text-2xl font-bold flex-1">
                                    {transcription?.title || transcription?.filename || "Transcription"}
                                </h2>

                                {/* Translate button – always available if transcription exists */}
                                <Link href={`/translations/detail?id=${id}&create=true`}>
                                    <button
                                        className="px-7 py-3.5 bg-linear-to-r from-pink-600 via-purple-600 to-pink-600 
                       hover:from-pink-500 hover:via-purple-500 hover:to-pink-500 
                       text-white font-bold rounded-xl shadow-lg shadow-pink-500/25 
                       hover:shadow-xl hover:shadow-purple-500/30 transition-all duration-300 
                       flex items-center gap-2.5 active:scale-[0.98]"
                                    >
                                        <Languages className="w-5 h-5" />
                                        Translate this transcription
                                    </button>
                                </Link>

                                {/* Show "View translation" only if at least one translation exists */}
                                {/* You need to load translations – example below */}
                                {hasTranslation && (
                                    <Link href={`/translations/detail?id=${id}`}>
                                        <button className="px-6 py-3 bg-zinc-800/90 hover:bg-zinc-700 
                               text-white rounded-xl font-medium flex items-center gap-2">
                                            <FileText className="w-4 h-4" />
                                            View translation
                                        </button>
                                    </Link>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        {showDiarizeDialog && (
            <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
                <div className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-950 text-white p-6">
                    <h2 className="text-2xl font-bold mb-2">Create Diarization</h2>
                    <p className="text-sm text-zinc-400 mb-5">
                        Select model, create a diarization entry, then diarization will run in the diarization detail page.
                    </p>

                    <label className="block text-sm font-semibold mb-2">Diarization Model</label>
                    <select
                        value={selectedDiarModel || ""}
                        onChange={(e) => setSelectedDiarModel(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-zinc-700 bg-zinc-900 mb-4"
                    >
                        {diarModels.length === 0 ? (
                            <option value="">No diarization models available</option>
                        ) : (
                            diarModels.map((model) => (
                                <option key={model} value={model}>
                                    {model}
                                </option>
                            ))
                        )}
                    </select>

                    {diarError && <p className="text-red-400 text-sm mb-3">{diarError}</p>}

                    <div className="flex justify-end gap-3">
                        <button
                            onClick={() => setShowDiarizeDialog(false)}
                            disabled={isDiarizing}
                            className="px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreateDiarizationEntry}
                            disabled={isDiarizing || diarModels.length === 0 || !selectedDiarModel}
                            className="px-5 py-2.5 rounded-xl bg-pink-600 hover:bg-pink-700 disabled:opacity-50 inline-flex items-center gap-2"
                        >
                            {isDiarizing && <Loader2 className="w-4 h-4 animate-spin" />}
                            {isDiarizing ? "Creating..." : "Create and Run"}
                        </button>
                    </div>
                </div>
            </div>
        )}
        </>
    );
}
