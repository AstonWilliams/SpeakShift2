import type { Metadata } from "next";
import "./globals.css";
import { Space_Grotesk } from "next/font/google";
import AppShellClient from "@/components/AppShellClient";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

export const metadata: Metadata = {
  title: "SpeakShift",
  description: "A modern desktop studio for creators.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable}`} suppressHydrationWarning>
      <body className="antialiased font-sans bg-[#F8F9FB] dark:bg-zinc-950 text-[#1A1A1A] dark:text-zinc-100">
        <AppShellClient>{children}</AppShellClient>
      </body>
    </html>
  );
}