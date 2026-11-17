import { Bot } from "lucide-react-native";
import { Image, type ImageSourcePropType } from "react-native";
import { SvgXml } from "react-native-svg";

import antLingIcon from "../../assets/providers/ant-ling.png";
import typesafeIcon from "../../assets/providers/typesafe.png";
import { colors } from "../ui.tsx";
import { PROVIDER_FILE_MAP, PROVIDER_SVG_XML } from "./provider-icon-data.ts";

const toImageSource = (asset: number | string): ImageSourcePropType =>
  typeof asset === "string" ? { uri: asset } : asset;

const PROVIDER_PNG_MAP: Record<string, ImageSourcePropType> = {
  "ant-ling.png": toImageSource(antLingIcon),
  "typesafe.png": toImageSource(typesafeIcon),
};

export type ResolvedProviderAsset =
  | { kind: "svg"; file: string; xml: string }
  | { kind: "image"; file: string; source: ImageSourcePropType };

export function resolveProviderAsset(id?: string): ResolvedProviderAsset | null {
  if (!id) return null;
  const normalized = id.trim().toLowerCase();
  if (!normalized || !Object.hasOwn(PROVIDER_FILE_MAP, normalized)) return null;
  const file = PROVIDER_FILE_MAP[normalized];
  if (!file) return null;
  if (Object.hasOwn(PROVIDER_SVG_XML, file)) {
    return { kind: "svg", file, xml: PROVIDER_SVG_XML[file] };
  }
  if (Object.hasOwn(PROVIDER_PNG_MAP, file)) {
    return { kind: "image", file, source: PROVIDER_PNG_MAP[file] };
  }
  return null;
}

export function ProviderMark({
  id,
  size = 16,
  color = colors.secondary,
}: {
  id?: string;
  size?: number;
  color?: string;
}) {
  const asset = resolveProviderAsset(id);
  if (!asset) {
    return <Bot size={size} strokeWidth={1.85} color={color} />;
  }
  if (asset.kind === "image") {
    return (
      <Image
        accessibilityIgnoresInvertColors
        resizeMode="contain"
        source={asset.source}
        style={{ width: size, height: size, borderRadius: Math.max(2, Math.round(size * 0.18)) }}
      />
    );
  }
  const xml = asset.xml.includes("currentColor")
    ? asset.xml.replaceAll("currentColor", color)
    : asset.xml;
  return <SvgXml xml={xml} width={size} height={size} color={color} />;
}
