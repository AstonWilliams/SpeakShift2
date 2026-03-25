"use client";

import { ThemeProvider } from "@/components/ThemeProvider";
import { Sidebar } from "@/components/Sidebar";
import ErrorReporter from "@/components/ErrorReporter";
import IntlProvider from "@/lib/IntlProvider";
import { useTranscriptionCompletedListener } from "@/lib/hooks/useTranscriptionListener";
import VisualEditsMessenger from "@/visual-edits/VisualEditsMessenger";

export default function AppShellClient({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  useTranscriptionCompletedListener();

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      <IntlProvider initialLocale="en">
        <ErrorReporter />

        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 lg:ml-64 relative">{children}</main>
        </div>

        <VisualEditsMessenger />
      </IntlProvider>
    </ThemeProvider>
  );
}
