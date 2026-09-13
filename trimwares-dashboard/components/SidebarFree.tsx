'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LayoutDashboard, PieChart, BarChart3, Bell, Settings, Lightbulb, Lock, Layers } from 'lucide-react';
import { clsx } from 'clsx';
import { useProject } from '@/hooks/useProject';

const freeItems = [
  { href: '/',                label: 'Overview',        icon: LayoutDashboard },
  { href: '/recommendations', label: 'Recommendations', icon: Lightbulb },
  { href: '/attribution',     label: 'Attribution',     icon: PieChart },
  { href: '/models',          label: 'Models',          icon: BarChart3 },
];

const lockedItems = [
  { href: '/history',   label: '30-day Analytics',       icon: BarChart3 },
  { href: '/alerts',    label: 'Spend Alerts',           icon: Bell },
  { href: '/projects',  label: 'Multi-project dashboard', icon: Layers },
];

export function SidebarFree() {
  const path = usePathname();
  const { project } = useProject();
  const [projectLabel, setProjectLabel] = useState('All sessions');

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(d => {
        const list = d.projects ?? [];
        if (list.length > 0) setProjectLabel(list[0].name ?? 'Current project');
      })
      .catch(() => {});
  }, []);

  const activeLabel = project ?? projectLabel;

  return (
    <>
      <aside className="w-56 flex-shrink-0 border-r border-white/[0.08] flex flex-col">

        {/* Logo */}
        <div className="h-14 flex items-center gap-2 px-5 border-b border-white/[0.08]">
          <img src="/icon.png" alt="" className="w-5 h-5 rounded-sm" />
          <span className="text-sm font-semibold tracking-tight">Trace</span>
          <span className="text-[10px] text-[#7c7c7c] font-normal">by Trimwares</span>
          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-[#1f1f1f] text-[#9a9a9a] font-mono">Free</span>
        </div>

        {/* Current project — static (single-project on Free tier) */}
        <div className="px-3 py-3 border-b border-white/[0.08]">
          <div className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-[#111] text-sm">
            <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
            <span className="truncate text-[#ccc] flex-1">{activeLabel}</span>
          </div>
        </div>

        {/* Nav — free items */}
        <nav className="flex-1 px-3 py-3 space-y-0.5">
          {freeItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition',
                path === href ? 'bg-[#1a1a1a] text-white' : 'text-[#9a9a9a] hover:text-white hover:bg-[#141414]',
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
            </Link>
          ))}

          {/* Divider */}
          <div className="pt-2 pb-1 px-3">
            <p className="text-[10px] text-[#707070] uppercase tracking-widest font-medium">Developer</p>
          </div>

          {/* Locked items — these pages don't exist in the free build, so
              linking to their in-app routes lands on a 404. Send to the
              Developer pricing context instead (same funnel as the card
              CTAs: anchors above pricing go to /trace, only the checkout
              button goes to Creem). */}
          {lockedItems.map(({ href, label, icon: Icon }) => (
            <a
              key={href}
              href="https://www.trimwares.com/trace"
              target="_blank"
              rel="noopener noreferrer"
              title={`${label} — Developer feature. View Developer pricing`}
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-[#7c7c7c] hover:text-[#9a9a9a] hover:bg-[#141414] transition group"
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">{label}</span>
              <Lock className="w-3 h-3 flex-shrink-0 opacity-50" />
            </a>
          ))}
        </nav>

        {/* Bottom */}
        <div className="px-3 py-3 border-t border-white/[0.08] space-y-0.5">
          <Link
            href="/settings"
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-[#9a9a9a] hover:text-white hover:bg-[#141414] transition"
          >
            <Settings className="w-4 h-4" />
            Settings
          </Link>

          {/* Upgrade card */}
          <a
            href="https://trimwares.com/trace"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 block px-3 py-3 rounded-md bg-[#111] border border-white/[0.08] hover:border-green-500/30 hover:bg-[#131f15] transition group"
          >
            <p className="text-[11px] text-[#7c7c7c] mb-1">Free — 7-day history</p>
            <p className="text-[11px] text-[#9a9a9a] mb-2 leading-relaxed">
              Multi-project dashboard, unlimited history, spend alerts, and export in Developer.
            </p>
            <span className="text-[11px] text-green-400 font-medium group-hover:text-green-300 transition">
              View Developer pricing →
            </span>
          </a>
        </div>
      </aside>

    </>
  );
}
