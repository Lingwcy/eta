// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { i18n } from "@/i18n";
import {
  ChatWelcome,
  selectWelcomeGreetingKey,
  welcomeGreetingKeys,
  type WelcomeGreetingKey,
} from "./chat-welcome";

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  await i18n.changeLanguage("zh-CN");
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function renderWelcome() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (nextConnecting: boolean) =>
    createElement(I18nextProvider, {
      i18n,
      children: createElement(ChatWelcome, { connecting: nextConnecting }),
    });
  return { container, root, render };
}

test("selectWelcomeGreetingKey clamps boundary inputs and avoids excluding repeats", () => {
  expect(selectWelcomeGreetingKey({ random: () => 0 })).toBe(welcomeGreetingKeys[0]);
  expect(selectWelcomeGreetingKey({ random: () => 0.999999 })).toBe(welcomeGreetingKeys.at(-1));
  expect(selectWelcomeGreetingKey({ random: () => -1 })).toBe(welcomeGreetingKeys[0]);
  expect(selectWelcomeGreetingKey({ random: () => 1 })).toBe(welcomeGreetingKeys.at(-1));
  expect(selectWelcomeGreetingKey({ random: () => Number.NaN })).toBe(welcomeGreetingKeys[0]);

  const exclude = welcomeGreetingKeys[2];
  const remainingCount = welcomeGreetingKeys.length - 1;
  const seen = new Set<WelcomeGreetingKey>();
  for (let i = 0; i < remainingCount; i++) {
    const picked = selectWelcomeGreetingKey({
      exclude,
      random: () => (i + 0.5) / remainingCount,
    });
    expect(picked).not.toBe(exclude);
    seen.add(picked);
  }
  expect(seen.size).toBe(remainingCount);
});

test("ChatWelcome renders themed Eta logo variants, preserves greeting across rerenders, and translates live", async () => {
  const { container, root, render } = renderWelcome();
  await act(async () => root.render(render(false)));

  const lightLogo = container.querySelector<SVGSVGElement>('svg[data-logo-theme="light"]');
  const darkLogo = container.querySelector<SVGSVGElement>('svg[data-logo-theme="dark"]');
  expect(lightLogo).not.toBeNull();
  expect(darkLogo).not.toBeNull();
  expect(lightLogo?.getAttribute("aria-hidden")).toBe("true");
  expect(darkLogo?.getAttribute("aria-hidden")).toBe("true");
  expect(lightLogo?.getAttribute("class")).toContain("dark:hidden");
  expect(darkLogo?.getAttribute("class")).toContain("dark:block");
  expect(lightLogo?.querySelector("stop")?.getAttribute("stop-color")).toBe("#b4b8c0");
  expect(darkLogo?.querySelector("stop")?.getAttribute("stop-color")).toBe("#747a87");
  expect(lightLogo?.querySelector("rect")).toBeNull();
  expect(darkLogo?.querySelector("rect")).toBeNull();

  const heading = container.querySelector("h2");
  expect(heading).not.toBeNull();
  const zhText = heading!.textContent;
  const zhPool = welcomeGreetingKeys.map((key) => i18n.t(key, { lng: "zh-CN" }));
  const matchedIndex = zhPool.findIndex((candidate) => candidate === zhText);
  expect(matchedIndex).toBeGreaterThanOrEqual(0);
  expect(container.querySelector("output")).toBeNull();

  // Rerendering with connecting=true keeps the exact same greeting and shows status output.
  await act(async () => root.render(render(true)));
  expect(container.querySelector("h2")?.textContent).toBe(zhText);
  expect(container.querySelector("output")?.textContent).toBe("正在准备 Agent…");

  // Switching locale translates the selected greeting key in place without reshuffling.
  await act(async () => {
    await i18n.changeLanguage("en");
  });
  const expectedEn = i18n.t(welcomeGreetingKeys[matchedIndex]!, { lng: "en" });
  expect(container.querySelector("h2")?.textContent).toBe(expectedEn);
  expect(container.querySelector("output")?.textContent).toBe("Preparing the agent…");

  // Switching back restores the exact original Chinese greeting.
  await act(async () => {
    await i18n.changeLanguage("zh-CN");
  });
  expect(container.querySelector("h2")?.textContent).toBe(zhText);
});

test("mounting multiple ChatWelcome instances yields unique SVG gradient IDs and distinct back-to-back greetings", async () => {
  const first = renderWelcome();
  const second = renderWelcome();
  await act(async () => {
    first.root.render(first.render(false));
    second.root.render(second.render(false));
  });

  const gradientIds = [...document.querySelectorAll("linearGradient")].map((el) => el.id);
  expect(gradientIds).toHaveLength(4);
  expect(new Set(gradientIds).size).toBe(4);

  const firstText = first.container.querySelector("h2")?.textContent;
  const secondText = second.container.querySelector("h2")?.textContent;
  expect(firstText).toBeTruthy();
  expect(secondText).toBeTruthy();
  expect(secondText).not.toBe(firstText);
});
