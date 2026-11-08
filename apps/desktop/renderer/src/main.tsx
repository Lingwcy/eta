import { StrictMode } from "react";
import { appearance } from "./appearance.ts";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ToastProvider } from "./components/ui/toast.tsx";
import { I18nextProvider } from "react-i18next";
import { i18n, initializeLocale } from "./i18n";
import "./style.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Failed to find the root element");
}

const stopAppearance = appearance.connect(window.eta);
window.addEventListener("pagehide", stopAppearance, { once: true });
if (import.meta.hot) import.meta.hot.dispose(stopAppearance);

void initializeLocale(window.eta).then(() =>
  createRoot(rootElement).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </I18nextProvider>
    </StrictMode>,
  ),
);
