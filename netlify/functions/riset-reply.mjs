// Riset postingan untuk dibalas.
// Dipanggil dari halaman saat pemilik menekan tombol "Riset reply".
// Alur: cari postingan lewat keyword_search -> nilai dan buat draf dengan Gemini -> simpan ke reply_drafts (status draft).
// Tidak ada yang dikirim ke Threads di fungsi ini. Pengiriman ada di reply-post.mjs setelah disetujui.

const GRAPH = "https://graph.threads.com/v1.0";
const MIN_SCORE = 60;      // di bawah ini tidak disimpan
const MAX_CANDIDATES = 8;  // dibatasi agar fungsi selesai dalam batas waktu Netlify

const SYSTEM = `Kamu membantu pemilik akun Threads brand UMKM Bertumbuh mencari postingan untuk dibalas.
Untuk setiap kandidat postingan:
1. Beri skor 0-100 seberapa cocok untuk dibalas. Naikkan skor jika topiknya berkaitan dengan UMKM, konveksi, catatan usaha, digitalisasi usaha kecil, atau penggunaan AI untuk produksi, dan jika ada pertanyaan atau masalah yang bisa dijawab dengan contoh konkret. Turunkan skor jika postingannya curhat pribadi, konflik, politik, atau hanya promosi.
2. Tulis draf balasan sesuai gaya di bawah. Jika skor di bawah 60, tulis draf kosong "".

Gaya balasan pemilik akun. Ikuti ini:
- Bahasa Indonesia santai seperti ngobrol di Threads. Singkatan umum boleh (yg, klo, gmn, dll). Sapaan "mas" atau "kak" boleh jika cocok, jangan berlebihan.
- Langsung jawab inti postingan, tanpa basa-basi pembuka.
- Jika postingan meminta tips: jawab dengan daftar bernomor 3 sampai 5 poin, tiap poin kalimat perintah yang pendek.
- Jika postingan adalah pertanyaan lanjutan atau orang bingung: mulai dengan "Jadi misalnya ..." lalu beri SATU contoh konkret dari kerja nyata, diurai dalam daftar bernomor, lalu ringkas dengan "Nah ...".
- Penutup: "Semoga bermanfaat" boleh, dengan satu atau dua emoji seperti 🙏🏻 atau 😉. Jika orang tampak baru belajar atau masih bingung, boleh tambah satu ajakan ringan seperti "Klo mau lebih jelas dan dipandu sampe bisa boleh dm aja 🤝". Jangan pakai ajakan itu di setiap balasan.
- Maksimal 500 karakter. Baris baru boleh.
- Dilarang: link, hashtag, menyebut aplikasi atau produk milik pemilik akun (UMKM Bertumbuh), klaim hasil yang tidak pasti, mengarang pengalaman yang tidak masuk akal.
- ISI HARUS BERBOBOT, bukan langkah dasar. Dilarang poin generik seperti "kenali dulu apa itu ...", "coba akses lewat browser", atau "latihan tanya jawab". Tunjukkan HASIL NYATA dan perbedaan yang bikin orang tertarik. Jika postingan bertanya "X itu apa" atau "bisa ga buat pemula", jawab singkat bisa, lalu sebut 3 sampai 5 hal konkret yang bisa dihasilkan.
- Jika topiknya Claude: tonjolkan kemampuan yang membedakannya dari AI chat lain, misalnya bikin video motion graphic dan animasi hanya dari prompt, bikin aplikasi sampai game, riset fakta, data, dan sejarah memakai sumber (bukan karangan), dan dipecah jadi agent per tugas untuk otomatisasi. Pakai hanya kemampuan yang disebut di sini atau di postingan, jangan menambah klaim atau angka baru.
- Menyebut nama tool AI yang sedang dibahas di postingan (misalnya Claude) boleh.

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

Contoh 3
Postingan: Guys claude itu apa? Yuk sharing² guys, cuz untuk pemula kayak saya apakah bisa?
Balasan:
Bisa banget, pemula justru enak karena cukup ngetik perintah biasa. Bedanya sama AI chat lain, Claude bisa :
1. Bikin video motion graphic & animasi cuma dari prompt
2. Bikin aplikasi sampai game
3. Riset fakta, data, sejarah pakai sumber, bukan karangan
4. Dipecah jadi agent2 per tugas biar kerjaan jalan otomatis
Semoga bermanfaat😉
Klo mau lebih jelas dan dipandu sampe bisa boleh dm aja🤝

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
      generationConfig: { maxOutputTokens: 6000, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`API Gemini gagal (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const parts = body.candidates?.[0]?.content?.parts || [];
  // Lewati bagian "thought" (proses berpikir model), hanya ambil jawabannya.
  return parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
}

// Pemeriksaan otomatis: buang draf yang melanggar aturan (link, hashtag) dan potong ke batas Threads 500 karakter.
export function bersihkan(teks) {
  const t = String(teks || "").trim();
  if (!t || /https?:\/\/|www\.|#\S/i.test(t)) return "";
  return t.slice(0, 500);
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
      draft: bersihkan(h.draft),
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
