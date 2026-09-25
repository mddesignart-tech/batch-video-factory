"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  Boxes,
  Clapperboard,
  Cpu,
  FileText,
  Film,
  LayoutDashboard,
  Layers,
  Palette,
  Settings,
  Sparkles,
  Users,
  Wallet,
  FileUp,
  ListChecks,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Vietnamese admin navigation, per the product spec. */
const NAV_ITEMS = [
  { href: "/", label: "Tổng quan", icon: LayoutDashboard },
  { href: "/idioms", label: "Thành ngữ", icon: Sparkles },
  { href: "/projects", label: "Dự án video", icon: Clapperboard },
  { href: "/batches", label: "Tạo hàng loạt", icon: Layers },
  { href: "/import", label: "Nhập Storyboard", icon: FileUp },
  { href: "/queue", label: "Hàng đợi", icon: ListChecks },
  { href: "/characters", label: "Nhân vật", icon: Users },
  { href: "/styles", label: "Phong cách", icon: Palette },
  { href: "/media", label: "Media", icon: Film },
  { href: "/costs", label: "Chi phí", icon: Wallet },
  { href: "/providers", label: "Nhà cung cấp AI", icon: Bot },
  { href: "/models", label: "Mô hình AI", icon: Cpu },
  { href: "/settings", label: "Cài đặt", icon: Settings },
  { href: "/logs", label: "Nhật ký", icon: FileText },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5 px-3">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-ink-800 font-medium text-ink-100"
                : "text-ink-400 hover:bg-ink-850 hover:text-ink-200",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-6 py-5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-ink-950">
        <Boxes className="h-4.5 w-4.5" />
      </div>
      <div className="leading-tight">
        <p className="text-[13px] font-semibold text-ink-100">Funny Idioms</p>
        <p className="text-[11px] text-ink-500">Video Factory</p>
      </div>
    </Link>
  );
}
