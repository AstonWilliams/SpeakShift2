// src/components/CompactFileTranscriber.tsx
"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
    Upload,
    X,
    Loader2,
    FileAudio,
    Globe,
    Mic,
    CheckCircle2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { showToast } from "@/lib/toast";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";

const WHISPER_MODELS = [
    "tiny",
    "tiny.en",
    "base",
    "base.en",
    "small",
    "small.en",
    "medium",
    "medium.en",
    "large-v3",
    "large-v3-turbo",
] as const;

type ModelType = (typeof WHISPER_MODELS)[number];

const LANGUAGES = [
    { code: "auto", name: "Auto Detect" },
    { code: "en", name: "English" },
    { code: "hi", name: "Hindi" },
    { code: "ur", name: "Urdu" },
    { code: "es", name: "Spanish" },
] as const;

type LanguageCode = (typeof LANGUAGES)[number]["code"];

interface CompactFileTranscriberProps {
    onClose: () => void;
    onSuccess?: () => void;
}

export default function CompactFileTranscriber({
    onClose,
    onSuccess,
}: CompactFileTranscriberProps) {
    const t = useTranslations();
    const { resolvedTheme } = useTheme();
    const isDark = resolvedTheme === "dark";

    const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
    const [selectedFileName, setSelectedFileName] = useState("No file selected");
    const [selectedModel, setSelectedModel] = useState<ModelType>("small.en");
    const [selectedLanguage, setSelectedLanguage] = useState<LanguageCode>("auto");

    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState("Ready");
    const [error, setError] = useState<string | null>(null);

    const pickFile = async () => {
        try {
            const selected = await open({
                title: t("select File Title"),
                filters: [
                    {
                        name: "Audio & Video",
                        extensions: ["mp3", "wav", "m4a", "ogg", "webm", "flac", "mp4", "mov", "mkv"],
                    },
                ],
                multiple: false,
                directory: false,
            });

            if (!selected || typeof selected !== "string") return;

            const path = selected;
            const name = path.split(/[\\/]/).pop() || "audio-file";

            setSelectedFilePath(path);
            setSelectedFileName(name);
            setError(null);
            setStatus("File ready — choose options and start");
        } catch (err) {
            console.error("File picker error:", err);
            setError(t("file Picker Failed"));
        }
    };

    const startTranscription = async () => {
        if (!selectedFilePath) {
            setError(t("select File First"));
            return;
        }

        setIsProcessing(true);
        setError(null);
        setProgress(0);
        setStatus(t("preparing"));

        try {
            setProgress(10);
            setStatus(t("sending To Backend"));

            await invoke("transcribe_path", {
                filePath: selectedFilePath,
                fileName: selectedFileName,
                modelName: selectedModel,
                language: selectedLanguage === "auto" ? null : selectedLanguage,
            });

            setProgress(60);
            setStatus(t("transcribing"));

            // The backend will emit "transcription-completed"
            // Your global listener should handle saving + toast

            setProgress(100);
            setStatus(t("started Successfully"));
            showToast(t("transcription Started"), "success");

            setTimeout(() => {
                onSuccess?.();
                onClose();
            }, 1200);
        } catch (err: any) {
            console.error("Transcription failed:", err);
            const msg = err?.message || t("transcription Failed");
            setError(msg);
            showToast(msg, "error");
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
        >
            {/* File selection */}
            <div className="space-y-3">
                <div className={`flex items-center gap-3 p-3 rounded-lg ${isDark ? "bg-zinc-800/60" : "bg-gray-100"}`}>
                    <Upload className="w-5 h-5 text-zinc-400" />
                    <span className="text-sm truncate flex-1 font-medium">
                        {selectedFileName}
                    </span>
                    {selectedFilePath && (
                        <button
                            onClick={() => {
                                setSelectedFilePath(null);
                                setSelectedFileName("No file selected");
                                setError(null);
                            }}
                            className="text-red-400 hover:text-red-300"
                        >
                            <X size={18} />
                        </button>
                    )}
                </div>

                <button
                    onClick={pickFile}
                    disabled={isProcessing}
                    className={`w-full py-3 disabled:opacity-50 rounded-xl font-medium flex items-center justify-center gap-2 transition-colors ${isDark
                        ? "bg-zinc-700 hover:bg-zinc-600 text-white"
                        : "bg-gray-200 hover:bg-gray-300 text-gray-900"}`}
                >
                    <Upload size={18} />
                    {selectedFileName === "No file selected" ? t("chooseFile") : t("changeFile")}
                </button>
            </div>

            {/* Model & Language */}
            <div className="grid grid-cols-2 gap-4">
                <div>
                    <label className={`block text-sm mb-1.5 ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                        {t("model")}
                    </label>
                    <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value as ModelType)}
                        disabled={isProcessing}
                        className={`w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 ${isDark
                            ? "bg-zinc-800 border border-zinc-700 text-white"
                            : "bg-white border border-gray-300 text-gray-900"}`}
                    >
                        {WHISPER_MODELS.map((m) => (
                            <option key={m} value={m}>
                                {m.replace(".en", " (English)")}
                            </option>
                        ))}
                    </select>
                </div>

                <div>
                    <label className={`block text-sm mb-1.5 ${isDark ? "text-zinc-400" : "text-gray-600"}`}>
                        {t("language")}
                    </label>
                    <select
                        value={selectedLanguage}
                        onChange={(e) => setSelectedLanguage(e.target.value as LanguageCode)}
                        disabled={isProcessing}
                        className={`w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 ${isDark
                            ? "bg-zinc-800 border border-zinc-700 text-white"
                            : "bg-white border border-gray-300 text-gray-900"}`}
                    >
                        {LANGUAGES.map((lang) => (
                            <option key={lang.code} value={lang.code}>
                                {lang.name}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Status / Error */}
            {error && (
                <div className={`px-4 py-3 rounded-lg text-sm border ${isDark
                    ? "bg-red-900/40 border-red-700/60 text-red-300"
                    : "bg-red-50 border-red-200 text-red-700"}`}>
                    {error}
                </div>
            )}

            {isProcessing && (
                <div className="space-y-2">
                    <div className={`w-full rounded-full h-2.5 ${isDark ? "bg-zinc-700" : "bg-gray-200"}`}>
                        <div
                            className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                    <p className={`text-sm text-center ${isDark ? "text-zinc-400" : "text-gray-600"}`}>{status}</p>
                </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3 pt-2">
                <button
                    onClick={onClose}
                    disabled={isProcessing}
                    className={`flex-1 py-3 disabled:opacity-50 rounded-xl font-medium transition-colors ${isDark
                        ? "bg-zinc-700 hover:bg-zinc-600 text-white"
                        : "bg-gray-200 hover:bg-gray-300 text-gray-900"}`}
                >
                    {t("cancel")}
                </button>

                <button
                    onClick={startTranscription}
                    disabled={isProcessing || !selectedFilePath}
                    className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white rounded-xl font-semibold flex items-center justify-center gap-2 transition-colors shadow-md"
                >
                    {isProcessing ? (
                        <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            {t("processing")}
                        </>
                    ) : (
                        <>
                            <Mic className="w-5 h-5" />
                            {t("startTranscription")}
                        </>
                    )}
                </button>
            </div>

            {progress === 100 && (
                <div className="text-center text-green-400 flex items-center justify-center gap-2 pt-3">
                    <CheckCircle2 className="w-5 h-5" />
                    {t("Completed Successfully")}
                </div>
            )}
        </motion.div>
    );
}