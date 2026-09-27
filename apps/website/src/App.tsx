import { cn } from "@/lib/utils";
import { Bot, CheckCircle2, Code2, Sparkles, Terminal } from "lucide-react";
import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center p-6 selection:bg-purple-500 selection:text-white">
      <div className="max-w-xl w-full flex flex-col items-center text-center gap-6">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-300 text-sm font-medium">
          <Sparkles className="w-4 h-4 text-purple-400" />
          <span>Eta React &amp; Tailwind v4</span>
        </div>

        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-br from-white via-neutral-200 to-neutral-500 bg-clip-text text-transparent">
          Vite+ with React 19
        </h1>

        <p className="text-neutral-400 text-base sm:text-lg max-w-md">
          Successfully converted to a modern React 19 application with Tailwind CSS v4 and unified
          Vite+ tooling.
        </p>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setCount((c) => c + 1)}
            className={cn(
              "inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm transition-colors shadow-lg cursor-pointer",
              count > 0
                ? "bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/20 text-white"
                : "bg-purple-600 hover:bg-purple-500 shadow-purple-600/20 text-white",
            )}
          >
            Count: {count}
          </button>

          <a
            href="https://viteplus.dev"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-neutral-800/80 hover:bg-neutral-800 text-neutral-200 border border-neutral-700/60 font-medium text-sm transition-colors"
          >
            <Code2 className="w-4 h-4 text-neutral-400" />
            Vite+ Docs
          </a>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full mt-6 text-left">
          <div className="p-4 rounded-xl bg-neutral-900/60 border border-neutral-800/80 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-purple-400 font-semibold text-sm">
              <Bot className="w-4 h-4" />
              <span>@eta/agent</span>
            </div>
            <p className="text-xs text-neutral-400">
              Harness v2 core ready for durable agent workflows.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-neutral-900/60 border border-neutral-800/80 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
              <CheckCircle2 className="w-4 h-4" />
              <span>Tailwind v4</span>
            </div>
            <p className="text-xs text-neutral-400">
              Native CSS @import &quot;tailwindcss&quot; with zero-config Vite plugin.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-neutral-900/60 border border-neutral-800/80 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sky-400 font-semibold text-sm">
              <Terminal className="w-4 h-4" />
              <span>Unified CLI</span>
            </div>
            <p className="text-xs text-neutral-400">
              Integrated `vp dev`, `vp build`, and fast Rust-powered oxlint.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
