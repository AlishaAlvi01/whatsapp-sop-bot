// Groq helpers: chat completion, Whisper transcription, and a token budget guard.

const GROQ = "https://api.groq.com/openai/v1";

export async function chat(env, messages, { json = false } = {}) {
  const res = await fetch(`${GROQ}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.GROQ_CHAT_MODEL,
      messages,
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Groq chat ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

/**
 * Transcribe a voice note with Whisper on Groq.
 * normaliseRomanUrdu: a light pass that rewrites Urdu-script output into Roman Urdu,
 * which is how most teams in Pakistan actually type.
 */
export async function transcribe(env, { bytes, mimeType }, { normaliseRomanUrdu = false } = {}) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), "voice.ogg");
  form.append("model", env.GROQ_WHISPER_MODEL || "whisper-large-v3");
  const res = await fetch(`${GROQ}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq whisper ${res.status}: ${await res.text()}`);
  let text = (await res.json()).text.trim();

  if (normaliseRomanUrdu && /[؀-ۿ]/.test(text)) {
    text = await chat(env, [
      { role: "system", content: "Transliterate to Roman Urdu. Keep English words as they are. Output only the text." },
      { role: "user", content: text },
    ]);
  }
  return text;
}

// Rough estimate: ~4 chars per token. Good enough to stay under limits.
const approxTokens = (s) => Math.ceil((s || "").length / 4);

/**
 * Fit labelled text blocks into a token budget.
 * Lower `priority` number = kept first. Lower-priority blocks are truncated, then dropped.
 */
export function fitToBudget(blocks, budget) {
  const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
  let remaining = budget;
  const out = [];
  for (const b of sorted) {
    if (remaining <= 50) break;
    const t = approxTokens(b.text);
    const text = t <= remaining ? b.text : b.text.slice(0, remaining * 4) + "\n…[truncated]";
    out.push(`### ${b.label}\n${text}`);
    remaining -= Math.min(t, remaining);
  }
  return out.join("\n\n");
}
