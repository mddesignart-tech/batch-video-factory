import type { Metadata } from "next";
import { Brand, Nav } from "@/components/nav";
import { SystemStatus } from "@/components/system-status";
import "./globals.css";

export const metadata: Metadata = {
  title: "Funny Idioms Video Factory",
  description:
    "Công cụ tạo video ngắn hài hước về thành ngữ tiếng Anh cho YouTube Shorts, TikTok và Reels.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <body>
        <div className="flex min-h-screen">
          <aside className="hidden w-60 shrink-0 border-r border-ink-850 bg-ink-900 md:block">
            <div className="sticky top-0">
              <Brand />
              <Nav />
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <SystemStatus />
            <main className="flex-1 px-6 py-6">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
