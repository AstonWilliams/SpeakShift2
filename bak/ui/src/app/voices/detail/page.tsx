"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Download, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { getTtsTask } from "@/lib/audioVoiceDb";
import { showToast } from "@/lib/toast";
import { invoke } from "@tauri-apps/api/core";

function DetailContent() {
  const searchParams = useSearchParams();
  const taskId = searchParams.get("id");

  const [task, setTask] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);

  const parsedInput = useMemo(() => {
    if (!task?.inputJson) return null;
    try {
      return JSON.parse(task.inputJson);
    } catch {
      return null;
    }
  }, [task]);

  const parsedResult = useMemo(() => {
    if (!task?.resultJson) return null;
    try {
      return JSON.parse(task.resultJson);
    } catch {
      return null;
    }
  }, [task]);

  const artifactFileName = useMemo(() => {
    if (!task?.artifactPath) return "No artifact available";
    return task.artifactPath.split(/[\\/]/).pop() || "artifact";
  }, [task]);

  useEffect(() => {
    if (!taskId) return;

    const loadTask = async () => {
      setIsLoading(true);
      try {
        const row = await getTtsTask(taskId);
        if (!row) {
          showToast("Task not found", "error");
          return;
        }
        setTask(row);
      } catch (err) {
        console.error(err);
        showToast("Failed to load task details", "error");
      } finally {
        setIsLoading(false);
      }
    };

    loadTask();
  }, [taskId]);

  const handleOpenArtifact = async () => {
    if (!task?.artifactPath) return;
    setIsExporting(true);
    try {
      await invoke("open_file_in_explorer", { path: task.artifactPath });
      showToast("Opened containing folder", "success");
    } catch (err) {
      showToast("Could not open file location", "error");
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <span>Loading task details...</span>
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-center">
        <h1 className="text-2xl font-semibold mb-4">Task not found</h1>
        <p className="text-muted-foreground mb-6">
          The requested task could not be loaded.
        </p>
        <Button asChild variant="outline">
          <Link href="/voices">Back to Voices</Link>
        </Button>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="min-h-screen bg-background px-6 py-10 lg:px-12"
    >
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-10 flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/voices">
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{task.title}</h1>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-sm text-muted-foreground capitalize">
                {task.kind.replace("_", " ")}
              </span>
              <span
                className={`text-xs px-3 py-1 rounded-full font-medium ${
                  task.status === "completed"
                    ? "bg-emerald-500/20 text-emerald-400"
                    : task.status === "failed"
                    ? "bg-red-500/20 text-red-400"
                    : "bg-amber-500/20 text-amber-400"
                }`}
              >
                {task.status}
              </span>
            </div>
          </div>
        </div>

        {/* Progress Card */}
        <div className="rounded-2xl border border-border/50 bg-card/60 p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Progress</h2>
            <span className="text-lg font-bold">{Math.round(task.progress)}%</span>
          </div>
          <Progress value={task.progress} className="h-3 mb-4" />
          {task.stage && (
            <p className="text-sm text-muted-foreground">
              Current stage: <span className="font-medium capitalize">{task.stage}</span>
            </p>
          )}
          {task.message && (
            <p className="mt-3 text-sm text-muted-foreground italic border-l-4 border-primary/40 pl-4">
              {task.message}
            </p>
          )}
        </div>

        {/* Input & Result */}
        <div className="grid gap-6 lg:grid-cols-2 mb-10">
          <div className="rounded-2xl border border-border/50 bg-card/60 p-6">
            <h2 className="text-xl font-semibold mb-4">Input Parameters</h2>
            <pre className="bg-muted/40 p-5 rounded-xl text-sm overflow-auto max-h-96 font-mono whitespace-pre-wrap">
              {JSON.stringify(parsedInput ?? { message: "No input data available" }, null, 2)}
            </pre>
          </div>

          <div className="rounded-2xl border border-border/50 bg-card/60 p-6">
            <h2 className="text-xl font-semibold mb-4">Result / Output</h2>
            <pre className="bg-muted/40 p-5 rounded-xl text-sm overflow-auto max-h-96 font-mono whitespace-pre-wrap">
              {JSON.stringify(parsedResult ?? { message: "No result data yet" }, null, 2)}
            </pre>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-4">
          {task.artifactPath && (
            <Button
              onClick={handleOpenArtifact}
              disabled={isExporting}
              className="gap-2 min-w-[180px] bg-gradient-to-r from-emerald-600 via-purple-600 to-pink-600 hover:opacity-90 shadow-lg"
            >
              {isExporting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              Open / Save Artifact
            </Button>
          )}

          <Button variant="outline" className="gap-2" disabled>
            <RefreshCw className="size-4" />
            Re-run Task
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

export default function VoiceTaskDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span>Loading task details...</span>
          </div>
        </div>
      }
    >
      <DetailContent />
    </Suspense>
  );
}