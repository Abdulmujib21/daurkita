/* ============================================================
   DaurKita — Server Backend (v1.9.1)
   ------------------------------------------------------------
   Server ini TANPA dependensi (tidak perlu "npm install").
   Cukup jalankan:  node index.js
   Lalu buka:       http://localhost:3000

   Berkas:
     - index.js    (server ini)
     - index.html  (tampilan aplikasi, dibaca otomatis)
     - package.json
     - data.json   (database, otomatis dibuat saat pertama dijalankan)

   Konfigurasi ada di bagian "PENGATURAN" di bawah.
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

/* ======================= PENGATURAN ======================= */
const PORT = process.env.PORT || 3000;
const ADMIN_FEE_PERCENT = 5;              // biaya layanan DaurKita (%)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ""; // isi untuk aktifkan Login Google
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const SECRET = process.env.DK_SECRET || "ganti-rahasia-ini-di-produksi";
/* ========================================================== */

/* ---------------- util ---------------- */
const uid = (p) => (p ? p + "_" : "") + crypto.randomBytes(5).toString("hex");
const nowISO = () => new Date().toISOString();
const todayISO = () => nowISO().slice(0, 10);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const hashPw = (pw) => sha("dk$" + pw + "$" + SECRET);

function signToken(uidVal) {
  const body = Buffer.from(JSON.stringify({ u: uidVal, t: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verifyToken(tok) {
  if (!tok || tok.indexOf(".") < 0) return null;
  const [body, sig] = tok.split(".");
  const expect = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (sig !== expect) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()).u; } catch (e) { return null; }
}

/* ---------------- data ---------------- */
let db = null;

function seed() {
  const cats = [
    { id: "cat_plastik", nama_kategori: "Plastik", icon: "🥤" },
    { id: "cat_kertas", nama_kategori: "Kertas & Kardus", icon: "📦" },
    { id: "cat_kaca", nama_kategori: "Kaca", icon: "🍶" },
    { id: "cat_logam", nama_kategori: "Logam & Kaleng", icon: "🥫" },
    { id: "cat_organik", nama_kategori: "Organik", icon: "🍃" },
    { id: "cat_elektronik", nama_kategori: "Elektronik", icon: "🔌" },
  ];
  const collectors = [
    { id: "col_1", nama_lapak: "Bank Sampah Hijau", pemilik: "Pak Budi", email: "pengepul@daurkita.id",
      nomor_hp: "+62 812-1111-2222", alamat_lapak: "Jl. Melati No. 10, Jakarta Selatan",
      lat: -6.2615, lng: 106.8106, radius_layanan_km: 8, rating: 4.8, status_verifikasi: "Terverifikasi" },
    { id: "col_2", nama_lapak: "Daur Ulang Bersih", pemilik: "Bu Sari", email: "sari@daurkita.id",
      nomor_hp: "+62 813-3333-4444", alamat_lapak: "Jl. Kenanga No. 5, Jakarta Pusat",
      lat: -6.1862, lng: 106.8344, radius_layanan_km: 10, rating: 4.6, status_verifikasi: "Terverifikasi" },
    { id: "col_3", nama_lapak: "EcoPoint Jakarta", pemilik: "Mas Andi", email: "andi@daurkita.id",
      nomor_hp: "+62 815-5555-6666", alamat_lapak: "Jl. Anggrek No. 22, Jakarta Barat",
      lat: -6.1683, lng: 106.7586, radius_layanan_km: 6, rating: 4.9, status_verifikasi: "Menunggu verifikasi" },
  ];
  const prices = [];
  const base = {
    cat_plastik: [2500, 2200, 2600], cat_kertas: [1800, 1700, 1900], cat_kaca: [800, 700, 900],
    cat_logam: [9000, 8500, 9500], cat_organik: [600, 500, 650], cat_elektronik: [5000, 4500, 5200],
  };
  collectors.forEach((c, ci) => {
    Object.keys(base).forEach((cid) => {
      prices.push({ id: uid("prc"), collector_id: c.id, category_id: cid, harga_per_kg: base[cid][ci] });
    });
  });
  const users = [
    { id: "usr_1", role: "user", nama: "Siti Rahma", email: "user@daurkita.id", nomor_hp: "+62 812-0000-0000",
      alamat_lengkap: "Jl. Mawar No. 3, Jakarta Selatan", latitude: -6.2600, longitude: 106.8150,
      saldo: 0, poin: 0, avatar: "", created_at: "2024-03-01T08:00:00.000Z", password: hashPw("123456") },
    { id: "col_1", role: "collector", nama: "Pak Budi", email: "pengepul@daurkita.id", nomor_hp: "+62 812-1111-2222",
      alamat_lengkap: "Jl. Melati No. 10, Jakarta Selatan", latitude: -6.2615, longitude: 106.8106,
      saldo: 0, poin: 0, avatar: "", created_at: "2024-03-01T08:00:00.000Z", password: hashPw("123456") },
  ];
  return {
    categories: cats, collectors, prices, users,
    orders: [], order_items: [], transactions: [], notifications: [],
    settings: {},   // per-user: { [userId]: {...} }
  };
}

function load() {
  if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { db = seed(); }
  } else { db = seed(); save(); }
  if (!db.settings) db.settings = {};
}
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error("Gagal simpan data:", e.message); } }

/* ---------------- helper domain ---------------- */
const DEFAULT_SETTINGS = { notifOrders: true, notifPromo: true, showBanner: true, showCompleted: true, defaultSlot: "10:00-12:00" };
const getSettings = (id) => Object.assign({}, DEFAULT_SETTINGS, db.settings[id] || {});

function priceFor(cid, catid) {
  const p = db.prices.find((x) => x.collector_id === cid && x.category_id === catid);
  return p ? Number(p.harga_per_kg) || 0 : 0;
}
function publicUser(u) { const c = Object.assign({}, u); delete c.password; return c; }

function notify(role, refId, type, title, body, orderId) {
  const n = { id: uid("ntf"), role, ref_id: refId, type, title, body: body || "", order_id: orderId || null, read: false, created_at: nowISO() };
  db.notifications.unshift(n);
  return n;
}

function statsForCollector(cid) {
  const orders = db.orders.filter((o) => o.collector_id === cid);
  const aktifStatuses = ["pending", "accepted", "on_the_way", "arrived"];
  let pendapatan = 0, kg = 0;
  orders.forEach((o) => {
    if (o.status === "completed") {
      const tx = db.transactions.find((t) => t.order_id === o.id);
      if (tx) pendapatan += Number(tx.net) || 0;
      kg += Number(o.total_aktual) || 0;
    }
  });
  return {
    masuk: orders.length,
    aktif: orders.filter((o) => aktifStatuses.includes(o.status)).length,
    selesai: orders.filter((o) => o.status === "completed").length,
    pendapatan, kg,
  };
}

function bootstrapFor(user) {
  const isCollector = user.role === "collector";
  let orders = isCollector
    ? db.orders.filter((o) => o.collector_id === user.id)
    : db.orders.filter((o) => o.user_id === user.id);
  const orderIds = orders.map((o) => o.id);
  const order_items = db.order_items.filter((i) => orderIds.includes(i.order_id));
  const transactions = db.transactions.filter((t) => orderIds.includes(t.order_id));
  const notifications = db.notifications.filter((n) => n.ref_id === user.id);
  return {
    me: publicUser(user),
    categories: db.categories,
    collectors: db.collectors,
    prices: db.prices,
    users: db.users.map(publicUser),
    orders, order_items, transactions, notifications,
    settings: getSettings(user.id),
    stats: isCollector ? statsForCollector(user.id) : null,
    admin_fee_percent: ADMIN_FEE_PERCENT,
  };
}

/* ---------------- HTTP helpers ---------------- */
let _htmlCache = null;
function renderHTML() {
  if (_htmlCache) return _htmlCache;
  const htmlFile = path.join(__dirname, "index.html");
  let s = fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, "utf8") : "<h1>index.html tidak ditemukan</h1>";
  const cid = process.env.GOOGLE_CLIENT_ID || "";
  s = s.split('window.DAURKITA_GOOGLE_CLIENT_ID = window.DAURKITA_GOOGLE_CLIENT_ID || "";')
       .join('window.DAURKITA_GOOGLE_CLIENT_ID = ' + JSON.stringify(cid) + ';');
  _htmlCache = s;
  return s;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj == null ? {} : obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}
function authUser(req) {
  const h = req.headers["authorization"] || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const id = verifyToken(tok);
  return id ? db.users.find((u) => u.id === id) || null : null;
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const p = u.pathname;

  if (req.method === "OPTIONS") { return send(res, 204, {}); }

  try {
    /* ---------- AUTH ---------- */
    if (p === "/api/auth/register" && req.method === "POST") {
      const b = await readBody(req);
      const role = b.role === "collector" ? "collector" : "user";
      if (!b.email || !b.password) return send(res, 400, { error: "Email dan password wajib diisi" });
      if (db.users.find((x) => x.email.toLowerCase() === String(b.email).toLowerCase()))
        return send(res, 400, { error: "Email sudah terdaftar" });
      const user = {
        id: uid(role === "collector" ? "col" : "usr"), role,
        nama: b.nama || b.pemilik || "Pengguna Baru", email: b.email,
        nomor_hp: b.nomor_hp || "", alamat_lengkap: b.alamat || b.alamat_lengkap || "",
        latitude: b.latitude != null ? Number(b.latitude) : null,
        longitude: b.longitude != null ? Number(b.longitude) : null,
        saldo: 0, poin: 0, avatar: "", created_at: nowISO(), password: hashPw(b.password),
      };
      db.users.push(user);
      if (role === "collector") {
        db.collectors.push({ id: user.id, nama_lapak: b.nama_lapak || user.nama, pemilik: b.nama || user.nama,
          email: user.email, nomor_hp: user.nomor_hp, alamat_lapak: user.alamat_lengkap,
          lat: user.latitude, lng: user.longitude, radius_layanan_km: 5, rating: 5.0, status_verifikasi: "Menunggu verifikasi" });
      }
      save();
      return send(res, 200, { token: signToken(user.id), account: publicUser(user) });
    }

    if (p === "/api/auth/login" && req.method === "POST") {
      const b = await readBody(req);
      const user = db.users.find((x) => x.email.toLowerCase() === String(b.email || "").toLowerCase());
      if (!user || user.password !== hashPw(b.password)) return send(res, 401, { error: "Email atau password salah" });
      return send(res, 200, { token: signToken(user.id), account: publicUser(user) });
    }

    if (p === "/api/auth/google" && req.method === "POST") {
      const b = await readBody(req);
      if (!GOOGLE_CLIENT_ID) return send(res, 400, { error: "Login Google belum dikonfigurasi di server (GOOGLE_CLIENT_ID kosong)" });
      const info = await verifyGoogle(b.credential);
      if (!info || !info.email) return send(res, 401, { error: "Token Google tidak valid" });
      let user = db.users.find((x) => x.email.toLowerCase() === info.email.toLowerCase());
      if (!user) {
        const role = b.role === "collector" ? "collector" : "user";
        user = { id: uid(role === "collector" ? "col" : "usr"), role, nama: info.name || info.email.split("@")[0],
          email: info.email, nomor_hp: "", alamat_lengkap: "", latitude: null, longitude: null, saldo: 0, poin: 0, avatar: "", created_at: nowISO(), password: "" };
        db.users.push(user);
        if (role === "collector") db.collectors.push({ id: user.id, nama_lapak: user.nama, pemilik: user.nama, email: user.email,
          nomor_hp: "", alamat_lapak: "", lat: null, lng: null, radius_layanan_km: 5, rating: 5.0, status_verifikasi: "Menunggu verifikasi" });
        save();
      }
      return send(res, 200, { token: signToken(user.id), account: publicUser(user) });
    }

    /* ---------- semua endpoint di bawah butuh login ---------- */
    const me = authUser(req);
    if (p.startsWith("/api/") && !me) return send(res, 401, { error: "Sesi berakhir, silakan masuk lagi" });

    if (p === "/api/bootstrap" && req.method === "GET") return send(res, 200, bootstrapFor(me));

    if (p === "/api/orders" && req.method === "POST") {
      const b = await readBody(req);
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) return send(res, 400, { error: "Pilih minimal satu jenis sampah" });
      const collectorId = b.collector_id;
      const col = db.collectors.find((c) => c.id === collectorId);
      if (!col) return send(res, 400, { error: "Pengepul tidak ditemukan" });
      const oid = uid("ord");
      let estimasiTotal = 0, estimasiBerat = 0;
      const newItems = items.map((it) => {
        const berat = Number(it.berat) || 0;
        const harga = priceFor(collectorId, it.category_id);
        estimasiBerat += berat; estimasiTotal += berat * harga;
        return { id: uid("oit"), order_id: oid, category_id: it.category_id, berat, harga_satuan: harga, harga_per_kg: harga };
      });
      const kode = "DK-" + todayISO().replace(/-/g, "") + "-" + String(db.orders.length + 1).padStart(4, "0");
      const order = {
        id: oid, kode_order: kode, user_id: b.user_id || me.id, collector_id: collectorId,
        tanggal_jemput: b.tanggal || b.tanggal_jemput || todayISO(),
        slot_waktu: b.slot || b.slot_waktu || "10:00-12:00",
        alamat_penjemputan: b.alamat || b.alamat_penjemputan || "",
        catatan: b.catatan || "", status: "pending",
        estimasi_berat: estimasiBerat, estimasi_total: estimasiTotal,
        total_aktual: null, admin_fee: 0, created_at: nowISO(),
      };
      db.orders.push(order); db.order_items.push(...newItems);
      notify("collector", collectorId, "order", "Order baru masuk", kode + " menunggu konfirmasi", oid);
      notify("user", order.user_id, "order", "Order dibuat", "Menunggu konfirmasi pengepul", oid);
      save();
      return send(res, 200, { order });
    }

    const mStatus = p.match(/^\/api\/orders\/([^/]+)\/status$/);
    if (mStatus && req.method === "PATCH") {
      const b = await readBody(req);
      const order = db.orders.find((o) => o.id === mStatus[1]);
      if (!order) return send(res, 404, { error: "Order tidak ditemukan" });
      order.status = b.status;
      const label = { accepted: "Diterima pengepul", on_the_way: "Pengepul dalam perjalanan", arrived: "Pengepul tiba di lokasi",
        completed: "Selesai", cancelled: "Dibatalkan", dispute: "Sengketa" }[b.status] || b.status;
      notify("user", order.user_id, "status", "Status order: " + label, order.kode_order, order.id);
      save();
      return send(res, 200, { order });
    }

    const mComplete = p.match(/^\/api\/orders\/([^/]+)\/complete$/);
    if (mComplete && req.method === "POST") {
      const b = await readBody(req);
      const order = db.orders.find((o) => o.id === mComplete[1]);
      if (!order) return send(res, 404, { error: "Order tidak ditemukan" });
      const list = Array.isArray(b.items) ? b.items : [];
      let total = 0, kg = 0;
      list.forEach((x) => {
        const item = db.order_items.find((i) => i.id === x.item_id);
        if (item) {
          item.berat_aktual = Number(x.berat_aktual) || 0;
          item.subtotal = item.berat_aktual * Number(item.harga_satuan);
          total += item.subtotal; kg += item.berat_aktual;
        }
      });
      const fee = Math.round(total * ADMIN_FEE_PERCENT / 100);
      const net = total - fee;
      const tx = { id: uid("trx"), order_id: order.id, total, admin_fee: fee, net,
        metode_bayar: "transfer", status_pembayaran: "dibayar", reference_id: "REF-" + order.kode_order,
        created_at: nowISO() };
      db.transactions.push(tx);
      order.status = "completed"; order.total_aktual = kg; order.admin_fee = fee;
      const user = db.users.find((u) => u.id === order.user_id);
      if (user) { user.saldo = (Number(user.saldo) || 0) + net; user.poin = (Number(user.poin) || 0) + Math.round(total / 1000); }
      const col = db.users.find((u) => u.id === order.collector_id);
      notify("user", order.user_id, "payment", "Saldo sudah masuk otomatis", "Rp " + net.toLocaleString("id-ID") + " ditambahkan", order.id);
      save();
      return send(res, 200, { order, transaction: tx });
    }

    if (p === "/api/prices" && req.method === "PUT") {
      const b = await readBody(req);
      (b.items || []).forEach((it) => {
        let row = db.prices.find((x) => x.collector_id === me.id && x.category_id === it.category_id);
        if (row) row.harga_per_kg = Number(it.harga_per_kg) || 0;
        else db.prices.push({ id: uid("prc"), collector_id: me.id, category_id: it.category_id, harga_per_kg: Number(it.harga_per_kg) || 0 });
      });
      save();
      return send(res, 200, { ok: true });
    }

    if (p === "/api/profile" && req.method === "PUT") {
      const b = await readBody(req);
      const allow = ["nama", "nama_lapak", "nomor_hp", "alamat", "alamat_lengkap", "alamat_lapak", "latitude", "longitude", "radius_layanan_km", "rating", "status_verifikasi", "avatar"];
      allow.forEach((k) => { if (b[k] !== undefined) me[k] = b[k]; });
      if (me.role === "collector") {
        const col = db.collectors.find((c) => c.id === me.id);
        if (col) {
          if (b.nama_lapak !== undefined) col.nama_lapak = b.nama_lapak;
          if (b.nama !== undefined) col.pemilik = b.nama;
          if (b.alamat_lapak !== undefined) col.alamat_lapak = b.alamat_lapak;
          if (b.nomor_hp !== undefined) col.nomor_hp = b.nomor_hp;
          if (b.radius_layanan_km !== undefined) col.radius_layanan_km = Number(b.radius_layanan_km) || 5;
        }
      }
      save();
      return send(res, 200, { account: publicUser(me) });
    }

    if (p === "/api/settings" && req.method === "PUT") {
      const b = await readBody(req);
      db.settings[me.id] = Object.assign({}, getSettings(me.id), b);
      save();
      return send(res, 200, { settings: db.settings[me.id] });
    }

    if (p === "/api/notifications/self" && req.method === "POST") {
      const b = await readBody(req);
      const n = notify(me.role, me.id, b.type || "info", b.title || "Notifikasi", b.body, b.order_id);
      save();
      return send(res, 200, { notification: n });
    }
    if (p === "/api/notifications/read" && req.method === "POST") {
      const b = await readBody(req);
      db.notifications.forEach((n) => { if (n.ref_id === me.id && (b.all || n.id === b.id)) n.read = true; });
      save();
      return send(res, 200, { ok: true });
    }
    if (p === "/api/notifications" && req.method === "DELETE") {
      db.notifications = db.notifications.filter((n) => n.ref_id !== me.id);
      save();
      return send(res, 200, { ok: true });
    }

    /* ---------- static (sajikan aplikasi HTML) ---------- */
    if (p === "/" || p === "/index.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(renderHTML()); }
    let file = p;
    const full = path.join(__dirname, decodeURIComponent(file));
    if (full.startsWith(__dirname) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream" });
      return fs.createReadStream(full).pipe(res);
    }
    if (p.startsWith("/api/")) return send(res, 404, { error: "Endpoint tidak ditemukan: " + p });
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Tidak ditemukan");
  } catch (err) {
    console.error(err);
    send(res, 500, { error: "Kesalahan server: " + err.message });
  }
});

function verifyGoogle(credential) {
  return new Promise((resolve) => {
    if (!credential) return resolve(null);
    https.get("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential), (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

load();
server.listen(PORT, "0.0.0.0", () => {
  console.log("\n  🍃 DaurKita server berjalan!");
  console.log("  Buka di browser:  http://localhost:" + PORT);
  console.log("  Akun contoh → Pengguna: user@daurkita.id / 123456");
  console.log("              → Pengepul: pengepul@daurkita.id / 123456\n");
});
