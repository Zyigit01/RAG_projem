const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  dokumanIsle,
  soruSor,
  soruSorStream,
  gecmisiTemizle,
  veritabaniHazirMi,
  toplamParcaSayisi,
} = require("./rag");
const { sistemKontrolu, baslangicKontrolu } = require("./health");

const app = express();
const port = 3000;

// Temel ayarlamalar
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ============================================================
// Dosya Yönetimi
// ============================================================

const yuklemeKlasoru = path.join(__dirname, "uploads");
if (!fs.existsSync(yuklemeKlasoru)) {
  fs.mkdirSync(yuklemeKlasoru);
}

// Yüklenen dosyaların kaydını tut (duplikasyon engelleme)
const yukluDosyalar = []; // {orijinalAd, diskYolu, hash, parcaSayisi, tarih}

/**
 * Dosyanın MD5 hash'ini hesaplar.
 * Aynı dosyanın tekrar yüklenmesini engellemek için kullanılır.
 */
function dosyaHashHesapla(dosyaYolu) {
  const buffer = fs.readFileSync(dosyaYolu);
  return crypto.createHash("md5").update(buffer).digest("hex");
}

// Multer ayarları — çoklu format desteği
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    // Aynı isimde dosya çakışmasın diye başına tarih ekle
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const desteklenenUzantilar = [".pdf", ".txt", ".md", ".docx"];

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const uzanti = path.extname(file.originalname).toLowerCase();
    if (desteklenenUzantilar.includes(uzanti)) {
      cb(null, true);
    } else {
      cb(new Error(`Desteklenmeyen dosya formatı: ${uzanti}. Desteklenen: ${desteklenenUzantilar.join(", ")}`));
    }
  },
});

// ============================================================
// API Endpoint'leri
// ============================================================

/**
 * POST /api/upload — Dosya yükleme ve vektörleştirme
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Dosya yüklenmedi." });
    }

    console.log(`📄 Dosya alındı: ${req.file.originalname}`);

    // Duplikasyon kontrolü — aynı dosya daha önce yüklendi mi?
    const hash = dosyaHashHesapla(req.file.path);
    const mevcutDosya = yukluDosyalar.find(d => d.hash === hash);

    if (mevcutDosya) {
      // Aynı dosya zaten yüklü, disk'teki kopyayı sil
      fs.unlinkSync(req.file.path);
      return res.json({
        success: true,
        message: `"${mevcutDosya.orijinalAd}" zaten yüklü. Tekrar işlemeye gerek yok.`,
        zatenYuklu: true,
      });
    }

    // Dökümanı işle ve vektörleştir
    const parcaSayisi = await dokumanIsle(req.file.path, req.file.originalname);

    // Kayıt defterine ekle
    yukluDosyalar.push({
      orijinalAd: req.file.originalname,
      diskYolu: req.file.path,
      hash,
      parcaSayisi,
      tarih: new Date().toISOString(),
    });

    console.log(`✅ İşlendi: ${parcaSayisi} parçaya bölündü.`);

    res.json({
      success: true,
      message: `"${req.file.originalname}" yüklendi ve ${parcaSayisi} parçaya bölündü.`,
      parcaSayisi,
    });
  } catch (hata) {
    console.error("❌ Yüklerken hata:", hata.message);
    res.status(500).json({ error: hata.message });
  }
});

/**
 * POST /api/chat — Normal soru-cevap (tek seferde tüm cevap)
 */
app.post("/api/chat", async (req, res) => {
  try {
    const gelenSoru = req.body.question;
    if (!gelenSoru) {
      return res.status(400).json({ error: "Soru boş olamaz." });
    }

    console.log(`❓ Gelen soru: ${gelenSoru}`);
    const { cevap, kaynaklar } = await soruSor(gelenSoru);

    res.json({ answer: cevap, sources: kaynaklar });
  } catch (hata) {
    console.error("❌ Chat hatası:", hata.message);
    res.status(500).json({ error: hata.message });
  }
});

/**
 * GET /api/chat/stream?question=... — Streaming soru-cevap (SSE)
 *
 * Server-Sent Events (SSE) protokolü ile her token geldiğinde
 * istemciye gönderilir. Bu sayede kullanıcı cevabı kelime kelime görür.
 */
app.get("/api/chat/stream", async (req, res) => {
  try {
    const soru = req.query.question;
    if (!soru) {
      return res.status(400).json({ error: "Soru boş olamaz." });
    }

    console.log(`❓ [STREAM] Gelen soru: ${soru}`);

    // SSE (Server-Sent Events) başlıkları
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Nginx proxy bypass

    // Her token geldiğinde istemciye gönder
    const { kaynaklar } = await soruSorStream(soru, (token) => {
      res.write(`data: ${JSON.stringify({ type: "token", content: token })}\n\n`);
    });

    // Kaynakları en sonda gönder
    res.write(`data: ${JSON.stringify({ type: "sources", content: kaynaklar })}\n\n`);
    // Stream bitti sinyali
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (hata) {
    console.error("❌ Stream hatası:", hata.message);
    // SSE formatında hata gönder
    if (!res.headersSent) {
      res.status(500).json({ error: hata.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", content: hata.message })}\n\n`);
      res.end();
    }
  }
});

/**
 * GET /api/documents — Yüklenen dosyaları listeler
 */
app.get("/api/documents", (req, res) => {
  const liste = yukluDosyalar.map(d => ({
    ad: d.orijinalAd,
    parcaSayisi: d.parcaSayisi,
    tarih: d.tarih,
  }));
  res.json({
    dosyalar: liste,
    toplamParca: toplamParcaSayisi(),
  });
});

/**
 * POST /api/clear-history — Konuşma geçmişini temizler
 */
app.post("/api/clear-history", (req, res) => {
  gecmisiTemizle();
  console.log("🧹 Konuşma geçmişi temizlendi.");
  res.json({ success: true, message: "Konuşma geçmişi temizlendi." });
});

/**
 * GET /api/health — Sistem durumu kontrolü
 */
app.get("/api/health", async (req, res) => {
  const durum = await sistemKontrolu();
  res.json({
    ...durum,
    vektorVeritabaniHazir: veritabaniHazirMi(),
    toplamParca: toplamParcaSayisi(),
    yukluDosyaSayisi: yukluDosyalar.length,
  });
});

// ============================================================
// Sunucuyu Başlat
// ============================================================
app.listen(port, async () => {
  // Başlangıç sağlık kontrolü
  await baslangicKontrolu();
  console.log(`🌐 Uygulama başladı: http://localhost:${port}\n`);
});
