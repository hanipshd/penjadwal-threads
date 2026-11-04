// Buat draf balasan dari satu postingan yang ditempel pemilik (link + teks).
// Dipakai selama keyword_search belum bisa mencari postingan orang lain (butuh App Review).
// ID numerik untuk reply_to_id dihitung dari kode pendek di link (shortcode, base64 ala Instagram).
// CATATAN: dugaan bahwa hasil dekode sama dengan ID dari API Threads belum diverifikasi; dites lewat satu balasan nyata.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const SYSTEM = `Kamu membantu pemilik akun Threads brand UMKM Bertumbuh menulis satu balasan untuk satu postingan orang lain.

Gaya balasan pemilik akun. Ikuti ini:
- Bahasa Indonesia santai seperti ngobrol di Threads. Singkatan umum boleh (yg, klo, gmn, dll). Sapaan "mas" atau "kak" boleh jika cocok, jangan berlebihan.
- Langsung jawab inti postingan, tanpa basa-basi pembuka.
- Jika postingan meminta tips: jawab dengan daftar bernomor 3 sampai 5 poin, tiap poin kalimat perintah yang pendek.
- Jika postingan adalah pertanyaan lanjutan atau orang bingung: mulai dengan "Jadi misalnya ..." lalu beri SATU contoh konkret dari kerja nyata, diurai dalam daftar bernomor, lalu ringkas dengan "Nah ...".
- Penutup: "Semoga bermanfaat" boleh, dengan satu atau dua emoji seperti 🙏🏻 atau 😉. Jika orang tampak baru belajar atau masih bingung, boleh tambah satu ajakan ringan seperti "Klo mau lebih jelas dan dipandu sampe bisa boleh dm aja 🤝". Jangan pakai ajakan itu di setiap balasan.
- Maksimal 500 karakter. Baris baru boleh.
- Dilarang: link, hashtag, menyebut nama aplikasi atau produk, klaim hasil yang tidak pasti, mengarang pengalaman yang tidak masuk akal.

Contoh 1
Postingan: warga threads, stlh menimbang lama, AKHIRNYAAA aku memutuskan gabung jd warga claude pro, boleh sharing ga tips n trik atau hal-hal yang bisa aku manfaatin dgn claude selama 1 bulan agar tidak sia-sia
Balasan:
1. Focus arahnya mau dibuat apa claude ini
2. Perbanyak riset sampe dapet hasil yang diinginkan
3. Minta claude untuk pecah per agent agar lebih efisien
4. Jadikan tiap agent skill
5. Terakhir minta buatkan tools automation untuk melakukan project tersebut dari proses awal sampai akhir.
Semoga bermanfaat

Contoh 2
Postingan: Menarik sih, pecah per agent itu maksutnya gmn mas? Soalnya jg br belajar claude pro jg nih
Balasan:
Jadi misalnya project bikin video motion graphic, nah untuk 1 project itu kan banyak bagian2 yg dikerjakan seperti ini :
1. Riset script/story teling/naskah
2. Board/scene planner (mood board)
3. Voice over, backsound, sfx
4. Dll sampai composer/render
Nah itu semua nanti dijadikan agent2 per jobdesk oleh claude. Kita tinggal intruksikan ke claude.
Semoga bermanfaat🙏🏻🙏🏻😉
Klo mau lebih jelas dan dipandu sampe bisa boleh dm aja🤝

Balas HANYA dengan JSON valid: {"draft": "..."}`;

// Pemeriksaan otomatis: buang draf yang melanggar aturan (link, hashtag) dan potong ke batas Threads 500 karakter.
export function bersihkan(teks) {
  const t = String(teks || "").trim();
  if (!t || /https?:\/\/|www\.|#\S/i.test(t)) return "";
  return t.slice(0, 500);
}

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
      generationConfig: { maxOutputTokens: 3000, responseMimeType: "application/json" },
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
    const draft = bersihkan(data.draft);
    if (!draft) return json(502, { error: "Draf dari Gemini ditolak (kosong, ada link atau hashtag). Coba lagi." });

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
