import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import session from "express-session";

const app = express();
// Render'ın verdiği PORT'u kullanması için bu satır kritik
const PORT = process.env.PORT || 4000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());

// Path hatasını önlemek için tam yol tanımlaması
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));

app.use(session({
  secret: 'osteria_secret_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

const db = new sqlite3.Database(path.join(__dirname, "restaurant.db"));

// Masa düzeni sabitlerin (Çizimine göre olan güncel liste)
const tables = [
  { id: 7, name: "Masa 7", x: 20, y: 30, capacity: 2, shape: "round" },
  { id: 8, name: "Masa 8", x: 20, y: 130, capacity: 2, shape: "round" },
  { id: 11, name: "Masa 11", x: 20, y: 230, capacity: 2, shape: "round" },
  { id: 13, name: "Masa 13", x: 20, y: 330, capacity: 2, shape: "round" },
  { id: 9, name: "Masa 9", x: 530, y: 30, capacity: 2, shape: "round" },
  { id: 10, name: "Masa 10", x: 530, y: 130, capacity: 2, shape: "round" },
  { id: 12, name: "Masa 12", x: 530, y: 230, capacity: 2, shape: "round" },
  { id: 14, name: "Masa 14", x: 530, y: 330, capacity: 2, shape: "round" },
  { id: 3, name: "Masa 3", x: 130, y: 80, capacity: 4, shape: "square" },
  { id: 4, name: "Masa 4", x: 130, y: 280, capacity: 4, shape: "square" },
  { id: 5, name: "Masa 5", x: 410, y: 80, capacity: 4, shape: "square" },
  { id: 6, name: "Masa 6", x: 410, y: 280, capacity: 4, shape: "square" },
  { id: 1, name: "Masa 1", x: 255, y: 140, capacity: 6, shape: "rect" },
  { id: 2, name: "Masa 2", x: 255, y: 240, capacity: 6, shape: "rect" }
];

const runQuery = (s, p = []) => new Promise((resolve, reject) => db.run(s, p, function(e) { e ? reject(e) : resolve(this); }));
const getQuery = (s, p = []) => new Promise((resolve, reject) => db.get(s, p, (e, r) => e ? reject(e) : resolve(r)));
const allQuery = (s, p = []) => new Promise((resolve, reject) => db.all(s, p, (e, r) => e ? reject(e) : resolve(r)));

async function initDB() {
  await runQuery(`CREATE TABLE IF NOT EXISTS staff_users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, full_name TEXT)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY, table_id INTEGER, customer_name TEXT, phone_number TEXT, guest_count INTEGER, start_time TEXT, end_time TEXT, status TEXT DEFAULT 'pending', created_at TEXT, created_by_role TEXT, cancel_reason TEXT, cancelled_at TEXT)`);
  const admin = await getQuery(`SELECT * FROM staff_users WHERE username='admin'`);
  if (!admin) await runQuery(`INSERT INTO staff_users (username, password, full_name) VALUES ('admin', '12345', 'Yönetici')`);
}

// Ana sayfa yönlendirmesi (Hata giderici ekleme)
app.get("/", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// API Rotaları (Öncekiyle aynı mantıkta devam eder)
app.post("/api/login/customer", (req, res) => {
  const { fullName, phone } = req.body;
  if (!fullName?.trim() || phone.replace(/\s/g, "").length !== 11) return res.status(400).json({ message: "İsim ve 11 haneli telefon gerekli." });
  req.session.user = { role: "customer", fullName: fullName.trim(), phone: phone.trim() };
  res.json({ user: req.session.user });
});

app.post("/api/login/staff", async (req, res) => {
  const { username, password } = req.body;
  const staff = await getQuery(`SELECT * FROM staff_users WHERE username=? AND password=?`, [username?.trim(), password]);
  if (!staff) return res.status(401).json({ message: "Hatalı giriş." });
  req.session.user = { role: "staff", fullName: staff.full_name };
  await runQuery(`DELETE FROM reservations WHERE status = 'cancelled'`); // İptal edilenleri temizle
  res.json({ user: req.session.user });
});

app.get("/api/session", (req, res) => res.json({ authenticated: !!req.session.user, user: req.session.user }));
app.post("/api/logout", (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get("/api/availability", async (req, res) => {
  const { startTime, duration } = req.query;
  const reservations = await allQuery(`SELECT * FROM reservations WHERE status IN ('pending', 'confirmed')`);
  res.json(tables.map(t => ({
    ...t,
    isReserved: reservations.some(r => r.table_id === t.id && (new Date(startTime) < new Date(r.end_time) && new Date(new Date(startTime).getTime() + duration * 3600000) > new Date(r.start_time)))
  })));
});

app.get("/api/reservations", async (req, res) => {
  let query = `SELECT * FROM reservations ORDER BY start_time ASC`;
  let params = [];
  if (req.session.user?.role === 'customer') {
    query = `SELECT * FROM reservations WHERE customer_name = ? AND phone_number = ? ORDER BY start_time ASC`;
    params = [req.session.user.fullName, req.session.user.phone];
  }
  const data = await allQuery(query, params);
  res.json(data.map(r => ({ ...r, tableName: tables.find(t => t.id === r.table_id)?.name })));
});

app.post("/api/reservations", async (req, res) => {
  try {
    const { tableId, customerName, phone, guest_count, startTime, duration } = req.body;
    const startObj = new Date(startTime);
    const dayStart = new Date(startObj.setHours(0,0,0,0)).toISOString();
    const dayEnd = new Date(startObj.setHours(23,59,59,999)).toISOString();
    const existing = await getQuery(`SELECT * FROM reservations WHERE customer_name = ? AND phone_number = ? AND start_time BETWEEN ? AND ? AND status != 'cancelled'`, [customerName, phone, dayStart, dayEnd]);
    if (existing && req.session.user.role === 'customer') return res.status(400).json({ message: "Günde sadece 1 rezervasyon yapılabilir." });
    
    await runQuery(
      `INSERT INTO reservations (table_id, customer_name, phone_number, guest_count, start_time, end_time, created_at, created_by_role) VALUES (?,?,?,?,?,?,?,?)`,
      [tableId, customerName, phone, guest_count, startTime, new Date(new Date(startTime).getTime() + duration * 3600000).toISOString(), new Date().toISOString(), req.session.user.role]
    );
    res.json({ message: "Başarılı" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.patch("/api/reservations/:id/confirm", async (req, res) => {
  await runQuery(`UPDATE reservations SET status='confirmed' WHERE id=?`, [req.params.id]);
  res.json({ message: "Onaylandı" });
});

app.delete("/api/reservations/:id", async (req, res) => {
  await runQuery(`UPDATE reservations SET status='cancelled', cancel_reason=?, cancelled_at=? WHERE id=?`, [req.body.cancelReason, new Date().toISOString(), req.params.id]);
  res.json({ message: "İptal edildi" });
});

initDB().then(() => app.listen(PORT, () => console.log(`Sunucu aktif port: ${PORT}`)));
