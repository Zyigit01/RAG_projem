const { PDFLoader } = require("@langchain/community/document_loaders/fs/pdf");
const { RecursiveCharacterTextSplitter } = require("@langchain/textsplitters");
const { OllamaEmbeddings, Ollama } = require("@langchain/ollama");
const { PromptTemplate } = require("@langchain/core/prompts");
const { StringOutputParser } = require("@langchain/core/output_parsers");
const { RunnableSequence, RunnablePassthrough } = require("@langchain/core/runnables");
const fs = require("fs");
const path = require("path");

// ============================================================
// Kendi yazdigim basit bir vektor veritabani (In-Memory)
// ============================================================
// Normalde Chroma, Pinecone, Weaviate gibi vektor veritabanlari
// kullanilir. Ama bu projede RAG'in arka planini anlamak icin
// cosine similarity hesabini kendim yazdim.
//
// Cosine Similarity formulu:
//   similarity = (A · B) / (||A|| × ||B||)
//   - A · B  = iki vektorun nokta carpimi (dot product)
//   - ||A||  = A vektorunun buyuklugu (norm/magnitude)
//   Sonuc -1 ile 1 arasinda olur. 1 = tamamen ayni yon
// ============================================================
class BasitVektorDB {
  constructor(embeddingsModeli) {
    this.embeddings = embeddingsModeli;
    this.hafiza = []; // {doc, vector, dosyaAdi} dizisi
  }

  static async dokumanlardanOlustur(docs, embeddings, dosyaAdi = "bilinmiyor") {
    const db = new BasitVektorDB(embeddings);
    await db.dokumanEkle(docs, dosyaAdi);
    return db;
  }

  async dokumanEkle(docs, dosyaAdi = "bilinmiyor") {
    const metinler = docs.map(d => d.pageContent);

    // Embedding modeli her metni sabit boyutlu bir vektöre dönüştürür
    // nomic-embed-text 768 boyutlu vektörler üretir
    const vektorler = await this.embeddings.embedDocuments(metinler);

    for (let i = 0; i < docs.length; i++) {
      this.hafiza.push({
        doc: docs[i],
        vector: vektorler[i],
        dosyaAdi: dosyaAdi,
      });
    }
  }

  /**
   * Cosine similarity ile en benzer chunk'lari bulur.
   * Hem döküman hem de benzerlik skorunu döndürür (kaynak gösterimi için).
   */
  async benzerlikAramasi(soru, k = 6) {
    const soruVektoru = await this.embeddings.embedQuery(soru);

    const sonuclar = this.hafiza.map(item => {
      let carpim = 0, normA = 0, normB = 0;
      for (let i = 0; i < soruVektoru.length; i++) {
        carpim += soruVektoru[i] * item.vector[i];
        normA += soruVektoru[i] * soruVektoru[i];
        normB += item.vector[i] * item.vector[i];
      }
      const benzerlik = carpim / (Math.sqrt(normA) * Math.sqrt(normB));
      return { ...item, benzerlik };
    });

    // En çok benzeyenleri sırala (büyükten küçüğe)
    sonuclar.sort((a, b) => b.benzerlik - a.benzerlik);
    return sonuclar.slice(0, k);
  }

  /**
   * LangChain uyumlu retriever arayüzü
   */
  asRetriever(k = 6) {
    return {
      pipe: (fn) => async (soru) => {
        const sonuclar = await this.benzerlikAramasi(soru, k);
        return fn(sonuclar.map(r => r.doc));
      },
      invoke: async (soru) => {
        const sonuclar = await this.benzerlikAramasi(soru, k);
        return sonuclar.map(r => r.doc);
      },
    };
  }

  /** Veritabanındaki toplam chunk sayısı */
  get toplamParca() {
    return this.hafiza.length;
  }
}

// ============================================================
// Ollama Ayarları
// ============================================================
const embeddings = new OllamaEmbeddings({
  model: "nomic-embed-text",
  baseUrl: "http://localhost:11434",
});

const model = new Ollama({
  model: "llama3.1",
  baseUrl: "http://localhost:11434",
  temperature: 0.1, // Düşük temperature = daha tutarlı/kararlı cevaplar
});

let vektorVeritabani = null;

// Konuşma geçmişi (Chat History)
let konusmaGecmisi = [];
const MAX_GECMIS = 10; // Son 10 mesajı tut

// ============================================================
// Dosya İşleme — Çoklu Format Desteği
// ============================================================

/**
 * Dosya uzantısına göre uygun loader ile dökümanı yükler.
 * Desteklenen formatlar: PDF, TXT, DOCX
 */
async function dosyaYukle(dosyaYolu) {
  const uzanti = path.extname(dosyaYolu).toLowerCase();

  switch (uzanti) {
    case ".pdf": {
      const loader = new PDFLoader(dosyaYolu);
      return await loader.load();
    }
    case ".txt":
    case ".md": {
      // TXT dosyaları için manuel yükleme
      const icerik = fs.readFileSync(dosyaYolu, "utf-8");
      return [
        {
          pageContent: icerik,
          metadata: { source: dosyaYolu },
        },
      ];
    }
    case ".docx": {
      // mammoth kütüphanesi ile DOCX'den düz metin çıkar
      const mammoth = require("mammoth");
      const buffer = fs.readFileSync(dosyaYolu);
      const sonuc = await mammoth.extractRawText({ buffer });
      return [
        {
          pageContent: sonuc.value,
          metadata: { source: dosyaYolu },
        },
      ];
    }
    default:
      throw new Error(`Desteklenmeyen dosya formatı: ${uzanti}. Desteklenen: PDF, TXT, DOCX`);
  }
}

/**
 * Dökümanı yükler, parçalar ve vektör veritabanına ekler.
 * @param {string} dosyaYolu - Dosyanın disk üzerindeki yolu
 * @param {string} dosyaAdi - Orijinal dosya adı (kaynak gösterimi için)
 * @returns {Promise<number>} Oluşturulan parça (chunk) sayısı
 */
async function dokumanIsle(dosyaYolu, dosyaAdi = "bilinmiyor") {
  const dokumanlar = await dosyaYukle(dosyaYolu);

  // Metni parçalara (chunk) bölüyoruz
  // chunkSize: Her parçanın maksimum karakter sayısı
  // chunkOverlap: Parçalar arası örtüşme (bağlam korunması için)
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const parcaliDokumanlar = await splitter.splitDocuments(dokumanlar);

  // Vektör veritabanına ekle
  if (!vektorVeritabani) {
    vektorVeritabani = await BasitVektorDB.dokumanlardanOlustur(
      parcaliDokumanlar,
      embeddings,
      dosyaAdi
    );
  } else {
    await vektorVeritabani.dokumanEkle(parcaliDokumanlar, dosyaAdi);
  }

  return parcaliDokumanlar.length;
}

// ============================================================
// Soru-Cevap (Normal — Tüm Cevap Tek Seferde)
// ============================================================

/**
 * RAG zinciri ile soru sorar. Kaynak chunk'ları da döndürür.
 * @param {string} soru
 * @returns {Promise<{cevap: string, kaynaklar: Array}>}
 */
async function soruSor(soru) {
  if (!vektorVeritabani) {
    throw new Error("Lütfen önce bir dosya yükleyin!");
  }

  // 1. Retrieval — En benzer 6 parçayı bul
  const benzerSonuclar = await vektorVeritabani.benzerlikAramasi(soru, 6);

  // Kaynakları hazırla (kaynak gösterimi için)
  const kaynaklar = benzerSonuclar.map((s, i) => ({
    sira: i + 1,
    icerik: s.doc.pageContent.substring(0, 200) + "...",
    sayfa: s.doc.metadata?.loc?.pageNumber || s.doc.metadata?.page || "?",
    dosya: s.dosyaAdi,
    benzerlik: Math.round(s.benzerlik * 100) + "%",
  }));

  // 2. Context oluştur
  const context = benzerSonuclar.map(s => s.doc.pageContent).join("\n\n");

  // 3. Konuşma geçmişini prompt'a ekle
  const gecmisMetni = konusmaGecmisi.length > 0
    ? "Önceki konuşma:\n" + konusmaGecmisi.map(m => `${m.rol}: ${m.icerik}`).join("\n") + "\n\n"
    : "";

  // 4. Prompt oluştur
  const template = `Sen bir belge analiz asistanısın. Sadece aşağıdaki metne (Context) bakarak soruyu cevapla.
Metinde yoksa uydurma, "Bu bilgi yüklenen belgelerde bulunamadı." de. Türkçe cevap ver.
Cevaplarını düzgün paragraflar halinde yaz.

${gecmisMetni}Context:
${context}

Soru: ${soru}

Cevap:`;

  const prompt = PromptTemplate.fromTemplate(template);
  const chain = RunnableSequence.from([
    {
      context: () => context,
      question: new RunnablePassthrough(),
    },
    prompt,
    model,
    new StringOutputParser(),
  ]);

  const cevap = await chain.invoke(soru);

  // 5. Konuşma geçmişine ekle
  konusmaGecmisi.push({ rol: "Kullanıcı", icerik: soru });
  konusmaGecmisi.push({ rol: "Asistan", icerik: cevap });

  // Geçmiş çok uzarsa eski mesajları sil
  if (konusmaGecmisi.length > MAX_GECMIS * 2) {
    konusmaGecmisi = konusmaGecmisi.slice(-MAX_GECMIS * 2);
  }

  return { cevap, kaynaklar };
}

// ============================================================
// Soru-Cevap (Streaming — Kelime Kelime)
// ============================================================

/**
 * RAG zinciri ile soru sorar, cevabı stream olarak döndürür.
 * Server-Sent Events (SSE) ile kullanılır.
 * @param {string} soru
 * @param {function} onToken - Her token geldiğinde çağrılır
 * @returns {Promise<{kaynaklar: Array}>}
 */
async function soruSorStream(soru, onToken) {
  if (!vektorVeritabani) {
    throw new Error("Lütfen önce bir dosya yükleyin!");
  }

  // 1. Retrieval
  const benzerSonuclar = await vektorVeritabani.benzerlikAramasi(soru, 6);

  const kaynaklar = benzerSonuclar.map((s, i) => ({
    sira: i + 1,
    icerik: s.doc.pageContent.substring(0, 200) + "...",
    sayfa: s.doc.metadata?.loc?.pageNumber || s.doc.metadata?.page || "?",
    dosya: s.dosyaAdi,
    benzerlik: Math.round(s.benzerlik * 100) + "%",
  }));

  const context = benzerSonuclar.map(s => s.doc.pageContent).join("\n\n");

  const gecmisMetni = konusmaGecmisi.length > 0
    ? "Önceki konuşma:\n" + konusmaGecmisi.map(m => `${m.rol}: ${m.icerik}`).join("\n") + "\n\n"
    : "";

  // 2. Streaming prompt — Ollama'ya doğrudan istek atıyoruz
  const tamPrompt = `Sen bir belge analiz asistanısın. Sadece aşağıdaki metne (Context) bakarak soruyu cevapla.
Metinde yoksa uydurma, "Bu bilgi yüklenen belgelerde bulunamadı." de. Türkçe cevap ver.
Cevaplarını düzgün paragraflar halinde yaz.

${gecmisMetni}Context:
${context}

Soru: ${soru}

Cevap:`;

  // Ollama streaming API'si ile token token cevap al
  let tamCevap = "";
  const response = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3.1",
      prompt: tamPrompt,
      stream: true,
      options: { temperature: 0.1 },
    }),
  });

  // NDJSON (Newline Delimited JSON) formatında stream oku
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const satirlar = buffer.split("\n");
    buffer = satirlar.pop(); // Son (tamamlanmamış) satırı buffer'da tut

    for (const satir of satirlar) {
      if (satir.trim()) {
        try {
          const json = JSON.parse(satir);
          if (json.response) {
            tamCevap += json.response;
            onToken(json.response); // Her token'ı callback'e gönder
          }
        } catch {
          // JSON parse hatası — satır tamamlanmamış, devam et
        }
      }
    }
  }

  // 3. Konuşma geçmişine ekle
  konusmaGecmisi.push({ rol: "Kullanıcı", icerik: soru });
  konusmaGecmisi.push({ rol: "Asistan", icerik: tamCevap });

  if (konusmaGecmisi.length > MAX_GECMIS * 2) {
    konusmaGecmisi = konusmaGecmisi.slice(-MAX_GECMIS * 2);
  }

  return { kaynaklar };
}

// ============================================================
// Yardımcı Fonksiyonlar
// ============================================================

/** Konuşma geçmişini temizler */
function gecmisiTemizle() {
  konusmaGecmisi = [];
}

/** Vektör veritabanının yüklü olup olmadığını kontrol eder */
function veritabaniHazirMi() {
  return vektorVeritabani !== null;
}

/** Veritabanındaki toplam chunk sayısını döndürür */
function toplamParcaSayisi() {
  return vektorVeritabani ? vektorVeritabani.toplamParca : 0;
}

module.exports = {
  dokumanIsle,
  soruSor,
  soruSorStream,
  gecmisiTemizle,
  veritabaniHazirMi,
  toplamParcaSayisi,
};
