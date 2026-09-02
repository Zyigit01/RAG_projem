/**
 * Health Check Modülü
 * Ollama servisinin çalışıp çalışmadığını ve gerekli modellerin
 * yüklü olup olmadığını kontrol eder.
 */

const OLLAMA_BASE_URL = "http://localhost:11434";
const GEREKLI_MODELLER = ["llama3.1", "nomic-embed-text"];

/**
 * Ollama servisine ping atar.
 * @returns {Promise<boolean>}
 */
async function ollamaKontrol() {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Ollama'da yüklü olan modelleri listeler.
 * @returns {Promise<string[]>} Yüklü model isimleri
 */
async function yukluModelleriGetir() {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    const data = await response.json();
    // Ollama model isimlerini "llama3.1:latest" formatında döndürür,
    // biz sadece base ismi alıyoruz
    return (data.models || []).map(m => m.name.split(":")[0]);
  } catch {
    return [];
  }
}

/**
 * Tüm sistem sağlık kontrollerini çalıştırır.
 * @returns {Promise<{ollamaAktif: boolean, modeller: {isim: string, yuklu: boolean}[], hazir: boolean}>}
 */
async function sistemKontrolu() {
  const ollamaAktif = await ollamaKontrol();

  if (!ollamaAktif) {
    return {
      ollamaAktif: false,
      modeller: GEREKLI_MODELLER.map(isim => ({ isim, yuklu: false })),
      hazir: false,
    };
  }

  const yukluModeller = await yukluModelleriGetir();
  const modeller = GEREKLI_MODELLER.map(isim => ({
    isim,
    yuklu: yukluModeller.includes(isim),
  }));

  const hazir = ollamaAktif && modeller.every(m => m.yuklu);

  return { ollamaAktif, modeller, hazir };
}

/**
 * Başlangıçta konsola güzel formatlı durum raporu yazdırır.
 */
async function baslangicKontrolu() {
  console.log("\n🔍 Sistem kontrol ediliyor...\n");

  const durum = await sistemKontrolu();

  if (!durum.ollamaAktif) {
    console.log("❌ Ollama servisine bağlanılamıyor!");
    console.log("   → Ollama'yı başlatmak için terminalde 'ollama serve' yazın.");
    console.log("   → İndirmek için: https://ollama.com\n");
    return durum;
  }

  console.log("✅ Ollama servisi çalışıyor.");

  for (const model of durum.modeller) {
    if (model.yuklu) {
      console.log(`✅ ${model.isim} modeli yüklü.`);
    } else {
      console.log(`❌ ${model.isim} modeli bulunamadı!`);
      console.log(`   → Yüklemek için: ollama pull ${model.isim}`);
    }
  }

  if (durum.hazir) {
    console.log("\n🟢 Sistem hazır!\n");
  } else {
    console.log("\n🟡 Sistem eksik bileşenlerle başlatılıyor. Bazı özellikler çalışmayabilir.\n");
  }

  return durum;
}

module.exports = {
  sistemKontrolu,
  baslangicKontrolu,
};
