// Endpoint untuk "Deauthorize callback URL" di dashboard Meta.
// Meta memanggil endpoint ini ketika pengguna mencabut akses aplikasi dari akunnya.
// Tahap awal: hanya membalas 200. Penghapusan data dilakukan lewat permintaan manual di halaman data-deletion.
// TODO: verifikasi parameter signed_request dengan app secret sebelum mengubah data apa pun.

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Gunakan POST.", { status: 405 });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
