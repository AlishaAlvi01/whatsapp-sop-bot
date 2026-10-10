// Minimal WhatsApp Cloud API helpers (Meta direct, no BSP).

const GRAPH = "https://graph.facebook.com/v21.0";

async function post(env, payload) {
  const res = await fetch(`${GRAPH}/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!res.ok) console.error("WA send failed", res.status, await res.text());
  return res.ok ? res.json() : null;
}

export function sendText(env, to, body) {
  // WhatsApp text limit is 4096 chars
  return post(env, { to, type: "text", text: { body: body.slice(0, 4096) } });
}

export function sendButtons(env, to, body, buttons) {
  return post(env, {
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })),
      },
    },
  });
}

export function sendList(env, to, body, buttonLabel, rows) {
  return post(env, {
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body.slice(0, 1024) },
      action: { button: buttonLabel.slice(0, 20), sections: [{ title: "Options", rows: rows.slice(0, 10) }] },
    },
  });
}

export function markRead(env, messageId) {
  return post(env, { status: "read", message_id: messageId });
}

export async function downloadMedia(env, mediaId) {
  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } }).then((r) => r.json());
  const file = await fetch(meta.url, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
  return { bytes: await file.arrayBuffer(), mimeType: meta.mime_type };
}
