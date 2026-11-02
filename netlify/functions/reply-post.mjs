// Kirim balasan yang sudah disetujui pemilik.
// Dua langkah, karena Threads perlu jeda sebelum container bisa diterbitkan:
//   action "create":  buat container balasan, simpan creation_id, status tetap approved.
//   action "publish": setelah 30 detik, terbitkan container, status jadi sent.
// Batas: maksimal 5 balasan dalam 24 jam, dan setiap draf hanya bisa dikirim sekali.

const GRAPH = "https://graph.threads.com/v1.0";
const JEDA_MS = 30_000;
const BATAS_24_JAM = 5;

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

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function ambilDraf(id, userId) {
  const rows = await sb(
    `reply_drafts?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}&select=*`
  );
  return rows && rows[0];
}

async function aksi(draf, userId, action, now) {
  if (draf.status !== "approved") return json(409, { error: "Draf belum disetujui." });
  if (draf.sent_reply_id) return json(409, { error: "Draf ini sudah pernah dikirim." });

  const userIdThreads = process.env.THREADS_USER_ID;
  const token = process.env.THREADS_ACCESS_TOKEN;

  if (action === "create") {
    const sejak = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const terkirim = await sb(
      `reply_drafts?user_id=eq.${userId}&status=eq.sent&sent_at=gte.${encodeURIComponent(sejak)}&select=id`
    );
    if ((terkirim || []).length >= BATAS_24_JAM) {
      return json(429, { error: `Batas ${BATAS_24_JAM} balasan dalam 24 jam sudah tercapai.` });
    }

    const params = new URLSearchParams({
      media_type: "TEXT",
      text: draf.draft_text,
      reply_to_id: draf.target_post_id,
      access_token: token,
    });
    const res = await fetch(`${GRAPH}/${userIdThreads}/threads?${params}`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 300));

    await sb(`reply_drafts?id=eq.${draf.id}`, {
      method: "PATCH",
      body: JSON.stringify({ creation_id: body.id, creation_at: now.toISOString(), error: null }),
    });
    return json(200, { ok: true, tahap: "create", siap_terbit_dalam_detik: 30 });
  }

  if (action === "publish") {
    if (!draf.creation_id) return json(409, { error: "Jalankan tahap create dulu." });
    const sudahLama = now - new Date(draf.creation_at) >= JEDA_MS;
    if (!sudahLama) {
      const sisa = Math.ceil((JEDA_MS - (now - new Date(draf.creation_at))) / 1000);
      return json(425, { error: `Tunggu ${sisa} detik lagi, lalu coba terbitkan.` });
    }

    const params = new URLSearchParams({ creation_id: draf.creation_id, access_token: token });
    const res = await fetch(`${GRAPH}/${userIdThreads}/threads_publish?${params}`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) {
      await sb(`reply_drafts?id=eq.${draf.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "failed", error: JSON.stringify(body).slice(0, 300) }),
      });
      return json(502, { error: JSON.stringify(body).slice(0, 300) });
    }

    await sb(`reply_drafts?id=eq.${draf.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "sent", sent_reply_id: body.id, sent_at: now.toISOString(), error: null }),
    });
    return json(200, { ok: true, tahap: "publish", sent_reply_id: body.id });
  }

  return json(400, { error: "action harus 'create' atau 'publish'." });
}

export default async function handler(req) {
  if (req.method !== "POST") return json(405, { error: "Gunakan POST." });

  const user = await requireUser(req);
  if (!user) return json(401, { error: "Login dulu." });

  if (!process.env.THREADS_USER_ID || !process.env.THREADS_ACCESS_TOKEN) {
    return json(500, { error: "THREADS_USER_ID atau THREADS_ACCESS_TOKEN belum diset." });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body harus JSON." });
  }
  const id = String(body.id || "");
  const action = String(body.action || "");
  if (!id) return json(400, { error: "ID draf wajib diisi." });

  try {
    const draf = await ambilDraf(id, user.id);
    if (!draf) return json(404, { error: "Draf tidak ditemukan." });
    return await aksi(draf, user.id, action, new Date());
  } catch (err) {
    return json(502, { error: err.message });
  }
}
