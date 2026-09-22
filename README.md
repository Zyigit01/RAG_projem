# 🚀 Local RAG Application — Retrieval-Augmented Generation

![Microsoft AI Innovators](https://img.shields.io/badge/Microsoft-AI_Innovators-0078D4?style=for-the-badge&logo=microsoft)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-000000?style=for-the-badge&logo=ollama&logoColor=white)
![LangChain](https://img.shields.io/badge/LangChain-1C3C3C?style=for-the-badge&logo=langchain&logoColor=white)

Bu proje, **Microsoft AI Innovators Yaz Stajı** kapsamında geliştirilmiş, verilerin buluta aktarılmadan **%100 lokal bilgisayarda** işlendiği bir **RAG (Retrieval-Augmented Generation)** uygulamasıdır.

Gizli ve hassas kurum belgelerinin internete (OpenAI, Gemini vb. public servislere) çıkarılmadan, doğrudan bilgisayarınızın işlem gücüyle güvenli bir şekilde analiz edilmesi prensibine dayanır.

---

## 🌟 Özellikler

| Özellik | Açıklama |
|---------|----------|
| 🔒 **%100 Lokal** | Tüm veriler bilgisayardan çıkmaz — KVKK/GDPR uyumlu |
| 📄 **Çoklu Format** | PDF, TXT, DOCX belge desteği |
| ⚡ **Streaming Cevap** | Kelime kelime gerçek zamanlı yanıt (SSE protokolü) |
| 📎 **Kaynak Gösterimi** | Her cevapla birlikte hangi paragraftan bilgi alındığı gösterilir |
| 💬 **Chat Geçmişi** | Takip soruları sorabilme — "Bunu açıklar mısın?" çalışır |
| 🔍 **Duplikasyon Kontrolü** | Aynı dosyanın tekrar yüklenmesini MD5 hash ile engeller |
| 🩺 **Sistem Durumu** | Ollama ve model kontrolleri, canlı durum göstergesi |
| 🧠 **Kendi Vektör DB** | Cosine similarity ile in-memory vektör veritabanı |

---

## 🏗️ Mimari

```
Kullanıcı (Tarayıcı)
    │
    ├── 1. Belge Yükle (PDF/TXT/DOCX)
    │       ↓
    │   [server.js] → Multer ile dosyayı al → MD5 hash kontrolü
    │       ↓
    │   [rag.js] → Loader ile metni çıkar → Chunk'lara böl (1000 kar, 200 overlap)
    │       ↓
    │   [Ollama: nomic-embed-text] → Her chunk'ı 768 boyutlu vektöre dönüştür
    │       ↓
    │   [BasitVektorDB] → Chunk + Vektör çiftlerini bellekte sakla
    │
    └── 2. Soru Sor
            ↓
        [Ollama: nomic-embed-text] → Soruyu vektöre dönüştür
            ↓
        [BasitVektorDB] → Cosine similarity ile en benzer 6 chunk'ı bul
            ↓
        [Prompt] → Context (6 chunk) + Soru + Chat Geçmişi
            ↓
        [Ollama: Llama 3.1] → Streaming cevap üret (SSE ile tarayıcıya aktar)
            ↓
        Kullanıcı → Cevap + Kaynaklar (sayfa no, benzerlik %)
```

---

## 🛠️ Kullanılan Teknolojiler

| Katman | Teknoloji |
|--------|-----------|
| **Backend** | Node.js, Express.js |
| **Frontend** | HTML5, CSS3, Vanilla JavaScript |
| **LLM** | Llama 3.1 (Ollama üzerinden lokal) |
| **Embedding** | nomic-embed-text (768 boyutlu vektörler) |
| **Vektör DB** | BasitVektorDB — kendi yazdığım in-memory cosine similarity implementasyonu |
| **Belge İşleme** | pdf-parse (PDF), mammoth (DOCX), fs (TXT) |
| **Streaming** | Server-Sent Events (SSE) |
| **Framework** | LangChain.js |

---

## 📁 Proje Yapısı

```
local-rag-project/
├── server.js          # Express API (upload, chat, stream, health, documents)
├── rag.js             # RAG motoru (vektör DB, embedding, chunking, LLM zinciri)
├── health.js          # Ollama bağlantı ve model kontrolü
├── public/
│   └── index.html     # Chat arayüzü (streaming, kaynak gösterimi, drag & drop)
├── uploads/           # Yüklenen belgeler
├── package.json       # Bağımlılıklar
└── README.md
```

---

## ⚙️ Kurulum ve Çalıştırma

### Gereksinimler
- [Node.js](https://nodejs.org/) (v18+)
- [Ollama](https://ollama.com/)

### 1. Modelleri İndirin
```bash
ollama pull llama3.1
ollama pull nomic-embed-text
```

### 2. Bağımlılıkları Yükleyin
```bash
npm install
```

### 3. Sunucuyu Başlatın
```bash
node server.js
```

### 4. Tarayıcıda Açın
```
http://localhost:3000
```

> Başlangıçta sistem otomatik olarak Ollama ve modellerin durumunu kontrol eder.

---

## 🔌 API Endpoint'leri

| Yöntem | Endpoint | Açıklama |
|--------|----------|----------|
| `POST` | `/api/upload` | Belge yükle ve vektörleştir |
| `POST` | `/api/chat` | Soru sor (tam cevap) |
| `GET` | `/api/chat/stream?question=...` | Soru sor (streaming — SSE) |
| `GET` | `/api/documents` | Yüklenen dosyaları listele |
| `POST` | `/api/clear-history` | Konuşma geçmişini temizle |
| `GET` | `/api/health` | Sistem sağlık durumu |

---

## 🧠 Nasıl Çalışıyor? (RAG Pipeline)

1. **Belge Yükleme** → PDF/TXT/DOCX dosyasından ham metin çıkarılır
2. **Chunking** → Metin 1000 karakterlik parçalara bölünür (200 overlap)
3. **Embedding** → Her chunk, nomic-embed-text ile 768 boyutlu vektöre dönüştürülür
4. **Saklama** → Chunk + vektör çiftleri bellekte saklanır
5. **Soru Sorma** → Soru da aynı modelle vektöre dönüşür
6. **Retrieval** → Cosine similarity ile en benzer 6 chunk bulunur
7. **Generation** → Context + soru, Llama 3.1'e gönderilerek cevap üretilir
8. **Streaming** → Cevap SSE ile kelime kelime kullanıcıya aktarılır

---

## 🛡️ Halüsinasyon Kontrolü

Üç katmanlı koruma:
1. **Prompt düzeyinde**: "Sadece verilen context'e bakarak cevapla, yoksa uydurma"
2. **Temperature**: 0.1 — düşük değer, deterministik ve tutarlı çıktı
3. **Kaynak gösterimi**: Her cevapla birlikte kaynaklar gösterilir, kullanıcı doğrulayabilir

---

## 📌 Neler Öğrendim?

- RAG mimarisinin uçtan uca işleyişi
- Embedding ve cosine similarity kavramları (kendi implementasyonumla)
- Prompt engineering ile halüsinasyon kontrolü
- SSE (Server-Sent Events) ile streaming
- Lokal yapay zeka modellerinin web projelerine entegrasyonu
- Veri gizliliği gerektiren senaryolarda AI çözümleri
