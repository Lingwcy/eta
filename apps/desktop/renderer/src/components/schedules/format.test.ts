import { expect, test } from "vite-plus/test";
import { scheduleTime } from "./format";

test("recent schedule times use calendar days across month and year boundaries", () => {
  const now = new Date(2026, 11, 31, 23, 50).getTime();
  expect(scheduleTime(new Date(2026, 11, 31, 9, 5).getTime(), now)).toBe("今天 09:05");
  expect(scheduleTime(new Date(2027, 0, 1, 0, 10).getTime(), now)).toBe("明天 00:10");
  expect(scheduleTime(new Date(2026, 11, 30, 20, 30).getTime(), now)).toBe("昨天 20:30");
  expect(scheduleTime(new Date(2027, 0, 2, 9).getTime(), now)).toBe("后天 09:00");
  expect(scheduleTime(new Date(2027, 0, 3, 9).getTime(), now)).toBe("周日 09:00");
});

test("distant schedule times show month and day, with a year only across years", () => {
  const now = new Date(2026, 9, 14).getTime();
  expect(scheduleTime(new Date(2026, 10, 2, 14, 30).getTime(), now)).toBe("11/2 14:30");
  expect(scheduleTime(new Date(2027, 0, 2, 14, 30).getTime(), now)).toBe("2027/1/2 14:30");
  expect(scheduleTime(null, now)).toBe("无后续执行");
});
