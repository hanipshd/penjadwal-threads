// Riset postingan untuk dibalas.
// Dipanggil dari halaman saat pemilik menekan tombol "Riset reply".
// Alur: cari postingan lewat keyword_search -> nilai dan buat draf dengan Gemini -> simpan ke reply_drafts (status draft).
// Tidak ada yang dikirim ke Threads di fungsi ini. Pengiriman ada di reply-post.mjs setelah disetujui.

const GRAPH = "https://graph.threads.com/v1.0";
const MIN_SCORE = 60;      // di bawah ini tidak disimpan
const MAX_CANDIDATES = 8;  // dibatasi agar fungsi selesai dalam batas waktu Netlify

const SYSTEM = `Kamu membantu pemilik akun Threads brand UMKM Bertumbuh mencari postingan untuk dibalas.
Tugasmu untuk setiap kandidat postingan:
1. Beri skor 0-100 seberapa cocok untuk dibalas. Naikkan skor jika topiknya berkaitan dengan UMKM, konveksi, catatan usaha, digitalisasi usaha kecil, atau penggunaan AI untuk produksi, dan jika ada pertanyaan atau masalah yang bisa dijawab dengan contoh konkret. Turunkan skor jika postingannya curhat pribadi, konflik, politik, atau hanya promosi.
2. Tulis draf balasan dalam Bahasa Indonesia santai, maksimal 280 karakter.
   - Jawab isi postingan dengan satu contoh konkret atau pengalaman yang masuk akal.
   - Jangan promosi, jangan menyebut nama aplikasi, jangan pakai link, jangan pakai hashtag.
   - Jangan pakai penutup generik seperti "semoga bermanfaat".
   - Jika skor di bawah 60, tulis draf kosong "".
Balas HANYA dengan JSON valid tanpa teks lain, dengan format:
{"hasil": [{"id": "...", "skor": 0, "draft": "..."}]}`;

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

// Kunci format baru (sb_secret_...) hanya dikirim lewat header apikey, sama seperti penjadwal.
async function sb(path, options = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    apikey: key,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...(options.headers || {}),
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...options, headers });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function cariPostingan(q, token) {
  const params = new URLSearchParams({
    q,
    search_type: "RECENT",
    limit: "25",
    fields: "id,text,username,timestamp,permalink",
    access_token: token,
  });
  const res = await fetch(`${GRAPH}/keyword_search?${params}`);
  const body = await res.json();
  if (!res.ok) throw new Error(`keyword_search gagal: ${JSON.stringify(body).slice(0, 300)}`);
  return body.data || [];
}

async function callGemini(system, userMessage) {
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 4000, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`API Gemini gagal (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const parts = body.candidates?.[0]?.content?.parts || [];
  // Lewati bagian "thought" (proses berpikir model), hanya ambil jawabannya.
  return parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
}

export function parseHasil(rawText) {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  const data = JSON.parse(rawText.slice(start, end + 1));
  const hasil = Array.isArray(data.hasil) ? data.hasil : [];
  return hasil
    .map((h) => ({
      id: String(h.id || ""),
      skor: Math.max(0, Math.min(100, Number(h.skor) || 0)),
      draft: String(h.draft || "").trim().slice(0, 500),
    }))
    .filter((h) => h.id);
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default async function handler(req) {
  if (req.method !== "POST") return json(405, { error: "Gunakan POST." });

  const user = await requireUser(req);
  if (!user) return json(401, { error: "Login dulu." });

  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token || !process.env.GEMINI_API_KEY) {
    return json(500, { error: "THREADS_ACCESS_TOKEN atau GEMINI_API_KEY belum diset di Netlify." });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body harus JSON." });
  }
  const q = String(body.q || "").trim();
  if (!q) return json(400, { error: "Isi kata kunci dulu." });

  try {
    const me = (process.env.THREADS_USERNAME || "").toLowerCase();
    const semua = await cariPostingan(q, token);
    const kandidat = semua
      .filter((p) => p.text && p.text.length >= 20)
      .filter((p) => !me || (p.username || "").toLowerCase() !== me)
      .slice(0, MAX_CANDIDATES);

    if (!kandidat.length) return json(200, { ok: true, dicari: semua.length, disimpan: 0 });

    const daftar = kandidat
      .map((p) => `- id: ${p.id}\n  username: ${p.username}\n  teks: ${p.text}`)
      .join("\n");
    const raw = await callGemini(SYSTEM, `Kandidat postingan:\n${daftar}`);
    const hasil = parseHasil(raw).filter((h) => h.skor >= MIN_SCORE && h.draft);

    const baris = hasil.map((h) => {
      const asal = kandidat.find((p) => p.id === h.id) || {};
      return {
        user_id: user.id,
        target_post_id: h.id,
        target_url: asal.permalink || null,
        target_author: asal.username || null,
        target_text: asal.text || null,
        skor: h.skor,
        draft_text: h.draft,
        status: "draft",
      };
    });

    let disimpan = 0;
    if (baris.length) {
      // Postingan yang sudah pernah masuk daftar dilewati (unique user_id + target_post_id).
      const hasilSimpan = await sb("reply_drafts?on_conflict=user_id,target_post_id", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(baris),
      });
      disimpan = Array.isArray(hasilSimpan) ? hasilSimpan.length : 0;
    }

    return json(200, { ok: true, dicari: semua.length, dinilai: kandidat.length, disimpan });
  } catch (err) {
    return json(502, { error: err.message });
  }
}
