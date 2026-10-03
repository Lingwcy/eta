const assets = import.meta.glob<string>("../../../assets/providers/*.{svg,png}", {
  eager: true,
  query: "?url",
  import: "default",
});

// Region and subscription variants use the same supplier's brand mark.
const files: Record<string, string> = {
  "amazon-bedrock": "bedrock-color.svg",
  "ant-ling": "ant-ling.png",
  anthropic: "anthropic.svg",
  "azure-openai-responses": "azure-color.svg",
  baseten: "baseten.svg",
  cerebras: "cerebras-color.svg",
  "cloudflare-ai-gateway": "cloudflare-color.svg",
  "cloudflare-workers-ai": "cloudflare-color.svg",
  deepseek: "deepseek-color.svg",
  fireworks: "fireworks-color.svg",
  "github-copilot": "github.svg",
  google: "google-color.svg",
  "google-vertex": "vertexai-color.svg",
  groq: "groq.svg",
  huggingface: "huggingface-color.svg",
  "kimi-coding": "kimi.svg",
  meta: "meta-color.svg",
  minimax: "minimax-color.svg",
  "minimax-cn": "minimax-color.svg",
  mistral: "mistral-color.svg",
  moonshotai: "moonshot.svg",
  "moonshotai-cn": "moonshot.svg",
  nvidia: "nvidia-color.svg",
  openai: "openai.svg",
  "openai-codex": "openai.svg",
  opencode: "opencode.svg",
  "opencode-go": "opencode.svg",
  openrouter: "openrouter.svg",
  "qwen-token-plan": "qwen-color.svg",
  "qwen-token-plan-cn": "qwen-color.svg",
  "qwen-token-plan-individual": "qwen-color.svg",
  radius: "radius.svg",
  together: "together-color.svg",
  typesafe: "typesafe.png",
  "vercel-ai-gateway": "vercel.svg",
  xai: "xai.svg",
  xiaomi: "xiaomimimo.svg",
  "xiaomi-token-plan-ams": "xiaomimimo.svg",
  "xiaomi-token-plan-cn": "xiaomimimo.svg",
  "xiaomi-token-plan-sgp": "xiaomimimo.svg",
  zai: "zai.svg",
  "zai-coding-cn": "zai.svg",
};

export function providerLogoUrl(id: string) {
  const file = files[id];
  return file ? assets[`../../../assets/providers/${file}`] : undefined;
}
