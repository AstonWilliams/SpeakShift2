"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  FileAudio,
  Mic2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
  Youtube,
} from "lucide-react";
import {
  deleteTranscription,
  listTranscriptions,
  updateTranscription,
  type Transcription,
} from "@/lib/transcriptionDb";
import { showToast } from "@/lib/toast";

type SortOption = "newest" | "oldest" | "name";

export default function DiarizationPage() {
  const router = useRouter();
  const t = useTranslations();

  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isSavingRename, setIsSavingRename] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; title: string } | null>(null);

  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<Transcription[]>([]);
  const [sortBy, setSortBy] = useState<SortOption>("newest");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(9);

  useEffect(() => {
    setMounted(true);
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const transcriptions = await listTranscriptions();
      setEntries(transcriptions.filter((t) => Boolean(t.diarizationTimestamp)));
    } catch (err) {
      console.error("Failed to load diarization entries:", err);
      showToast(t("Failed to load diarization entries"), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const filteredEntries = useMemo(() => {
    if (!search.trim()) return entries;
    return entries.filter((entry) => {
      const title = (entry.title || entry.filename).toLowerCase();
      const text = (entry.fullText || "").toLowerCase();
      const q = search.toLowerCase();
      return title.includes(q) || text.includes(q);
    });
  }, [entries, search]);

  const displayedEntries = useMemo(() => {
    const sorted = [...filteredEntries].sort((a, b) => {
      if (sortBy === "newest") return b.createdAt.getTime() - a.createdAt.getTime();
      if (sortBy === "oldest") return a.createdAt.getTime() - b.createdAt.getTime();
      if (sortBy === "name") return (a.title || a.filename).localeCompare(b.title || b.filename);
      return 0;
    });
    return sorted;
  }, [filteredEntries, sortBy]);

  useEffect(() => {
    setCurrentPage(1);
  }, [search, sortBy, entries]);

  const totalPages = Math.max(1, Math.ceil(displayedEntries.length / pageSize));

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedEntries = displayedEntries.slice(startIndex, endIndex);

  const sourceIcon = (sourceType: Transcription["sourceType"]) => {
    if (sourceType === "youtube") return <Youtube className="w-5 h-5 text-red-500" />;
    if (sourceType === "recording") return <Mic2 className="w-5 h-5 text-blue-500" />;
    return <FileAudio className="w-5 h-5 text-pink-500" />;
  };

  const handleRename = async () => {
    if (!renamingId) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) {
      showToast(t("Title cannot be empty"), "error");
      return;
    }

    setIsSavingRename(true);
    try {
      await updateTranscription(renamingId, { title: nextTitle });
      showToast(t("Diarization renamed"), "success");
      setRenamingId(null);
      setRenameValue("");
      await loadData();
    } catch (err) {
      console.error("Failed to rename diarization:", err);
      showToast(t("Failed to rename diarization"), "error");
    } finally {
      setIsSavingRename(false);
    }
  };

  const handleDelete = (entry: Transcription) => {
    const label = entry.title || entry.filename;
    setDeleteConfirm({ id: entry.id, title: label });
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;

    setDeletingId(deleteConfirm.id);
    try {
      const deleted = await deleteTranscription(deleteConfirm.id);
      if (!deleted) {
        showToast(t("Diarization not found"), "error");
        return;
      }

      showToast(t("Diarization deleted"), "success");
      setDeleteConfirm(null);
      await loadData();
    } catch (err) {
      console.error("Failed to delete diarization:", err);
      showToast(t("Failed to delete diarization"), "error");
    } finally {
      setDeletingId(null);
    }
  };


  if (!mounted) return null;

  if (loading) {
    return (
      <div className="min-h-screen p-8 lg:p-12 flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-pink-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-8 lg:p-12">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-4xl lg:text-5xl font-black tracking-tight">{t("Diarization")}</h1>
            <p className="mt-2 text-zinc-500 dark:text-zinc-400">
              {t("Diarization Page Description")}
            </p>
          </div>

          <button
            onClick={() => router.push("/transcriptions")}
            className="px-6 py-3 rounded-xl font-semibold bg-pink-600 hover:bg-pink-700 text-white inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            {t("New Diarization")}
          </button>
        </header>

        <div className="mb-6 flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
          <div className="flex items-center gap-2 w-full lg:w-136">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search diarization entries")}
            className="flex-1 px-4 py-3 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
          />
          <button
            onClick={() => setSearch((prev) => prev.trim())}
            className="px-4 py-3 rounded-xl font-medium bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 inline-flex items-center gap-2"
          >
            <Search className="w-4 h-4" />
            {t("Search")}
          </button>
          </div>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="px-4 py-3 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
          >
            <option value="newest">{t("Newest first")}</option>
            <option value="oldest">{t("Oldest first")}</option>
            <option value="name">{t("By name")}</option>
          </select>
        </div>

        {displayedEntries.length === 0 ? (
          <div className="rounded-3xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-10 text-center">
            <Users className="w-10 h-10 mx-auto mb-3 text-zinc-400" />
            <p className="text-zinc-500">{t("No diarization entries yet")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {paginatedEntries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5"
              >
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="inline-flex items-center gap-2">
                    {sourceIcon(entry.sourceType)}
                    <span className="text-xs font-medium text-zinc-500 uppercase">{entry.sourceType}</span>
                  </div>
                  <span className="text-xs text-zinc-500 inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {entry.createdAt.toLocaleDateString()}
                  </span>
                </div>

                {renamingId === entry.id ? (
                  <div className="mb-3 space-y-2">
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleRename();
                        if (e.key === "Escape") {
                          setRenamingId(null);
                          setRenameValue("");
                        }
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
                      autoFocus
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleRename()}
                        disabled={isSavingRename}
                        className="px-3 py-1.5 text-xs rounded-lg bg-green-600 hover:bg-green-700 text-white disabled:opacity-50"
                      >
                        {t("Save")}
                      </button>
                      <button
                        onClick={() => {
                          setRenamingId(null);
                          setRenameValue("");
                        }}
                        disabled={isSavingRename}
                        className="px-3 py-1.5 text-xs rounded-lg bg-zinc-600 hover:bg-zinc-700 text-white"
                      >
                        {t("Cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <h3 className="text-lg font-bold mb-2 line-clamp-2">{entry.title || entry.filename}</h3>
                )}
                <p className="text-sm text-zinc-500 dark:text-zinc-400 line-clamp-3 mb-4">{entry.fullText}</p>

                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/diarization/detail?id=${entry.id}`}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-pink-600 hover:text-pink-500"
                  >
                    {t("Open Diarization Detail")}
                    <ArrowRight className="w-4 h-4" />
                  </Link>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setRenamingId(entry.id);
                        setRenameValue(entry.title || entry.filename);
                      }}
                      className="p-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800"
                      aria-label={t("Rename diarization")}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(entry)}
                      disabled={deletingId === entry.id}
                      className="p-2 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 disabled:opacity-50"
                      aria-label={t("Delete diarization")}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {displayedEntries.length > 0 && (
          <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="text-sm text-zinc-500 dark:text-zinc-400">
              {t("Showing")} {displayedEntries.length === 0 ? 0 : startIndex + 1} - {Math.min(displayedEntries.length, endIndex)} {t("of")} {displayedEntries.length}
            </div>

            <div className="flex items-center gap-2">
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
              >
                <option value={6}>6 / page</option>
                <option value={9}>9 / page</option>
                <option value={12}>12 / page</option>
              </select>

              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-3 py-2 rounded-lg bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 disabled:opacity-50"
              >
                {t("Prev")}
              </button>

              <span className="px-3 text-sm">
                {currentPage} / {totalPages}
              </span>

              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-3 py-2 rounded-lg bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 disabled:opacity-50"
              >
                {t("Next")}
              </button>
            </div>
          </div>
        )}

        {deleteConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
            <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-950 text-white p-6 shadow-2xl">
              <div className="flex items-start gap-3 mb-4">
                <div className="mt-0.5">
                  <AlertTriangle className="w-6 h-6 text-red-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold">{t("Delete Diarization?")}</h3>
                  <p className="text-sm text-zinc-300 mt-2">
                    {t("Are you sure you want to delete diarization")} <strong>"{deleteConfirm.title}"</strong>? {t("This action cannot be undone")}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  disabled={deletingId === deleteConfirm.id}
                  className="px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700"
                >
                  {t("Cancel")}
                </button>
                <button
                  onClick={() => void confirmDelete()}
                  disabled={deletingId === deleteConfirm.id}
                  className="px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50"
                >
                  {deletingId === deleteConfirm.id ? t("Deleting") : t("Yes, Delete")}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
