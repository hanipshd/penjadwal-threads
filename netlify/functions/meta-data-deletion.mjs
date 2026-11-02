// Endpoint untuk "Delete Callback URL" di dashboard Meta.
// Meta memanggil endpoint ini (POST, signed_request) saat pengguna meminta penghapusan data lewat Meta.
// Balasan berisi URL status dan kode konfirmasi, sesuai pola umum Meta.
// Tahap awal: penghapusan dilakukan manual lewat email di halaman data-deletion.html.
// TODO: verifikasi signed_request dengan app secret, dan catat permintaan ke tabel agar bisa dilacak.

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Gunakan POST.", { status: 405 });
  }
  const code = crypto.randomUUID();
  const body = {
    url: `https://threadtools.netlify.app/data-deletion.html?code=${code}`,
    confirmation_code: code,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
