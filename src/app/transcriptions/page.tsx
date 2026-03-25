"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Search, FileText, Plus, Mic, Youtube, Upload, Trash2, AlertCircle,
    Play, Square, Loader2,
    X,
    Calendar,
    Check,
    Clock,
    Edit2,
    FileAudio,
    AlertTriangle,
} from "lucide-react";
import Link from "next/link";
import { invoke } from "@tauri-apps/api/core";
import {
    listTranscriptions,
    deleteTranscription,
    saveTranscription,
    groupTranscriptionsByDate,
    type Transcription,
    updateTranscription,
} from "@/lib/transcriptionDb";
import { showToast } from "@/lib/toast";
import { listen } from "@tauri-apps/api/event";
import { emitTranscriptionAdded } from "@/lib/events";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import FileTranscriber from "@/components/FileTranscriber";
import OnboardingCard from "@/components/OnboardingCard";

type SortOption = "newest" | "oldest" | "name";
type SourceFilter = "all" | "file" | "youtube" | "recording";

const steps = [
  {
    id: "transcriptions-welcome-1s2",
    title: "Welcome to Transcriptions",
    description: "This is your personal library of all transcriptions. You can create new ones from files, YouTube links, or by recording audio directly.",
    imageSrc: "/images/transcriptions-empty-state.png",
    buttonText: "Next",
  },
  {
    id: "transcriptions-sources-2s2",
    title: "Multiple Sources",
    description: "Create transcriptions from different sources using the 'New Transcription' button. Choose between YouTube import, file upload, or live microphone recording.",
    imageSrc: "/images/new-transcription-modal.png",
    buttonText: "Next",
  },
  {
    id: "transcriptions-sort-search-s32",
    title: "Sort, Search & Filter",
    description: "Use the search bar to find transcriptions quickly. Sort by date, and filter by source type (All, Files, YouTube, Recordings) to keep everything organized.",
    imageSrc: "/images/transcriptions-search-filter.png",
    buttonText: "Next",
  },
  {
    id: "transcriptions-item-actions-42s",
    title: "Manage Each Transcription",
    description: "Click 'Open' to view details, edit speaker names, or see full transcription. Use the trash icon to delete. You can also rename items directly.",
    imageSrc: "/images/transcription-card-actions.png",
    buttonText: "Next",
  },
  {
    id: "transcriptions-advanced-s62",
    title: "Advanced Features Inside",
    description: "Each transcription supports speaker diarization (who said what), segmentation, translation, timeline editing, and detailed analysis — all available when you open a transcription.",
    imageSrc: "/images/transcription-detail-features.png",
    buttonText: "Got it!",
  },
];

const WHISPER_MODELS = [
    { value: "ggml-tiny.bin", label: "Tiny (~39 MB) – fastest, lowest quality" },
    { value: "ggml-tiny.en.bin", label: "Tiny EN (~39 MB) – English only" },
    { value: "ggml-base.bin", label: "Base (~74 MB) – good balance" },
    { value: "ggml-base.en.bin", label: "Base EN (~74 MB) – English only" },
    { value: "ggml-small.bin", label: "Small (~244 MB) – better quality" },
    { value: "ggml-small.en.bin", label: "Small EN (~244 MB) – English only" },
    { value: "ggml-medium.bin", label: "Medium (~769 MB) – high quality" },
    { value: "ggml-medium.en.bin", label: "Medium EN (~769 MB) – English only" },
    { value: "ggml-large-v1.bin", label: "Large v1 (~1.55 GB) – very high quality" },
    { value: "ggml-large-v2.bin", label: "Large v2 (~1.55 GB) – improved" },
    { value: "ggml-large-v3.bin", label: "Large v3 (~1.55 GB) – latest & best" },
    { value: "ggml-large-v3-turbo.bin", label: "Large v3 Turbo (~809 MB) – faster large model" },
] as const;



export default function TranscriptionsPage() {
    const { resolvedTheme } = useTheme();
    const isDark = resolvedTheme === "dark";
    const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [sortBy, setSortBy] = useState<SortOption>("newest");
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
    const [showNewModal, setShowNewModal] = useState(false);
    const [youtubeUrl, setYoutubeUrl] = useState("");
    const [youtubeError, setYoutubeError] = useState("");
    const [isImporting, setIsImporting] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [selectedModel, setSelectedModel] = useState("ggml-base.en.bin");
    const [downloadedModels, setDownloadedModels] = useState<string[]>([]);
    const [isModelsLoading, setIsModelsLoading] = useState(true);

    // In TranscriptionsPage component

    // Remove selectedUploadFile — we don't need the File object
    // const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
    // const [selectedFileName, setSelectedFileName] = useState<string>("No file selected");
    // const [uploadError, setUploadError] = useState<string | null>(null);
    // const [isTranscribingFile, setIsTranscribingFile] = useState(false); // renamed for clarity

    // Recording state
    // ── Live Recording ───────────────────────────────────────────────
    // Add these new states near your other recording states
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
    const [audioChunks, setAudioChunks] = useState<Blob[]>([]);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    // Editing title
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editValue, setEditValue] = useState("");

    const [displayedTranscriptions, setDisplayedTranscriptions] = useState<Transcription[]>([]);

    // Pagination
    const [currentPage, setCurrentPage] = useState(1);
    const [pageSize, setPageSize] = useState(9);
    const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; title: string } | null>(null);

    const [showRecordingPreview, setShowRecordingPreview] = useState(false);
    const [savedAudioPath, setSavedAudioPath] = useState<string | null>(null);
    const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
    const t = useTranslations();
    const delete_transcription = "Delete transcription";

    const [step, setStep] = useState(0);

    const handleNext = () => {
        if (step < steps.length - 1) {
            setStep(step + 1);
        }
    };

    if (step >= steps.length) return null;

    const current = steps[step];

    // ── Start recording ───────────────────────────────────────────────
    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            const recorder = new MediaRecorder(stream, {
                mimeType: "audio/webm;codecs=opus",
            });

            setMediaRecorder(recorder);
            setAudioChunks([]);
            setRecordingTime(0);
            setShowRecordingPreview(false); // reset if restarting

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    setAudioChunks((prev) => [...prev, e.data]);
                }
            };

            recorder.start(1000);

            setIsRecording(true);

            timerRef.current = setInterval(() => {
                setRecordingTime((t) => t + 1);
            }, 1000);

            showToast("Recording started", "success");
        } catch (err) {
            console.error("Failed to access microphone:", err);
            showToast("Failed to access microphone. Please check permissions.", "error");
        }
    };

    // ── Stop recording & show preview ──────────────────────────────────
    const stopRecording = async () => {
        if (!mediaRecorder || !isRecording) return;

        mediaRecorder.stop();
        setIsRecording(false);
        if (timerRef.current) clearInterval(timerRef.current);

        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        }

        mediaRecorder.onstop = async () => {
            try {
                showToast("Processing recording...", "info");

                const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
                setPreviewBlob(audioBlob); // for preview

                const arrayBuffer = await audioBlob.arrayBuffer();
                const rawBytes = Array.from(new Uint8Array(arrayBuffer));

                // Save persistently
                const tempPath = await invoke<string>("save_temp_audio", {
                    blob: rawBytes,
                });

                console.log("[RECORD] Saved persistent path:", tempPath);
                setSavedAudioPath(tempPath);

                // Show preview with options
                setShowRecordingPreview(true);

                showToast("Recording saved — preview ready", "success");
            } catch (err: any) {
                console.error("[RECORD] Failed to save recording:", err);
                showToast(`Failed to save recording: ${err.message || "Unknown error"}`, "error");
            } finally {
                setAudioChunks([]);
            }
        };
    };

    // ── Continue with transcription ───────────────────────────────────
    const continueTranscription = async () => {
        if (!savedAudioPath) return;

        try {
            showToast("Starting transcription...", "info");

            // Fire-and-forget: start the backend job — do NOT await
            invoke("transcribe_recording", {
                webmPath: savedAudioPath,
                modelName: selectedModel,
                language: null,
                translateToEnglish: false,
            })
                .then(() => {
                    console.log("[RECORD] Transcription command accepted (event will follow)");
                })
                .catch((err) => {
                    console.warn("[RECORD] Invoke returned error (event may still arrive):", err);
                });

            console.log("[RECORD] Transcription command sent — waiting for event");

            showToast("Transcription in progress... result will arrive via event", "info");

            // Close preview
            setShowRecordingPreview(false);
            setSavedAudioPath(null);
            setPreviewBlob(null);
        } catch (err: any) {
            console.error("[RECORD] Failed to start transcription:", err);
            showToast(`Failed to start transcription: ${err.message || "Unknown error"}`, "error");
        }
    };
    // ── Record again ──────────────────────────────────────────────────
    const recordAgain = () => {
        setShowRecordingPreview(false);
        setSavedAudioPath(null);
        setPreviewBlob(null);
        startRecording();
    };

    // ── Cancel recording ──────────────────────────────────────────────
    const cancelRecording = () => {
        setShowRecordingPreview(false);
        setSavedAudioPath(null);
        setPreviewBlob(null);
        showToast("Recording cancelled", "info");
    };

    useEffect(() => {
        loadTranscriptions();

        const unlisten = listen("download-progress", (event) => {
            const payload = event.payload as { percentage: number; message: string };
            setDownloadProgress(payload.percentage);
        });

        return () => {
            unlisten.then(f => f());
        };
    }, []);

    const loadTranscriptions = async () => {
        setLoading(true);
        try {
            const data = await listTranscriptions();
            setTranscriptions(data);
        } catch (err) {
            console.error("Failed to load transcriptions:", err);
            showToast("Failed to load transcriptions", "error");
        } finally {
            setLoading(false);
        }
    };

    // Fetch downloaded models from backend on modal open
    useEffect(() => {
        if (showNewModal) {
            const fetchDownloadedModels = async () => {
                try {
                    setIsModelsLoading(true);
                    const models = await invoke("list_downloaded_models") as string[];
                    setDownloadedModels(models);
                } catch (err) {
                    console.error("Failed to fetch downloaded models:", err);
                    showToast("Could not load model list", "error");
                } finally {
                    setIsModelsLoading(false);
                }
            };

            fetchDownloadedModels();
        }
    }, [showNewModal]);

    // ── YouTube Import ───────────────────────────────────────────────
    const handleYoutubeImport = async () => {
        if (!youtubeUrl.trim()) return;

        setIsImporting(true);
        setYoutubeError("");
        setDownloadProgress(0);

        try {
            const result = await invoke("transcribe_youtube", {
                url: youtubeUrl.trim(),
                modelName: selectedModel,
            }) as any;

            console.log("[IMPORT] invoke result:", result);

            const transcriptionData = {
                filename: `YouTube - ${extractYouTubeId(youtubeUrl) || "Video"}`,
                extension: "wav",
                fullText: result.full_text || result.fullText || "",
                sourceType: "youtube" as const,
                sourceUrl: youtubeUrl,
                audioPath: result.audioPath || result.audio_path || null,  // ← FIXED: pass the audio path!
                duration: result.duration,
                segments: (result.segments || []).map((s: any) => ({
                    start: s.start_ms / 1000,
                    end: s.end_ms / 1000,
                    text: s.text,
                })),
            };

            console.log("[IMPORT] Saving with audioPath:", transcriptionData.audioPath);

            const saved = await saveTranscription(transcriptionData);

            console.log("[IMPORT] Saved transcription:", saved);

            setTranscriptions(prev => [saved, ...prev]);
            emitTranscriptionAdded();
            showToast("YouTube transcription completed!", "success");
            setShowNewModal(false);
            setYoutubeUrl("");
        } catch (err: any) {
            console.error("YouTube import failed:", err);
            setYoutubeError(err.toString() || "Failed to process YouTube video");
            showToast("Failed to import YouTube video", "error");
        } finally {
            setIsImporting(false);
            setDownloadProgress(0);
        }
    };

    // // ── File Upload ────────────────────────────────────────────────────────────────
    // const pickFile = async () => {
    //     try {
    //         const selected = await open({
    //             title: "Select audio or video file",
    //             multiple: false,
    //             directory: false,
    //             filters: [
    //                 {
    //                     name: "Audio & Video Files",
    //                     extensions: ["mp3", "wav", "m4a", "ogg", "webm", "flac", "mp4", "mov", "mkv", "avi"],
    //                 },
    //             ],
    //         });

    //         if (!selected) return; // user cancelled

    //         const path = selected as string;
    //         const name = path.split(/[\\/]/).pop() || "audio-file";

    //         setSelectedFilePath(path);
    //         setSelectedFileName(name);
    //         setUploadError(null);
    //     } catch (err) {
    //         console.error("File picker error:", err);
    //         setUploadError("Failed to open file picker");
    //     }
    // };

    // const handleFileTranscribe = async () => {
    //     if (!selectedFilePath) {
    //         setUploadError("Please select a file first");
    //         return;
    //     }

    //     setIsTranscribingFile(true);
    //     setUploadError(null);

    //     try {
    //         const fileName = selectedFileName || "uploaded-file";

    //         showToast("Starting transcription...", "info");

    //         await invoke("transcribe_path", {
    //             filePath: selectedFilePath,
    //             fileName,
    //             modelName: selectedModel,
    //             language: null, // ← replace with selectedLanguage if you add picker
    //         });

    //         // At this point:
    //         // Backend processes file → emits "transcription-completed"
    //         // Your global listener saves to DB and shows success toast

    //         showToast("Transcription started — will appear in list when finished", "success");

    //         // Reset & close
    //         setShowNewModal(false);
    //         setSelectedFilePath(null);
    //         setSelectedFileName("No file selected");

    //     } catch (err: any) {
    //         console.error("Transcription failed:", err);
    //         const message = err?.message || "Failed to transcribe file";
    //         setUploadError(message);
    //         showToast(message, "error");
    //     } finally {
    //         setIsTranscribingFile(false);
    //     }
    // };
    // ── Edit Title ──────────────────────────────────────────────────

    // Start editing a transcription title
    const startEditing = (t: Transcription) => {
        setEditingId(t.id);
        setEditValue(t.title || t.filename || ""); // Use current title or fallback to filename
    };

    // Save the edited title (called on Enter or Save button)
    const saveEdit = async (id: string) => {
        const trimmedValue = editValue.trim();

        // Optional: Prevent saving completely empty title (you can remove this if you want to allow clearing)
        if (!trimmedValue) {
            showToast("Title cannot be empty", "error");
            return;
        }

        try {
            // Always pass the title value — even if empty (DB will set NULL)
            const updated = await updateTranscription(id, { title: trimmedValue });

            if (updated) {
                // Update local state with the fresh DB value
                setTranscriptions((prev) =>
                    prev.map((t) => (t.id === id ? { ...t, title: updated.title } : t))
                );
                setEditingId(null);
                setEditValue("");
                showToast("Title saved successfully!", "success");
            } else {
                showToast("Failed to update title", "error");
            }
        } catch (err) {
            console.error("Failed to save title:", err);
            showToast("Failed to save title", "error");
        }
    };

    // Cancel editing (called on Escape or Cancel button)
    const cancelEdit = () => {
        setEditingId(null);
        setEditValue("");
    };

    // ── Delete Transcription ─────────────────────────────────────────
    // State (make sure you have this in your component)
    // Updated handleDelete function
    const handleDelete = (id: string, title: string) => {
        setDeleteConfirm({ id, title });
    };

    // Delete confirmation handler (call this when user clicks "Yes, Delete")
    const confirmDelete = async () => {
        if (!deleteConfirm) return;

        try {
            const success = await deleteTranscription(deleteConfirm.id);
            if (success) {
                // Remove from local state
                setTranscriptions((prev) => prev.filter((t) => t.id !== deleteConfirm.id));
                showToast("Transcription deleted successfully", "success");
            } else {
                showToast("Failed to delete transcription", "error");
            }
        } catch (err) {
            console.error("Delete error:", err);
            showToast("Error deleting transcription", "error");
        } finally {
            // Always close the modal
            setDeleteConfirm(null);
        }
    };


    function extractYouTubeId(url: string): string | null {
        if (!url || typeof url !== "string") return null;

        const patterns = [
            /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/i,
            /(?:youtube(?:-nocookie)?\.com\/watch(?:\.php)?\?.*?v=)([a-zA-Z0-9_-]{11})/i,
            /(?:youtube(?:-nocookie)?\.com\/)(?:embed\/|v\/|shorts\/|live\/|e\/)([a-zA-Z0-9_-]{11})/i,
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


    useEffect(() => {
        const filtered = transcriptions.filter((t) => {
            const q = search.toLowerCase();
            const matchesSearch =
                (t.title ?? t.filename).toLowerCase().includes(q) ||
                t.filename.toLowerCase().includes(q) ||
                (t.fullText?.toLowerCase().includes(q) ?? false);

            // Make filter robust to casing and missing values
            const source = (t.sourceType ?? "").toString().toLowerCase();
            const matchesFilter = sourceFilter === "all" || source === sourceFilter;

            return matchesSearch && matchesFilter;
        });

        const sorted = [...filtered].sort((a, b) => {
            if (sortBy === "newest") return b.createdAt.getTime() - a.createdAt.getTime();
            if (sortBy === "oldest") return a.createdAt.getTime() - b.createdAt.getTime();
            if (sortBy === "name") return a.filename.localeCompare(b.filename);
            return 0;
        });

        setDisplayedTranscriptions(sorted);
        // Reset to first page on filter/sort/search changes
        setCurrentPage(1);
    }, [transcriptions, search, sourceFilter, sortBy]);
    // Pagination math
    const totalPages = Math.max(1, Math.ceil(displayedTranscriptions.length / pageSize));
    useEffect(() => {
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [currentPage, totalPages]);

    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedTranscriptions = displayedTranscriptions.slice(startIndex, endIndex);

    const grouped = groupTranscriptionsByDate(paginatedTranscriptions);

    // ── JSX (mostly same, just add progress, loading states, etc.) ───
    return (
        <div className="p-6">
            {/* Header + Search + Filters */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
                <h1 className="text-3xl font-bold">{t("Transcriptions")}</h1>
                <button
                    onClick={() => setShowNewModal(true)}
                    className="px-5 py-3 bg-pink-500 hover:bg-pink-600 text-white rounded-xl font-bold flex items-center gap-2"
                >
                    <Plus className="w-5 h-5" /> {t("New Transcription")}
                </button>
            </div>

            <OnboardingCard
                id={current.id}
                title={current.title}
                description={current.description}
                imageSrc={current.imageSrc}
                buttonText={current.buttonText}
                onFinish={handleNext}
            />

            {/* Search & Filters */}
            <div className="flex flex-col md:flex-row gap-4 mb-6">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 w-5 h-5" />
                    <input
                        type="text"
                        placeholder="Search transcriptions..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full pl-11 pr-4 py-2.5 bg-zinc-900 border border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-white placeholder-zinc-500"
                    />
                </div>

                <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortOption)}
                    className="px-4 py-2.5 bg-zinc-900 border border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-white"
                >
                    <option value="newest">{t("Newest first")}</option>
                    <option value="oldest">{t("Oldest first")}</option>
                    <option value="name">{t("By name")}</option>
                </select>

                <select
                    value={sourceFilter}
                    onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
                    className="px-4 py-2.5 bg-zinc-900 border border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-white"
                >
                    <option value="all">{t("All sources")}</option>
                    <option value="file">{t("Files")}</option>
                    <option value="youtube">{t("YouTube")}</option>
                    <option value="recording">{t("Recordings")}</option>
                </select>
            </div>

            {/* Transcription Cards */}
            {loading ? (
                <div className="flex justify-center py-20">
                    <Loader2 className="w-12 h-12 animate-spin text-pink-500" />
                </div>
            ) : Object.keys(grouped).length === 0 ? (
                <div className={`text-center py-20 ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                    <FileText className="w-16 h-16 mx-auto mb-4 opacity-50" />
                    <p className="text-xl font-medium">"{t("No transcriptions yet")}"</p>
                    <p className="mt-2">{t("Start-guide")}</p>
                </div>
            ) : (
                <div className="space-y-10">
                    {Object.entries(grouped).map(([group, items]) => (
                        <div key={group}>
                            <h2 className={`text-xl font-bold mb-4 flex items-center gap-2 ${isDark ? "text-white" : "text-gray-900"}`}>
                                <Calendar className="w-5 h-5 text-pink-500" />
                                {group}
                            </h2>

                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                {items.map((t) => (
                                    <motion.div
                                        key={t.id}
                                        initial={{ opacity: 0, y: 20 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className={`rounded-2xl border overflow-hidden shadow-lg transition-all hover:shadow-xl
                      ${isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-gray-200"}`}
                                    >
                                        {/* Header */}
                                        <div className={`p-5 border-b ${isDark ? "border-zinc-800" : "border-gray-200"}`}>
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="flex items-center gap-2 group w-full">
                                                    {editingId === t.id ? (
                                                        <div className="flex items-center gap-2 w-full">
                                                            <input
                                                                value={editValue}
                                                                onChange={(e) => setEditValue(e.target.value)}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === "Enter") {
                                                                        e.preventDefault();
                                                                        saveEdit(t.id);
                                                                    }
                                                                    if (e.key === "Escape") {
                                                                        e.preventDefault();
                                                                        cancelEdit();
                                                                    }
                                                                }}
                                                                className={`flex-1 px-2 py-1 rounded border focus:outline-none focus:ring-2 focus:ring-pink-500 transition
          ${isDark ? "bg-zinc-800 border-zinc-600 text-white" : "bg-white border-gray-300 text-gray-900"}`}
                                                                autoFocus
                                                                placeholder="Enter title..."
                                                            />
                                                            <button
                                                                onClick={() => saveEdit(t.id)}
                                                                title="Save (Enter)"
                                                                className="p-1 hover:text-green-500 transition"
                                                            >
                                                                <Check className="w-5 h-5 text-green-500" />
                                                            </button>
                                                            <button
                                                                onClick={cancelEdit}
                                                                title="Cancel (Esc)"
                                                                className="p-1 hover:text-red-500 transition"
                                                            >
                                                                <X className="w-5 h-5 text-red-500" />
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-center gap-2 flex-1">
                                                            <h3 className="font-semibold text-lg line-clamp-1 cursor-pointer" onDoubleClick={() => startEditing(t)}>
                                                                {t.title || t.filename}
                                                            </h3>
                                                            <button
                                                                onClick={() => startEditing(t)}
                                                                className="opacity-0 group-hover:opacity-100 transition p-1"
                                                                title="Edit title"
                                                            >
                                                                <Edit2 className="w-4 h-4 text-zinc-400 hover:text-pink-500" />
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {t.sourceType === "youtube" && <Youtube className="w-5 h-5 text-red-500" />}
                                                    {t.sourceType === "file" && <FileAudio className="w-5 h-5 text-blue-500" />}
                                                    {t.sourceType === "recording" && <Mic className="w-5 h-5 text-green-500" />}
                                                </div>
                                            </div>

                                            <div className={`mt-2 flex items-center gap-4 text-sm ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                                                <div className="flex items-center gap-1">
                                                    <Clock className="w-4 h-4" />
                                                    {t.duration ? `${Math.floor(t.duration / 60)}:${(t.duration % 60).toString().padStart(2, "0")}` : "—"}
                                                </div>
                                                <div>{t.createdAt.toLocaleDateString()}</div>
                                            </div>
                                        </div>

                                        {/* Preview Text */}
                                        <div className="p-5">
                                            <p className={`line-clamp-4 text-sm leading-relaxed ${isDark ? "text-zinc-300" : "text-gray-700"}`}>
                                                {t.fullText || "No text available..."}
                                            </p>
                                        </div>

                                        {/* Footer */}
                                        <div className={`px-5 py-4 border-t flex items-center justify-between ${isDark ? "border-zinc-800 bg-zinc-950/50" : "border-gray-200 bg-gray-50"}`}>
                                            <Link
                                                href={`/transcriptions/detail?id=${t.id}`}
                                                className="flex items-center gap-2 text-pink-500 hover:text-pink-400 font-medium transition"
                                            >
                                                <Play className="w-4 h-4" />
                                                Open
                                            </Link>

                                            <button
                                                onClick={() => handleDelete(t.id, t.title || t.filename)}
                                                className="p-2 rounded-full text-red-500 hover:bg-red-500/20 transition"
                                                title="Delete transcription"
                                            >
                                                <Trash2 className="w-5 h-5" />
                                            </button>
                                        </div>
                                    </motion.div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Pagination Controls */}
            {displayedTranscriptions.length > 0 && (
                <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
                    <div className="text-sm text-zinc-400">
                        Showing {displayedTranscriptions.length === 0 ? 0 : startIndex + 1} - {Math.min(displayedTranscriptions.length, endIndex)} of {displayedTranscriptions.length}
                    </div>

                    <div className="flex items-center gap-2">
                        <select
                            value={pageSize}
                            onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                            className="px-3 py-1 bg-zinc-900 border border-zinc-700 rounded text-white"
                        >
                            <option value={6}>6 / page</option>
                            <option value={9}>9 / page</option>
                            <option value={12}>12 / page</option>
                        </select>

                        <button
                            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                            disabled={currentPage === 1}
                            className="px-3 py-1 bg-zinc-800 text-white rounded disabled:opacity-50"
                        >
                            Prev
                        </button>

                        <span className="px-3 text-sm">{currentPage} / {totalPages}</span>

                        <button
                            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                            disabled={currentPage === totalPages}
                            className="px-3 py-1 bg-zinc-800 text-white rounded disabled:opacity-50"
                        >
                            Next
                        </button>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            <AnimatePresence>
                {deleteConfirm && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
                    >
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.9, opacity: 0 }}
                            className="bg-zinc-900 rounded-2xl p-8 max-w-md w-full mx-4 border border-zinc-700 shadow-2xl"
                        >
                            <div className="flex items-center gap-4 mb-6">
                                <AlertTriangle className="w-10 h-10 text-red-500" />
                                <h3 className="text-2xl font-bold text-white">Delete Transcription?</h3>
                            </div>

                            <p className="text-zinc-300 mb-8">
                                {t("Are you sure you want to delete")}<strong>"{deleteConfirm.title}"</strong>?<br />
                                {t("This action cannot be undone")}
                            </p>

                            <div className="flex gap-4">
                                <button
                                    onClick={() => setDeleteConfirm(null)}
                                    className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl font-medium transition"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={async () => {
                                        try {
                                            const success = await deleteTranscription(deleteConfirm.id);
                                            if (success) {
                                                setTranscriptions((prev) => prev.filter((tr) => tr.id !== deleteConfirm.id));
                                                showToast("Transcription deleted", "success");
                                            }
                                        } catch (err) {
                                            showToast("Failed to delete", "error");
                                        } finally {
                                            setDeleteConfirm(null);
                                        }
                                    }}
                                    className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-medium transition"
                                >
                                    {t("Yes, Delete")}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Recording Preview Modal */}
            {showRecordingPreview && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
                    <div className="bg-zinc-900 p-8 rounded-2xl max-w-lg w-full mx-4">
                        <h3 className="text-xl font-bold mb-4">Recording Preview</h3>

                        {/* Audio player */}
                        {previewBlob && (
                            <audio controls className="w-full mb-6">
                                <source src={URL.createObjectURL(previewBlob)} type="audio/webm" />
                                {t("Your browser does not support the audio element")}
                            </audio>
                        )}

                        <div className="flex justify-between gap-4">
                            <button
                                onClick={recordAgain}
                                className="flex-1 py-3 bg-zinc-700 hover:bg-zinc-600 rounded-xl font-medium"
                            >
                                {t("Record Again")}
                            </button>

                            <button
                                onClick={continueTranscription}
                                className="flex-1 py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-bold"
                            >
                                {t("Continue & Transcribe")}
                            </button>

                            <button
                                onClick={cancelRecording}
                                className="flex-1 py-3 bg-red-600/80 hover:bg-red-700 text-white rounded-xl font-medium"
                            >
                                {t("Cancel")}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* New Transcription Modal */}
            <AnimatePresence>
                {showNewModal && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="bg-white dark:bg-zinc-900 rounded-3xl p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto"
                        >
                            <div className="flex justify-between items-center mb-6">
                                <h2 className="text-2xl font-bold">New Transcription</h2>
                                <button onClick={() => setShowNewModal(false)}>
                                    <X className="w-6 h-6" />
                                </button>
                            </div>

                            {/* YouTube Import Section */}
                            <div className="mb-6">
                                <div className="flex items-center gap-3 mb-4">
                                    <Youtube className="w-6 h-6 text-red-500" />
                                    <h3 className="text-lg font-semibold">Import from YouTube</h3>
                                </div>

                                <input
                                    type="text"
                                    value={youtubeUrl}
                                    onChange={(e) => setYoutubeUrl(e.target.value)}
                                    placeholder="Paste YouTube link..."
                                    className="w-full p-3 bg-zinc-800 border border-zinc-700 rounded-xl text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 mb-4"
                                />

                                {/* Model Selector */}
                                <div className="mb-4">
                                    <label className="block text-sm text-zinc-400 mb-2">
                                        Whisper Model
                                    </label>

                                    {isModelsLoading ? (
                                        <div className="flex items-center justify-center py-4">
                                            <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
                                            <span className="ml-2 text-zinc-500">Loading models...</span>
                                        </div>
                                    ) : (
                                        <select
                                            value={selectedModel}
                                            onChange={(e) => setSelectedModel(e.target.value)}
                                            className="w-full p-3 bg-zinc-800 border border-zinc-700 rounded-xl text-white focus:outline-none focus:border-zinc-500"
                                        >
                                            {WHISPER_MODELS.map((model) => {
                                                const isDownloaded = downloadedModels.includes(model.value);
                                                return (
                                                    <option key={model.value} value={model.value}>
                                                        {isDownloaded ? "✓ " : "↓ "}
                                                        {model.label}
                                                    </option>
                                                );
                                            })}
                                        </select>
                                    )}
                                </div>

                                {downloadProgress > 0 && (
                                    <div className="mb-3">
                                        <div className="w-full bg-zinc-200 rounded-full h-2.5">
                                            <div
                                                className="bg-pink-500 h-2.5 rounded-full transition-all"
                                                style={{ width: `${downloadProgress}%` }}
                                            />
                                        </div>
                                        <p className="text-sm text-center mt-1">{downloadProgress.toFixed(0)}%</p>
                                    </div>
                                )}

                                {youtubeError && (
                                    <p className="text-red-400 text-sm mb-3">{youtubeError}</p>
                                )}

                                <button
                                    onClick={handleYoutubeImport}
                                    disabled={isImporting || !youtubeUrl.trim() || isModelsLoading}
                                    className="w-full py-3 bg-red-600 hover:bg-red-700 disabled:bg-red-800 disabled:cursor-not-allowed text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-colors"
                                >
                                    {isImporting ? (
                                        <>
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                            {t("Importing")}
                                        </>
                                    ) : (
                                        t("Import & Transcribe")
                                    )}
                                </button>
                            </div>

                            {/* File Upload */}
                            <div className="mb-8 p-6 border border-zinc-200 dark:border-zinc-700 rounded-2xl">
                                <div className="flex items-center gap-4 mb-4">
                                    <Upload className="w-8 h-8 text-blue-500" />
                                    <div>
                                        <h3 className="font-bold text-lg">{t("Upload Audio/Video File")}</h3>
                                        <p className="text-sm text-zinc-500">MP3, WAV, MP4, etc.</p>
                                    </div>
                                </div>

                                <FileTranscriber
                                    onCancel={() => setShowNewModal(false)}
                                    onTranscriptionComplete={() => {
                                        // Optional: refresh list, show success, etc.
                                        setShowNewModal(false);
                                        // You can call loadTranscriptions() here if needed
                                    }}
                                />
                            </div>

                            {/* Live Recording */}
                            <div className="p-6 border border-zinc-200 dark:border-zinc-700 rounded-2xl">
                                <div className="flex items-center gap-4 mb-4">
                                    <Mic className="w-8 h-8 text-green-500" />
                                    <div>
                                        <h3 className="font-bold text-lg">{t("Record Audio")}</h3>
                                        <p className="text-sm text-zinc-500">{t("Speak directly into your microphone")}</p>
                                    </div>
                                </div>

                                {isRecording ? (
                                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                                        <div className="flex items-center gap-3 flex-1">
                                            <div className="w-4 h-4 bg-red-500 rounded-full animate-pulse" />
                                            <span className="font-mono font-bold text-lg">
                                                {Math.floor(recordingTime / 60).toString().padStart(2, "0")}:
                                                {(recordingTime % 60).toString().padStart(2, "0")}
                                            </span>
                                        </div>

                                        <button
                                            onClick={stopRecording}
                                            className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold flex items-center gap-2 transition-colors"
                                        >
                                            <Square className="w-5 h-5" /> {t("Stop & Transcribe")}
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={startRecording}
                                        className="w-full py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-colors"
                                    >
                                        <Mic className="w-5 h-5" /> {t("Start Recording")}
                                    </button>
                                )}
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}