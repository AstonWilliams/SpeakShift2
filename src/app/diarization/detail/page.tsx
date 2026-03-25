"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import DiarizationDetailPageClient from "@/components/DiarizationDetailPageClient";

function DetailContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const autoRun = searchParams.get("run") === "true";
  const modelName = searchParams.get("model") || undefined;

  if (!id) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 text-center">
        <p className="text-lg text-red-500 dark:text-red-400">
          No diarization ID provided
          <br />
          Please go back and select a diarization from the list
        </p>
      </div>
    );
  }

  return <DiarizationDetailPageClient params={{ id }} autoRun={autoRun} modelName={modelName} />;
}

export default function DiarizationDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-pink-500" />
          <p className="ml-4 text-zinc-400">Loading diarization</p>
        </div>
      }
    >
      <DetailContent />
    </Suspense>
  );
}
