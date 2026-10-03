import { expect, test } from "vite-plus/test";
import { ScrollFollow } from "./scroll-follow";

test("streamed content growth does not turn off bottom follow", () => {
  const follow = new ScrollFollow();
  follow.recordFollow(600);
  follow.observeScroll({ scrollTop: 600, scrollHeight: 1500, clientHeight: 400 });
  expect(follow.following).toBe(true);
  follow.recordFollow(1100);
  follow.observeScroll({ scrollTop: 1100, scrollHeight: 1500, clientHeight: 400 });
  expect(follow.following).toBe(true);
});

test("scrolling upward past the threshold pauses follow through subsequent output", () => {
  const follow = new ScrollFollow();
  follow.recordFollow(600);
  follow.observeScroll({ scrollTop: 550, scrollHeight: 1000, clientHeight: 400 });
  expect(follow.following).toBe(true);
  follow.observeScroll({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 });
  expect(follow.following).toBe(false);
  follow.observeScroll({ scrollTop: 500, scrollHeight: 1600, clientHeight: 400 });
  expect(follow.following).toBe(false);
});

test("follow resumes only after returning close to the current bottom", () => {
  const follow = new ScrollFollow();
  follow.recordFollow(600);
  follow.observeScroll({ scrollTop: 400, scrollHeight: 1000, clientHeight: 400 });
  follow.observeScroll({ scrollTop: 540, scrollHeight: 1000, clientHeight: 400 });
  expect(follow.following).toBe(false);
  follow.observeScroll({ scrollTop: 580, scrollHeight: 1000, clientHeight: 400 });
  expect(follow.following).toBe(true);
});

test("viewport growth clamping the scroll position is not an upward reading gesture", () => {
  const follow = new ScrollFollow();
  follow.recordFollow(600);
  follow.observeScroll({ scrollTop: 400, scrollHeight: 1000, clientHeight: 600 });
  expect(follow.following).toBe(true);
});
