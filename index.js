/**
 * WhatsApp SOP Assistant — Cloudflare Worker template
 *
 * Team members message a WhatsApp Business number and get answers grounded
 * in their role's SOP documents (Google Docs). Admins can add SOPs, manage
 * users, and resolve contradictions — all from WhatsApp.
 *
 * Features
 *  - Role-based access to SOP docs (KV team directory)
 *  - Q&A grounded in primary SOP docs + read-only reference docs
 *  - /sop <text>   → AI-polished SOP entry appended to the role's doc
 *  - Contradiction check before saving, resolved via buttons
 *      (Replace / Keep Both / Cancel)
 *  - /adduser, /removeuser admin commands
 *  - Voice notes → Whisper transcription → normal text flow
 *  - Greeting by name on first message in a 24h window
 *  - Token budget guard so long docs never blow the LLM context
 *
 * Stack: Cloudflare Workers + KV, WhatsApp Cloud API, Groq (LLM + Whisper),
 *        Google Docs API via service account.
 */

import { sendText, sendButtons, sendList, markRead, downloadMedia } from "./whatsapp.js";
import { chat, transcribe, fitToBudget } from "./groq.js";
import { readDoc, appendToDoc, replaceInDoc } from "./gdocs.js";

const GREETING_WINDOW_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_SECONDS = 60 * 30; // pending decisions expire after 30 min

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Meta webhook verification handshake
    if (request.method === "GET" && url.pathname === "/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === env.WA_VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const body = await request.json().catch(() => null);
      // Ack Meta immediately; do the work in the background.
      ctx.waitUntil(handleWebhook(body, env).catch((e) => console.error("handler error", e)));
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleWebhook(body, env) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg) return; // status updates etc.

  // Idempotency: Meta can redeliver the same message.
  const seenKey = `seen:${msg.id}`;
  if (await env.STATE.get(seenKey)) return;
  await env.STATE.put(seenKey, "1", { expirationTtl: 60 * 60 });

  const from = msg.from;
  await markRead(env, msg.id);

  const user = await getUser(env, from);
  if (!user) {
    await sendText(env, from, "Sorry, this number isn't registered. Please ask an admin to add you.");
    return;
  }

  await maybeGreet(env, user);

  // Button / list replies (decisions, role pickers)
  if (msg.type === "interactive") {
    const reply = msg.interactive.button_reply || msg.interactive.list_reply;
    return handleInteractive(env, user, reply.id);
  }

  // Normalise input to text
  let text = "";
  if (msg.type === "text") text = msg.text.body.trim();
  else if (msg.type === "audio") {
    const audio = await downloadMedia(env, msg.audio.id);
    text = await transcribe(env, audio, { normaliseRomanUrdu: true });
    await sendText(env, from, `🎙️ Heard: "${text}"`);
  } else {
    await sendText(env, from, "I can read text and voice notes. Please send one of those.");
    return;
  }

  if (text.startsWith("/")) return handleCommand(env, user, text);
  return answerQuestion(env, user, text);
}

/* ---------------- Team directory (KV) ---------------- */

// KV key `user:<phone>` → { phone, name, role, isAdmin }
async function getUser(env, phone) {
  return env.TEAM.get(`user:${phone}`, "json");
}

function roleConfig(env, role) {
  // ROLE_DOCS is a JSON var: { "<role>": { primary: "<docId>", reference: ["<docId>", ...] } }
  const map = JSON.parse(env.ROLE_DOCS);
  return map[role];
}

function knownRoles(env) {
  return Object.keys(JSON.parse(env.ROLE_DOCS));
}

async function maybeGreet(env, user) {
  const key = `greeted:${user.phone}`;
  const last = Number((await env.STATE.get(key)) || 0);
  if (Date.now() - last > GREETING_WINDOW_MS) {
    await sendText(env, user.phone, `Assalam o Alaikum ${user.name}! 👋 Ask me anything about your SOPs.`);
    await env.STATE.put(key, String(Date.now()), { expirationTtl: 60 * 60 * 25 });
  }
}

/* ---------------- Q&A ---------------- */

async function answerQuestion(env, user, question) {
  const cfg = roleConfig(env, user.role);
  if (!cfg) {
    await sendText(env, user.phone, "Your role has no SOP documents configured yet.");
    return;
  }

  const primary = await readDoc(env, cfg.primary);
  const references = await Promise.all((cfg.reference || []).map((id) => readDoc(env, id)));

  // Keep the prompt inside the model's limit: primary SOP gets priority.
  const context = fitToBudget(
    [
      { label: "PRIMARY SOP", text: primary, priority: 1 },
      ...references.map((t, i) => ({ label: `REFERENCE ${i + 1} (read-only)`, text: t, priority: 2 })),
    ],
    Number(env.CONTEXT_TOKEN_BUDGET || 6000)
  );

  const answer = await chat(env, [
    {
      role: "system",
      content:
        "You are an internal SOP assistant. Answer ONLY from the documents provided. " +
        "If the answer is not in them, say so and suggest asking an admin. " +
        "Reply in the same language mix the user writes in (English / Roman Urdu). Keep it short.",
    },
    { role: "user", content: `${context}\n\nQUESTION: ${question}` },
  ]);

  await sendText(env, user.phone, answer);
}

/* ---------------- Commands ---------------- */

async function handleCommand(env, user, text) {
  const [cmd, ...rest] = text.split(" ");
  const arg = rest.join(" ").trim();

  switch (cmd.toLowerCase()) {
    case "/sop":
      return addSop(env, user, arg);
    case "/adduser":
      return adminOnly(env, user, () => addUser(env, user, arg));
    case "/removeuser":
      return adminOnly(env, user, () => removeUser(env, user, arg));
    case "/help":
      return sendText(
        env,
        user.phone,
        "Commands:\n/sop <new rule> — add to your SOP\n/adduser <phone> <name> <role> (admin)\n/removeuser <phone> (admin)\nOr just ask a question."
      );
    default:
      return sendText(env, user.phone, "Unknown command. Send /help.");
  }
}

async function adminOnly(env, user, fn) {
  if (!user.isAdmin) return sendText(env, user.phone, "Only admins can do that.");
  return fn();
}

async function addUser(env, admin, arg) {
  const [phone, name, ...roleParts] = arg.split(" ");
  const role = roleParts.join(" ");
  if (!phone || !name) return sendText(env, admin.phone, "Usage: /adduser <phone> <name> <role>");

  const roles = knownRoles(env);
  const match = roles.find((r) => r.toLowerCase() === role.toLowerCase());

  if (!match) {
    // Typo recovery: let the admin pick the right role from a list.
    await env.STATE.put(`pending:${admin.phone}`, JSON.stringify({ type: "adduser", phone, name }), {
      expirationTtl: PENDING_TTL_SECONDS,
    });
    return sendList(env, admin.phone, `Role "${role}" not found. Pick one for ${name}:`, "Choose role",
      roles.map((r) => ({ id: `role:${r}`, title: r.slice(0, 24) })));
  }

  await env.TEAM.put(`user:${phone}`, JSON.stringify({ phone, name, role: match, isAdmin: false }));
  return sendText(env, admin.phone, `✅ Added ${name} as ${match}.`);
}

async function removeUser(env, admin, phone) {
  if (!phone) return sendText(env, admin.phone, "Usage: /removeuser <phone>");
  await env.TEAM.delete(`user:${phone}`);
  return sendText(env, admin.phone, `🗑️ Removed ${phone}.`);
}

/* ---------------- SOP authoring + contradiction check ---------------- */

async function addSop(env, user, rawText) {
  if (!rawText) return sendText(env, user.phone, "Usage: /sop <the new rule or process>");
  const cfg = roleConfig(env, user.role);
  const existing = await readDoc(env, cfg.primary);

  const polished = await chat(env, [
    {
      role: "system",
      content:
        "Rewrite the user's note as a clear, numbered SOP entry in English. Keep every fact; add nothing.",
    },
    { role: "user", content: rawText },
  ]);

  const verdict = await chat(
    env,
    [
      {
        role: "system",
        content:
          'Compare NEW against EXISTING SOP. Reply JSON only: {"conflict":true|false,"existing_excerpt":"<exact conflicting text or empty>","reason":"<short>"}',
      },
      { role: "user", content: `EXISTING:\n${fitToBudget([{ label: "SOP", text: existing, priority: 1 }], 5000)}\n\nNEW:\n${polished}` },
    ],
    { json: true }
  );

  let check;
  try { check = JSON.parse(verdict); } catch { check = { conflict: false }; }

  if (!check.conflict) {
    await appendToDoc(env, cfg.primary, polished);
    return sendText(env, user.phone, `✅ Added to your SOP:\n\n${polished}`);
  }

  await env.STATE.put(
    `pending:${user.phone}`,
    JSON.stringify({ type: "sop_conflict", docId: cfg.primary, polished, oldText: check.existing_excerpt }),
    { expirationTtl: PENDING_TTL_SECONDS }
  );

  return sendButtons(
    env,
    user.phone,
    `⚠️ This may contradict an existing rule:\n\n"${check.existing_excerpt}"\n\nReason: ${check.reason}\n\nNew:\n${polished}`,
    [
      { id: "sop:replace", title: "Replace" },
      { id: "sop:keep", title: "Keep both" },
      { id: "sop:cancel", title: "Cancel" },
    ]
  );
}

/* ---------------- Interactive replies ---------------- */

async function handleInteractive(env, user, id) {
  const pending = await env.STATE.get(`pending:${user.phone}`, "json");
  if (!pending) return sendText(env, user.phone, "That choice has expired. Please start again.");
  await env.STATE.delete(`pending:${user.phone}`);

  if (pending.type === "sop_conflict") {
    if (id === "sop:replace") {
      await replaceInDoc(env, pending.docId, pending.oldText, pending.polished);
      return sendText(env, user.phone, "🔁 Replaced the old rule.");
    }
    if (id === "sop:keep") {
      await appendToDoc(env, pending.docId, pending.polished);
      return sendText(env, user.phone, "➕ Added alongside the existing rule.");
    }
    return sendText(env, user.phone, "Cancelled. Nothing changed.");
  }

  if (pending.type === "adduser" && id.startsWith("role:")) {
    const role = id.slice(5);
    await env.TEAM.put(`user:${pending.phone}`, JSON.stringify({ phone: pending.phone, name: pending.name, role, isAdmin: false }));
    return sendText(env, user.phone, `✅ Added ${pending.name} as ${role}.`);
  }
}
