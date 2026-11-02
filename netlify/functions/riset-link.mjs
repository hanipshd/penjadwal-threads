// Buat draf balasan dari satu postingan yang ditempel pemilik (link + teks).
// Dipakai selama keyword_search belum bisa mencari postingan orang lain (butuh App Review).
// ID numerik untuk reply_to_id dihitung dari kode pendek di link (shortcode, base64 ala Instagram).
// CATATAN: dugaan bahwa hasil dekode sama dengan ID dari API Threads belum diverifikasi; dites lewat satu balasan nyata.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const SYSTEM = `Kamu membantu pemilik akun Threads brand UMKM Bertumbuh menulis balasan untuk satu postingan orang lain.
Tulis satu draf balasan dalam Bahasa Indonesia santai, maksimal 280 karakter.
- Jawab isi postingan dengan satu contoh konkret atau pengalaman yang masuk akal.
- Jangan promosi, jangan menyebut nama aplikasi, jangan pakai link, jangan pakai hashtag.
- Jangan pakai penutup generik seperti "semoga bermanfaat".
Balas HANYA dengan JSON valid: {"draft": "..."}`;

export function parseLink(url) {
  const m = String(url || "").match(/threads\.(?:com|net)\/@([^/?#]+)\/post\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  let id = 0n;
  for (const ch of m[2]) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    id = id * 64n + BigInt(i);
  }
  return { username: m[1], shortcode: m[2], id: id.toString() };
}

async function requireUser(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function sb(path, options = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, "Content-Type": "application/json", Prefer: "return=representation", ...(options.headers || {}) };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...options, headers });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function callGemini(system, userMessage) {
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 2000, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`API Gemini gagal (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const parts = body.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default async function handler(req) {
  if (req.method !== "POST") return json(405, { error: "Gunakan POST." });
  const user = await requireUser(req);
  if (!user) return json(401, { error: "Login dulu." });
  if (!process.env.GEMINI_API_KEY) return json(500, { error: "GEMINI_API_KEY belum diset di Netlify." });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body harus JSON." }); }
  const url = String(body.url || "").trim();
  const teks = String(body.text || "").trim();
  const info = parseLink(url);
  if (!info) return json(400, { error: "Link tidak dikenali. Contoh: https://www.threads.com/@nama/post/AbC123" });
  if (teks.length < 10) return json(400, { error: "Tempel juga teks postingannya." });

  try {
    const raw = await callGemini(SYSTEM, `Postingan dari @${info.username}:\n${teks.slice(0, 1500)}`);
    const data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const draft = String(data.draft || "").trim().slice(0, 500);
    if (!draft) return json(502, { error: "Gemini tidak menghasilkan draf." });

    const hasil = await sb("reply_drafts?on_conflict=user_id,target_post_id", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([{
        user_id: user.id,
        target_post_id: info.id,
        target_url: url,
        target_author: info.username,
        target_text: teks.slice(0, 1500),
        skor: 100,
        draft_text: draft,
        status: "draft",
      }]),
    });
    if (!Array.isArray(hasil) || !hasil.length) return json(409, { error: "Postingan ini sudah ada di daftar draf." });
    return json(200, { ok: true, target_post_id: info.id });
  } catch (err) {
    return json(502, { error: err.message });
  }
}
