'use client';

import { Lock, Trash2 } from 'lucide-react';
import { useState } from 'react';

export default function SettingsPage() {
  const [cleared, setCleared] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  async function handleClear() {
    setClearError(null);
    try {
      const res  = await fetch('/api/clear', { method: 'POST' });
      // Must check the body, not just the transport: the server previously
      // answered this route with the dashboard's HTML and a 200, which a
      // bare fetch() treated as success. Now the route returns JSON and
      // unknown /api/* paths return a JSON 404 — but the UI still only
      // claims "Cleared" when the server explicitly says it did.
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error ?? `Server responded ${res.status}`);
      setCleared(true);
      setTimeout(() => setCleared(false), 2000);
    } catch (e) {
      setClearError(e instanceof Error ? e.message : 'Could not clear the session');
    }
  }

  return (
    <div className="p-6 max-w-[860px] mx-auto">

      <div className="mb-7">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-[#7c7c7c] text-sm mt-0.5">Data storage · session management</p>
      </div>

      {/* Data storage */}
      <div className="rounded-xl border border-[#1f1f1f] bg-[#111] px-5 py-4 mb-4">
        <p className="text-xs text-[#7c7c7c] uppercase tracking-wider mb-4">Data storage</p>
        <div className="space-y-3 text-sm">
          <div className="flex items-start justify-between py-2 border-b border-[#0d0d0d]">
            <div>
              <p className="text-white font-medium">Session log</p>
              <p className="text-[#7c7c7c] text-xs mt-0.5">Token counts, costs, attribution. Never prompt text.</p>
            </div>
            <code className="text-[11px] text-[#7c7c7c] font-mono bg-[#0a0a0a] px-2 py-1 rounded ml-4 flex-shrink-0">
              .trimwares/session.jsonl
            </code>
          </div>
          <div className="flex items-start justify-between py-2">
            <div>
              <p className="text-white font-medium">History log</p>
              <p className="text-[#7c7c7c] text-xs mt-0.5">Daily aggregates rolled over from session data.</p>
            </div>
            <code className="text-[11px] text-[#7c7c7c] font-mono bg-[#0a0a0a] px-2 py-1 rounded ml-4 flex-shrink-0">
              .trimwares/history.jsonl
            </code>
          </div>
        </div>
      </div>

      {/* Session management */}
      <div className="rounded-xl border border-[#1f1f1f] bg-[#111] px-5 py-4 mb-4">
        <p className="text-xs text-[#7c7c7c] uppercase tracking-wider mb-4">Session management</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-white">Clear session data</p>
            <p className="text-xs text-[#7c7c7c] mt-0.5">
              Archives the current session log to <code className="font-mono">.trimwares/.sessions/</code> and starts fresh. Nothing is deleted.
            </p>
            {clearError && (
              <p className="text-xs text-red-400 mt-1.5" role="alert">Couldn&apos;t clear: {clearError}</p>
            )}
          </div>
          <button
            onClick={handleClear}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[#1f1f1f] text-sm
                       text-[#9a9a9a] hover:text-red-400 hover:border-red-500/30 transition flex-shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {cleared ? 'Cleared' : 'Clear session'}
          </button>
        </div>
      </div>

      {/* Developer-only locked sections */}
      <div className="rounded-xl border border-white/[0.05] bg-[#0a0a0a] px-5 py-4 mb-4 opacity-60">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs text-[#7c7c7c] uppercase tracking-wider">Spend alerts & notifications</p>
          <div className="flex items-center gap-1.5 text-[10px] text-[#7c7c7c]">
            <Lock className="w-3 h-3" />
            Developer
          </div>
        </div>
        <p className="text-xs text-[#7c7c7c] leading-relaxed">
          Set spend thresholds, spike detection, cache rate floors, and desktop notifications.
        </p>
      </div>

      <div className="rounded-xl border border-white/[0.05] bg-[#0a0a0a] px-5 py-4 mb-6 opacity-60">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs text-[#7c7c7c] uppercase tracking-wider">Export data</p>
          <div className="flex items-center gap-1.5 text-[10px] text-[#7c7c7c]">
            <Lock className="w-3 h-3" />
            Developer
          </div>
        </div>
        <p className="text-xs text-[#7c7c7c] leading-relaxed">
          Download session data as JSON, CSV, or Markdown for spreadsheets and audits.
        </p>
      </div>

      {/* Upgrade CTA */}
      <a
        href="https://trimwares.com/trace"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-between px-5 py-4 rounded-xl border border-green-500/15
                   bg-green-500/[0.04] hover:border-green-500/25 hover:bg-green-500/[0.07] transition group"
      >
        <div>
          <p className="text-sm font-medium text-white">View Developer pricing</p>
          <p className="text-xs text-[#7c7c7c] mt-0.5">Alerts, export, 30-day history, and unlimited local storage.</p>
        </div>
        <span className="text-sm text-green-400 font-medium group-hover:text-green-300 transition flex-shrink-0 ml-4">
          trimwares.com/trace →
        </span>
      </a>

    </div>
  );
}
