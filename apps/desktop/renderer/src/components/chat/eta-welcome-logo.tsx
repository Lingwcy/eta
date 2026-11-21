import { useId } from "react";
import { cn } from "@/lib/utils";

const ETA_GLYPH_PATH =
  "M346.043 330.739L336.036 318.646Q411.509 234.000 450.287 234.000Q487.398 234.000 487.398 275.281Q487.398 287.373 476.557 323.233L446.535 426.643Q517.421 319.897 562.246 276.949Q607.071 234.000 645.850 234.000Q693.802 234.000 693.802 287.790Q693.802 306.137 684.628 339.912L609.156 613.866Q582.052 712.273 582.052 769.815Q582.052 781.491 583.303 794.000L521.590 794.000Q519.089 777.321 519.089 763.144Q519.089 708.103 545.775 612.615L620.414 344.082Q627.503 318.646 627.503 305.720Q627.503 281.952 608.322 281.952Q581.218 281.952 522.424 352.630Q463.631 423.308 416.095 534.640L392.328 611.364L330.198 611.364L416.929 316.144Q421.099 302.384 421.099 295.713Q421.099 279.034 408.590 279.034Q393.162 279.034 346.043 330.739Z";

type GradientStop = {
  offset: string;
  stopColor: string;
  stopOpacity: number;
};

type LogoThemeVariant = {
  theme: "light" | "dark";
  visibilityClass: string;
  stops: readonly GradientStop[];
};

const logoThemeVariants: readonly LogoThemeVariant[] = [
  {
    theme: "light",
    visibilityClass: "block dark:hidden",
    stops: [
      { offset: "0%", stopColor: "#b4b8c0", stopOpacity: 1 },
      { offset: "26%", stopColor: "#c3c6ce", stopOpacity: 1 },
      { offset: "62%", stopColor: "#dadbdf", stopOpacity: 0.94 },
      { offset: "100%", stopColor: "#edeef1", stopOpacity: 0.72 },
    ],
  },
  {
    theme: "dark",
    visibilityClass: "hidden dark:block",
    stops: [
      { offset: "0%", stopColor: "#747a87", stopOpacity: 1 },
      { offset: "26%", stopColor: "#616774", stopOpacity: 1 },
      { offset: "62%", stopColor: "#424650", stopOpacity: 0.94 },
      { offset: "100%", stopColor: "#2b2d33", stopOpacity: 0.72 },
    ],
  },
];

/** Bare Eta calligraphic glyph rendered with calibrated light and dark gradient versions. */
export function EtaWelcomeLogo({ className }: { className?: string }) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <>
      {logoThemeVariants.map(({ theme, visibilityClass, stops }) => {
        const gradientId = `eta-welcome-logo-${rawId}-${theme}`;
        return (
          <svg
            key={theme}
            data-logo-theme={theme}
            viewBox="312 218 400 592"
            fill="none"
            aria-hidden="true"
            focusable="false"
            className={cn(
              "h-16 w-auto shrink-0 select-none min-[901px]:h-[72px]",
              visibilityClass,
              className,
            )}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                {stops.map((stop) => (
                  <stop
                    key={stop.offset}
                    offset={stop.offset}
                    stopColor={stop.stopColor}
                    stopOpacity={stop.stopOpacity}
                  />
                ))}
              </linearGradient>
            </defs>
            <path
              className="eta-welcome-logo-path"
              d={ETA_GLYPH_PATH}
              fill={`url(#${gradientId})`}
            />
          </svg>
        );
      })}
    </>
  );
}
