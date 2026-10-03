// Plant identification + care plan via the Claude API, called straight from the browser
// with the user's own API key (stored only on this device).
// Anthropic TypeScript SDK v0.131.0, bundled locally (see vendor/) so the app has no CDN dependency.
import Anthropic from "./vendor/anthropic-sdk.mjs";

export const DEFAULT_MODEL = "claude-opus-5-5";

const str = { type: "string" };
const strArr = { type: "array", items: str };
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const SCHEMA = obj({
  identified: { type: "boolean" },
  common_name: str,
  scientific_name: str,
  family: str,
  plant_type: str,
  confidence: { type: "string", enum: ["high", "medium", "low"] },
  alternatives: { type: "array", items: obj({ common_name: str, scientific_name: str, reason: str }) },
  description: str,
  health: obj({
    status: { type: "string", enum: ["healthy", "minor issues", "needs attention", "unknown"] },
    observations: str,
    actions: strArr,
  }),
  care: obj({
    sunlight: str,
    watering: str,
    soil: str,
    feeding: str,
    pruning: str,
    pests_diseases: str,
    winter: str,
    hardiness: str,
  }),
  calendar: {
    type: "array",
    items: obj({ month: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }, tasks: strArr }),
  },
  toxicity: str,
  tips: strArr,
});

const SYSTEM = `You are an expert horticulturist helping a home gardener catalogue the plants in their garden.
You will receive one or more photos of a single plant, plus context about where and when the photos were taken.

Identify the plant as precisely as the photos allow (species, and cultivar only if clearly distinguishable).
If you cannot identify it, set identified=false, give your best guess with confidence "low", and use the
description to say what extra photo would help (e.g. flowers, underside of leaves, whole plant, bark).

Then write a practical care plan for this plant in this garden:
- Tailor timings to the hemisphere, approximate climate and current month given in the context.
- Be specific and actionable: quantities, frequencies, which month, what to look for. Plain language, no fluff.
- "calendar" must contain all 12 months (1-12) in order; a month may have an empty task list if nothing is needed.
- Assess health only from what is visible in the photos; say "unknown" if you can't tell.
- "toxicity" covers pets (cats, dogs) and children.
- "tips": 2-4 short, high-value tips specific to this plant.`;

function client(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

function contextText({ lat, lng, notes, settings }) {
  const now = new Date();
  const lines = [`Date: ${now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} (month ${now.getMonth() + 1}).`];
  if (lat != null) {
    lines.push(`Approximate location: ${lat.toFixed(1)}, ${lng.toFixed(1)} (${lat >= 0 ? "northern" : "southern"} hemisphere).`);
  }
  if (settings?.climate) lines.push(`Gardener's notes on their garden/climate: ${settings.climate}`);
  if (notes) lines.push(`Gardener's notes on this plant: ${notes}`);
  return lines.join("\n");
}

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} [o.model]
 * @param {{mediaType:string,data:string}[]} o.images base64 JPEGs
 */
export async function identifyPlant({ apiKey, model, images, lat, lng, notes, settings }) {
  if (!apiKey) throw new Error("Add your Claude API key in Settings to identify plants.");
  const content = [
    ...images.slice(0, 5).map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    })),
    { type: "text", text: contextText({ lat, lng, notes, settings }) + "\n\nIdentify this plant and write its care plan." },
  ];

  let response;
  try {
    response = await client(apiKey).beta.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    throw new Error(friendlyError(err));
  }

  if (response.stop_reason === "refusal") throw new Error("Claude declined to answer for these photos. Try a different photo.");
  if (response.stop_reason === "max_tokens") throw new Error("The answer was cut off. Try again.");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    const result = JSON.parse(text);
    result.calendar = (result.calendar || []).sort((a, b) => a.month - b.month);
    result.model = response.model;
    result.identifiedAt = Date.now();
    return result;
  } catch {
    throw new Error("Couldn't read Claude's answer. Try again.");
  }
}

function friendlyError(err) {
  const status = err?.status;
  if (status === 401) return "Your API key was rejected. Check it in Settings.";
  if (status === 403) return "This API key doesn't have permission to use that model.";
  if (status === 429) return "Too many requests right now. Wait a minute and try again.";
  if (status === 400) return "The request was rejected: " + (err?.error?.error?.message || err.message);
  if (status >= 500) return "Claude is temporarily unavailable. Try again shortly.";
  if (!navigator.onLine) return "You're offline. The plant is saved; identify it when you have signal.";
  return err?.message || "Something went wrong talking to Claude.";
}

/** Downscale a photo File/Blob to a JPEG Blob (long edge <= max). */
export async function resizeImage(file, max = 1568, quality = 0.85) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  let w, h, src;
  if (bitmap) { w = bitmap.width; h = bitmap.height; src = bitmap; }
  else {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(src, 0, 0, canvas.width, canvas.height);
  return new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
