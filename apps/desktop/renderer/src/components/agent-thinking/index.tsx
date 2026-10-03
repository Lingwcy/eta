import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Status } from "@/components/ui/status";
import { Shimmer } from "@/components/ui/shimmer";

/** Displays the current harness operation with a timer that updates once a second. */
export function AgentThinking({
  label = "正在思考",
  startedAt,
}: {
  label?: string;
  startedAt?: number;
}) {
  const [elapsed, setElapsed] = useState(() =>
    startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : 0,
  );
  useEffect(() => {
    const started = startedAt ?? Date.now();
    const update = () => setElapsed(Math.max(0, (Date.now() - started) / 1000));
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  return (
    <Status
      icon={<Sparkles size={18} className="animate-pulse motion-reduce:animate-none" />}
      detail={`${Math.floor(elapsed)}s`}
    >
      <Shimmer>{label}</Shimmer>
    </Status>
  );
}
