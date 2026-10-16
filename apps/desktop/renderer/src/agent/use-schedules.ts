import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { t } from "@/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopScheduleSnapshot } from "../../../src/shared/schedules.ts";
import type { ScheduleRequest } from "@eta/core/shared/schedules";

/** One store subscription serves sidebar, inspector and chat origins without renderer polling. */
export function useSchedules() {
  const [snapshot, setSnapshot] = useState<DesktopScheduleSnapshot>({ snapshots: [] });
  const [error, setError] = useState<Message>();
  const active = useRef(true);
  const loading = useRef<Promise<void> | undefined>(undefined);
  const again = useRef(false);
  const requests = useRef(new Map<string, string>());
  const refresh = useCallback(() => {
    if (loading.current) {
      again.current = true;
      return loading.current;
    }
    loading.current = (async () => {
      do {
        again.current = false;
        try {
          const value = await window.eta.scheduleSnapshot();
          if (active.current) {
            setSnapshot(value);
            setError(undefined);
          }
        } catch (error) {
          if (active.current)
            setError(
              describeError(error, localizedMessage("chat:useSchedules.cannotReadScheduledTasks")),
            );
        }
      } while (again.current && active.current);
    })().finally(() => {
      loading.current = undefined;
    });
    return loading.current;
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    const stop = window.eta.subscribeSchedules(() => {
      void refresh();
    });
    return () => {
      active.current = false;
      stop();
    };
  }, [refresh]);
  const mutate = async (
    key: string,
    action: (requestId: string) => Promise<ScheduleRequest>,
    threadId: string,
  ) => {
    const prior = requests.current.get(key);
    const requestId = prior ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    const query = () => window.eta.scheduleRequest(threadId, requestId).catch(() => undefined);
    let result = prior ? await query() : undefined;
    if (!result) {
      try {
        result = await action(requestId);
      } catch (error) {
        result = await query();
        if (!result) throw error;
      }
    }
    await refresh();
    if (result.state !== "pending") requests.current.delete(key);
    if (result.state === "rejected")
      throw new Error(result.reason ?? t("chat:useSchedules.theScheduledTaskRequestWasRejected"));
    return result;
  };
  return { snapshot, error, refresh, mutate };
}
export type SchedulesController = ReturnType<typeof useSchedules>;
