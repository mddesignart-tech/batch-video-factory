import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lint is a separate, explicit step (`npm run lint`) so that a style nit can
  // never block a production build on the operator's machine.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  // ffmpeg-static / ffprobe-static ship real .exe files. They must stay external
  // to the server bundle or Next will try to trace and rewrite the binaries.
  // The job worker is booted once from src/instrumentation.ts, which Next 15
  // loads automatically (no experimental flag needed).
  serverExternalPackages: ["@prisma/client", "ffmpeg-static", "ffprobe-static"],
  // Storyboard images are uploaded through server actions. The 1 MB default
  // refuses an ordinary 2 MB PNG, so the limit is raised to match what the
  // import itself accepts (40 MB per image; one batch upload stays well under).
  experimental: { serverActions: { bodySizeLimit: "500mb" } },
};

export default nextConfig;
