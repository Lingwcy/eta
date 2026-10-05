import { useEffect, useState } from "react";
import { Clock3, Sparkles } from "lucide-react";
import { Status } from "@/components/ui/status";

/** Displays the observed phase duration without a continuously repainting activity animation. */
export function AgentThinking({
  label = "正在思考",
  startedAt,
  waiting = false,
}: {
  label?: string;
  startedAt?: number;
  waiting?: boolean;
}) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  const elapsed = Math.max(0, (now - (startedAt ?? mountedAt)) / 1000);
  return (
    <Status
      icon={waiting ? <Clock3 size={18} /> : <Sparkles size={18} />}
      detail={`${Math.floor(elapsed)}s`}
    >
      <span>{waiting && elapsed >= 30 ? `${label}（耗时较长）` : label}</span>
    </Status>
  );
}
