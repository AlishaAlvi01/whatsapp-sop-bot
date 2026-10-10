// Google Docs access from a Worker using a service account (JWT → OAuth token).
// Share each SOP doc with the service account's email as Editor.

const SCOPE = "https://www.googleapis.com/auth/documents";

let cachedToken = null;

async function getAccessToken(env) {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;

  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, iat: now, exp: now + 3600 };

  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc(header)}.${enc(claims)}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

export async function readDoc(env, docId) {
  const token = await getAccessToken(env);
  const doc = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());

  return (doc.body?.content || [])
    .flatMap((el) => el.paragraph?.elements || [])
    .map((e) => e.textRun?.content || "")
    .join("");
}

export async function appendToDoc(env, docId, text) {
  const token = await getAccessToken(env);
  return batchUpdate(token, docId, [
    { insertText: { endOfSegmentLocation: {}, text: `\n${text}\n` } },
  ]);
}

export async function replaceInDoc(env, docId, oldText, newText) {
  const token = await getAccessToken(env);
  return batchUpdate(token, docId, [
    { replaceAllText: { containsText: { text: oldText, matchCase: true }, replaceText: newText } },
  ]);
}

async function batchUpdate(token, docId, requests) {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Docs update ${res.status}: ${await res.text()}`);
  return res.json();
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
