"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Languages,
  FileText,
  Plus,
  Search,
  Loader2,
  AlertTriangle,
  Calendar,
  Pencil,
  Check,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
// Reuse your db helpers (adjust import paths as needed)
import { getDb, listTranscriptions, updateTranscription, type Transcription } from "@/lib/transcriptionDb";
import { showToast } from "@/lib/toast";
import OnboardingCard from "@/components/OnboardingCard";
import { NLLB_LANGUAGES } from "@/lib/language_keys";

const steps = [
  {
    id: "transcriptions-welcome-1242",
    title: "Welcome to Translations",
    description: "This is your personal library of all translations. You can access all your translations here.",
    imageSrc: "/images/translation-welcome.png",
    buttonText: "Next",
  },
  {

    id: "translations-tutorial-1-m2ode4l",
    title: "Step 1: Activate Translation Model",
    description: "Go to Settings (gear icon) and download + activate a translation model (e.g. NLLB or M2M). This needs to be done only once — larger models give better translation quality.",
    imageSrc: "/images/translation1.png", // screenshot of settings with translation model section
    buttonText: "Next",
  },
  {
    id: "translations-tutorial-2-open-t2ranscription4",
    title: "Step 2: Open a Transcription",
    description: "Go back to the Transcriptions page, find your transcription, and click 'Open' to view the detailed view with timeline and speaker labels.",
    imageSrc: "/images/translation1.png", // screenshot of a transcription card → Open button
    buttonText: "Next",
  },
  {
    id: "translations-tutorial-3-select-2translate4",
    title: "Step 3: Select Translate",
    description: "In the transcription detail view, click the 'Translate' button (or tab). Then choose the source language (usually auto-detected) and target language you want to translate to.",
    imageSrc: "/images/translation2.png", // screenshot of language selectors
    buttonText: "Next",
  },
  {
    id: "translations-tutorial-4-edit-exp2ort4",
    title: "Step 4: Edit & Export Translations",
    description: "Review the translated text, make edits if needed, then export in your preferred format (SRT, TXT, DOCX, JSON, etc.). You can also copy or share directly.",
    imageSrc: "/images/export-as.png", // screenshot of edit mode + export options
    buttonText: "Got it!",
  },
];

// Extend the original Transcription type with the extra field
interface DisplayTranscription extends Transcription {
  targetLanguages?: string[];   // optional, since not all transcriptions have translations
  isEditingTitle?: boolean;          // transient UI state
  tempTitle?: string;
}

// Create a quick lookup: code → friendly name
const nllbNameMap = NLLB_LANGUAGES.reduce((acc, lang) => {
  // acc[lang.code] = lang.name + (lang.variant ? ` (${lang.variant})` : "");
  acc[lang.code] = lang.name;
  return acc;
}, {} as Record<string, string>);

export default function TranslationsListPage() {
  const t = useTranslations();
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const [items, setItems] = useState<Transcription[]>([]); // we'll store translated ones here
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const [step, setStep] = useState(0);

  const handleNext = () => {
    if (step < steps.length - 1) {
      setStep(step + 1);
    }
  };

  if (step >= steps.length) return null;

  const current = steps[step];



  useEffect(() => {
    async function load() {
      try {
        const db = await getDb();
        const rows = await db.select<any[]>(
          `
          SELECT 
            t.*,
            GROUP_CONCAT(DISTINCT tr.target_language) as target_languages
          FROM transcriptions t
          LEFT JOIN translations tr ON t.id = tr.transcription_id
          GROUP BY t.id
          HAVING target_languages IS NOT NULL
          ORDER BY t.created_at DESC
          `
        );

        const translatedTranscriptions = rows.map((row) => ({
          id: row.id,
          createdAt: new Date(row.created_at),
          updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
          filename: row.filename,
          title: row.title ?? undefined,
          sourceType: row.source_type,
          sourceUrl: row.source_url ?? undefined,
          duration: row.duration ?? undefined,
          audioPath: row.audio_path ?? undefined,
          fullText: row.full_text,
          detectedLanguage: row.detected_language ?? undefined,
          whisperModel: row.whisper_model ?? undefined,
          whisperTimestamp: row.whisper_timestamp ?? undefined,
          diarizationModel: row.diarization_model ?? undefined,
          diarizationTimestamp: row.diarization_timestamp ?? undefined,
          targetLanguages: row.target_languages
            ? row.target_languages.split(',').map((c: string) => c.trim())
            : [],
        }));

        setItems(translatedTranscriptions);
      } catch (err) {
        console.error("Failed to load translated transcriptions:", err);
        showToast(t("Failed to load translations"), "error");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [t]);

  const startEdit = (item: DisplayTranscription) => {
    setEditingId(item.id);
    setEditTitle(item.title || item.filename || "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle("");
  };

  const saveEdit = async (id: string) => {
    if (!editTitle.trim()) {
      showToast("Title cannot be empty", "error");
      return;
    }

    try {
      const updated = await updateTranscription(id, { title: editTitle.trim() });
      if (updated) {
        setItems(prev =>
          prev.map(it =>
            it.id === id ? { ...it, title: updated.title } : it
          )
        );
        showToast("Title updated", "success");
      }
    } catch (err) {
      console.error("Title update failed:", err);
      showToast("Failed to save title", "error");
    } finally {
      cancelEdit();
    }
  };

  const filtered = items.filter(item =>
    (item.title || item.filename || "")
      .toLowerCase()
      .includes(search.toLowerCase()) ||
    (item.fullText || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen p-6 lg:p-10 bg-background text-foreground">
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-10"
      >
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center shadow-lg">
              <Languages className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-4xl font-black tracking-tight">{t("Translations")}</h1>
              <p className="text-zinc-500 dark:text-zinc-400 mt-1">
                View and manage your translated transcriptions
              </p>
            </div>
          </div>

          <Link href="/transcriptions">
            <button className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-medium flex items-center gap-2">
              <Plus className="w-5 h-5" />
              {t("New Translation")}
            </button>
          </Link>
        </div>
      </motion.div>

      {/* Search */}
      <div className="mb-8 relative max-w-md">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("Search by title or content") + "..."}
          className="w-full pl-12 pr-4 py-3 bg-card border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-pink-500/50"
        />
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
          <Loader2 className="w-12 h-12 animate-spin mb-4" />
          <p>{t("Loading")}...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-2xl p-12 text-center">
          <AlertTriangle className="w-16 h-16 mx-auto mb-6 text-zinc-500 opacity-60" />
          <h3 className="text-2xl font-bold mb-3">
            {search.trim() ? t("No matching translations") : t("No translations yet")}
          </h3>
          <p className="text-zinc-500 mb-6">
            {search.trim()
              ? t("Try different keywords")
              : t("Create a new translation from your transcriptions.")}
          </p>
          <Link href="/transcriptions">
            <button className="px-8 py-4 bg-pink-600 hover:bg-pink-500 text-white rounded-xl font-bold">
              {t("Go to Transcriptions")}
            </button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((item) => {
            const isEditing = editingId === item.id;
            const displayTitle = item.title || item.filename || "Untitled";

            return (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow group"
              >
                <div className="p-6">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {isEditing ? (
                        // Editing mode — no navigation here
                        <div className="flex items-center gap-2">
                          <input
                            autoFocus
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveEdit(item.id);
                              if (e.key === "Escape") cancelEdit();
                            }}
                            className="flex-1 px-2 py-1 bg-zinc-800/50 border border-zinc-700 rounded text-base font-bold focus:outline-none focus:ring-2 focus:ring-pink-500"
                          />
                          <button
                            onClick={() => saveEdit(item.id)}
                            className="p-1.5 text-green-500 hover:text-green-400"
                            title="Save"
                          >
                            <Check size={18} />
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="p-1.5 text-red-500 hover:text-red-400"
                            title="Cancel"
                          >
                            <X size={18} />
                          </button>
                        </div>
                      ) : (
                        // Normal mode — make title + preview clickable
                        <div
                          className="cursor-pointer"
                          onClick={() => router.push(`/translations/detail?id=${item.id}`)}
                        >
                          <div className="flex items-center gap-2 group/title">
                            <h3 className="font-bold text-lg group-hover/title:text-pink-500 transition-colors line-clamp-2">
                              {displayTitle}
                            </h3>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();           // ← prevents navigation
                                startEdit(item);
                              }}
                              className="opacity-0 group-hover/title:opacity-70 hover:opacity-100 transition-opacity p-1 -ml-1"
                              title="Edit title"
                            >
                              <Pencil size={16} className="text-zinc-500 hover:text-zinc-300" />
                            </button>
                          </div>

                          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2">
                            {item.fullText?.slice(0, 120) || "…"}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Icon stays non-clickable for navigation */}
                    <FileText className="w-6 h-6 text-pink-500 opacity-80 flex-shrink-0 mt-1" />
                  </div>

                  {/* Optional: target language badges */}
                  {/* ... */}

                  <div className="mt-4 pt-4 border-t border-border text-xs text-zinc-500 flex items-center gap-4">
                    <div className="flex items-center gap-1.5">
                      <Calendar className="w-4 h-4" />
                      {new Date(item.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}