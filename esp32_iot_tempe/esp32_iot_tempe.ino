#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ================= WIFI =================
char ssid[] = "Pakar Jamur Putih";
char pass[] = "Ragitempe6677";

// =============== FIREBASE ===============
const char* FIREBASE_HOST          = "https://iot-tempe-default-rtdb.firebaseio.com";
const char* FIREBASE_API_KEY       = "AIzaSyD0oflaBvFLrkY-G9lL4u48WxrcF_SoGg4";
const char* FIREBASE_REFRESH_TOKEN = "AMf-vBz5rG50scnXx_L9EJBBGChwnVS35GbqfaEapf0-7I1l99P1zhCugMGasTH4IPfuNnu4nZDfGjlvQNdG6WNS7nxKXQuzKrnEyjXICQ3cUihx-tnGpd89vaV213hBazgn260AE3VvjfBqTFIsn9GB4gE9qB6VNq4I91F0dm-6xed-lAZ9Ngs";
const char* DB_PATH                = "/inkubator";

String firebaseIdToken = "";
unsigned long waktuToken = 0;
const unsigned long INTERVAL_REFRESH_TOKEN = 50UL * 60UL * 1000UL; // 50 menit (token berlaku 60 menit)
bool sinkronAwalSelesai = false;

// ================= PIN ==================
#define ONE_WIRE_BUS 4
#define DHTPIN 18
#define DHTTYPE DHT22

#define RELAY_FAN_PIN 23
#define RELAY_LAMP_PIN 22

// Relay aktif LOW
const uint8_t RELAY_ON  = LOW;
const uint8_t RELAY_OFF = HIGH;

// ============== TARGET ==================
const float SUHU_TARGET = 35.0;

const unsigned long JAM_29 = 29UL * 60UL * 60UL;
const unsigned long JAM_30 = 30UL * 60UL * 60UL;

// Interval
const unsigned long INTERVAL_SENSOR   = 2000UL;
const unsigned long INTERVAL_FIREBASE = 2000UL;
const unsigned long INTERVAL_STATUS   = 5000UL;
const unsigned long INTERVAL_KONEKSI  = 10000UL;

// ============== SENSOR ==================
DHT dht(DHTPIN, DHTTYPE);
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature ds18b20(&oneWire);

// ============== VARIABEL ================
float suhuInti = NAN;
float suhuRuang = NAN;
float kelembapan = NAN;

bool sensorValid = false;
bool kipasAktif = false;
bool lampuAktif = false;

bool manualKipasOn = false;
bool manualLampuOn = false;
bool sistemStop = false;

bool notifikasi30JamDikirim = false;
bool errorSensorSebelumnya = false;

String statusInkubasi = "Inisialisasi";
String modeKontrol = "AUTO";

unsigned long waktuMulai;
unsigned long waktuSensor;
unsigned long waktuFirebase;
unsigned long waktuStatus;
unsigned long waktuDurasi;
unsigned long waktuWiFi;
unsigned long waktuCobaFirebase;

unsigned long durasiPemanasan = 0;
unsigned long durasiKipas = 0;

// ============== KONTROL RELAY ============

void setKipas(bool aktif) {
  digitalWrite(RELAY_FAN_PIN, aktif ? RELAY_ON : RELAY_OFF);
  kipasAktif = aktif;
}

void setLampu(bool aktif) {
  digitalWrite(RELAY_LAMP_PIN, aktif ? RELAY_ON : RELAY_OFF);
  lampuAktif = aktif;
}

void setOutput(bool kipas, bool lampu) {
  if (kipas && lampu) {
    kipas = false;
    lampu = false;
    Serial.println("[PENGAMAN] Kipas dan lampu tidak boleh ON bersamaan!");
  }

  setKipas(false);
  setLampu(false);

  if (kipas) {
    setKipas(true);
  } else if (lampu) {
    setLampu(true);
  }
}

// ============== FORMAT DURASI ============

unsigned long lamaInkubasi() {
  return (millis() - waktuMulai) / 1000UL;
}

String formatDurasi(unsigned long total) {
  unsigned long jam = total / 3600UL;
  unsigned long menit = (total % 3600UL) / 60UL;
  unsigned long detik = total % 60UL;

  char buffer[40];
  snprintf(buffer, sizeof(buffer), "%02lu jam %02lu menit %02lu detik", jam, menit, detik);
  return String(buffer);
}

// ============== SENSOR ===================

void bacaSensor() {
  ds18b20.requestTemperatures();

  float tInti = ds18b20.getTempCByIndex(0);
  float tRuang = dht.readTemperature();
  float rh = dht.readHumidity();

  bool dsOK = tInti != DEVICE_DISCONNECTED_C && !isnan(tInti) && tInti >= -55.0 && tInti <= 125.0;
  bool dhtOK = !isnan(tRuang) && !isnan(rh) && tRuang >= -40.0 && tRuang <= 80.0 && rh >= 0.0 && rh <= 100.0;

  sensorValid = dsOK && dhtOK;

  if (!sensorValid) {
    if (!errorSensorSebelumnya) {
      Serial.println("[ERROR] Sensor gagal dibaca. Semua relay OFF.");
    }
    errorSensorSebelumnya = true;
    setOutput(false, false);
    statusInkubasi = "Sensor error - output OFF";
    modeKontrol = "PENGAMAN";
    return;
  }

  errorSensorSebelumnya = false;
  suhuInti = tInti;
  suhuRuang = tRuang;
  kelembapan = rh;
}

// ============== LOGIKA INKUBASI ==========

void kontrolInkubasi() {
  if (sistemStop) {
    setOutput(false, false);
    statusInkubasi = "STOP - sistem dihentikan";
    modeKontrol = "STOP";
    return;
  }

  if (!sensorValid) {
    setOutput(false, false);
    statusInkubasi = "Sensor error - output OFF";
    modeKontrol = "PENGAMAN";
    return;
  }

  unsigned long lama = lamaInkubasi();
  bool sudah29Jam = lama >= JAM_29;
  bool sudah30Jam = lama >= JAM_30;

  if (manualKipasOn) {
    setOutput(true, false);
    modeKontrol = "MANUAL KIPAS";
    statusInkubasi = "Kipas ON - manual";
  } else if (manualLampuOn) {
    setOutput(false, true);
    modeKontrol = "MANUAL LAMPU";
    statusInkubasi = "Lampu ON - manual";
  } else {
    modeKontrol = "AUTO";

    if (suhuInti >= SUHU_TARGET) {
      setOutput(true, false);
      statusInkubasi = sudah30Jam ? "30 jam tercapai - kipas aktif" : "Pendinginan otomatis aktif";
    } else if (sudah29Jam) {
      setOutput(false, true);
      statusInkubasi = sudah30Jam ? "30 jam tercapai - lampu aktif" : "Pemanasan menjelang 30 jam";
    } else {
      setOutput(false, false);
      statusInkubasi = "Menunggu suhu/waktu";
    }
  }

  if (sudah30Jam && !notifikasi30JamDikirim) {
    notifikasi30JamDikirim = true;
    Serial.println("[INFO] Target inkubasi 30 jam tercapai. Periksa kondisi tempe.");
  }
}

// ============== DURASI AKTUATOR ==========

void hitungDurasi() {
  unsigned long sekarang = millis();
  unsigned long selisih = sekarang - waktuDurasi;

  if (selisih >= 1000UL) {
    unsigned long detik = selisih / 1000UL;

    if (lampuAktif) {
      durasiPemanasan += detik;
    }

    if (kipasAktif) {
      durasiKipas += detik;
    }

    waktuDurasi += detik * 1000UL;
  }
}

// ============== HELPER PARSING JSON ======

bool ambilBoolJson(const String& json, const char* key, bool nilaiDefault) {
  String pola = String("\"") + key + "\":";
  int idx = json.indexOf(pola);
  if (idx < 0) return nilaiDefault;
  int mulai = idx + pola.length();
  while (mulai < (int)json.length() && (json[mulai] == ' ' || json[mulai] == '\t')) {
    mulai++;
  }
  if (json.substring(mulai).startsWith("true") || json.substring(mulai).startsWith("1")) {
    return true;
  }
  if (json.substring(mulai).startsWith("false") || json.substring(mulai).startsWith("0")) {
    return false;
  }
  return nilaiDefault;
}

String ambilStringJson(const String& json, const char* key) {
  String pola = String("\"") + key + "\":";
  int idx = json.indexOf(pola);
  if (idx < 0) return "";
  int mulai = idx + pola.length();
  while (mulai < (int)json.length() && (json[mulai] == ' ' || json[mulai] == '\t' || json[mulai] == '\n' || json[mulai] == '\r')) {
    mulai++;
  }
  if (mulai >= (int)json.length() || json[mulai] != '\"') return "";
  mulai++; // lewati tanda kutip pembuka
  int akhir = json.indexOf("\"", mulai);
  if (akhir < 0) return "";
  return json.substring(mulai, akhir);
}

// ============== FIREBASE AUTH & DB =======

String buatUrlFirebase(const String& subPath) {
  String url = String(FIREBASE_HOST) + String(DB_PATH) + subPath + ".json";
  if (firebaseIdToken.length() > 0) {
    url += "?auth=" + firebaseIdToken;
  }
  return url;
}

bool autentikasiFirebase() {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String tokenUrl = String("https://securetoken.googleapis.com/v1/token?key=") + FIREBASE_API_KEY;

  http.setConnectTimeout(4000);
  http.setTimeout(4000);

  if (!http.begin(client, tokenUrl)) {
    return false;
  }

  http.addHeader("Content-Type", "application/x-www-form-urlencoded");
  String postData = String("grant_type=refresh_token&refresh_token=") + FIREBASE_REFRESH_TOKEN;
  int code = http.POST(postData);

  if (code == 200) {
    String resp = http.getString();
    String token = ambilStringJson(resp, "id_token");
    if (token.length() == 0) {
      token = ambilStringJson(resp, "access_token");
    }
    if (token.length() > 0) {
      firebaseIdToken = token;
      waktuToken = millis();
      Serial.println("[FIREBASE] Autentikasi Token ESP32 berhasil.");
      http.end();
      return true;
    } else {
      Serial.println("[FIREBASE] Gagal membaca id_token dari response.");
    }
  } else {
    String errBody = http.getString();
    Serial.printf("[FIREBASE] Auth kode %d: %s\n", code, errBody.c_str());
  }

  http.end();
  return false;
}

void sinkronisasiKontrolFirebase() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setConnectTimeout(1500);
  http.setTimeout(1500);

  String url = buatUrlFirebase("/control");
  if (!http.begin(client, url)) return;

  http.addHeader("Content-Type", "application/json");

  char payload[128];
  snprintf(
    payload,
    sizeof(payload),
    "{\"manualFan\":%s,\"manualLamp\":%s,\"stop\":%s}",
    manualKipasOn ? "true" : "false",
    manualLampuOn ? "true" : "false",
    sistemStop ? "true" : "false"
  );

  http.sendRequest("PATCH", (uint8_t*)payload, strlen(payload));
  http.end();
}

void bacaKontrolFirebase() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setConnectTimeout(1500);
  http.setTimeout(1500);

  String url = buatUrlFirebase("/control");
  if (!http.begin(client, url)) return;

  int code = http.GET();
  if (code == 401) {
    http.end();
    autentikasiFirebase();
    return;
  }

  if (code == 200) {
    String body = http.getString();
    http.end();

    // Jika node /inkubator/control belum ada di database, inisialisasi awal
    if (body == "null" || body.length() < 5) {
      sinkronisasiKontrolFirebase();
      sinkronAwalSelesai = true;
      return;
    }

    bool fbFan  = ambilBoolJson(body, "manualFan", manualKipasOn);
    bool fbLamp = ambilBoolJson(body, "manualLamp", manualLampuOn);
    bool fbStop = ambilBoolJson(body, "stop", sistemStop);

    bool berubah = false;
    bool perluKoreksiDatabase = false;

    // Sama dengan BLYNK_WRITE(V12) - Prioritas STOP darurat
    if (fbStop != sistemStop) {
      sistemStop = fbStop;
      berubah = true;
      if (sistemStop) {
        if (fbFan || fbLamp) perluKoreksiDatabase = true;
        manualKipasOn = false;
        manualLampuOn = false;
        setOutput(false, false);
        modeKontrol = "STOP";
        statusInkubasi = "STOP - sistem dihentikan";
      }
    }

    if (sistemStop) {
      if (fbFan || fbLamp) {
        manualKipasOn = false;
        manualLampuOn = false;
        perluKoreksiDatabase = true;
      }
    } else {
      // Sama dengan BLYNK_WRITE(V10) & BLYNK_WRITE(V11)
      if (fbFan != manualKipasOn) {
        manualKipasOn = fbFan;
        if (manualKipasOn && fbLamp) {
          fbLamp = false;
          perluKoreksiDatabase = true;
        }
        if (manualKipasOn) manualLampuOn = false;
        berubah = true;
      }

      if (fbLamp != manualLampuOn) {
        manualLampuOn = fbLamp;
        if (manualLampuOn && manualKipasOn) {
          manualKipasOn = false;
          perluKoreksiDatabase = true;
        }
        if (manualLampuOn) manualKipasOn = false;
        berubah = true;
      }
    }

    if (berubah || !sinkronAwalSelesai) {
      sinkronAwalSelesai = true;
      kontrolInkubasi();
    }

    if (perluKoreksiDatabase) {
      sinkronisasiKontrolFirebase();
    }
    return;
  }

  http.end();
}

void kirimDataFirebase() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setConnectTimeout(1500);
  http.setTimeout(1500);

  String url = buatUrlFirebase("");
  if (!http.begin(client, url)) return;

  http.addHeader("Content-Type", "application/json");

  unsigned long tInc = lamaInkubasi();
  String strInc  = formatDurasi(tInc);
  String strHeat = formatDurasi(durasiPemanasan);
  String strFan  = formatDurasi(durasiKipas);

  float cVal = sensorValid && !isnan(suhuInti) ? suhuInti : 0.0;
  float rVal = sensorValid && !isnan(suhuRuang) ? suhuRuang : 0.0;
  float hVal = sensorValid && !isnan(kelembapan) ? kelembapan : 0.0;

  char payload[680];
  snprintf(
    payload,
    sizeof(payload),
    "{"
      "\"sensor\":{\"core\":%.1f,\"room\":%.1f,\"hum\":%.1f,\"valid\":%s},"
      "\"actuator\":{\"fanOn\":%s,\"lampOn\":%s},"
      "\"timers\":{\"tIncubation\":%lu,\"tHeat\":%lu,\"tFan\":%lu,\"incubationStr\":\"%s\",\"heatStr\":\"%s\",\"fanStr\":\"%s\"},"
      "\"status\":{\"mode\":\"%s\",\"info\":\"%s\",\"notif30Jam\":%s,\"updatedAt\":{\".sv\":\"timestamp\"}}"
    "}",
    cVal, rVal, hVal, sensorValid ? "true" : "false",
    kipasAktif ? "true" : "false",
    lampuAktif ? "true" : "false",
    tInc, durasiPemanasan, durasiKipas,
    strInc.c_str(), strHeat.c_str(), strFan.c_str(),
    modeKontrol.c_str(), statusInkubasi.c_str(),
    notifikasi30JamDikirim ? "true" : "false"
  );

  int code = http.sendRequest("PATCH", (uint8_t*)payload, strlen(payload));
  if (code == 401) {
    http.end();
    autentikasiFirebase();
    return;
  }

  http.end();
}

// ============== SETUP ====================

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(RELAY_FAN_PIN, OUTPUT);
  pinMode(RELAY_LAMP_PIN, OUTPUT);

  digitalWrite(RELAY_FAN_PIN, RELAY_OFF);
  digitalWrite(RELAY_LAMP_PIN, RELAY_OFF);

  dht.begin();
  ds18b20.begin();

  waktuMulai = millis();
  waktuSensor = millis();
  waktuFirebase = millis();
  waktuStatus = millis();
  waktuDurasi = millis();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, pass);

  waktuWiFi = millis();
  waktuCobaFirebase = millis();

  bacaSensor();
  kontrolInkubasi();
}

// ============== LOOP =====================

void loop() {
  unsigned long sekarang = millis();

  // 1. Reconnect WiFi non-blocking jika terputus
  if (WiFi.status() != WL_CONNECTED && sekarang - waktuWiFi >= INTERVAL_KONEKSI) {
    waktuWiFi = sekarang;
    WiFi.disconnect();
    WiFi.begin(ssid, pass);
  }

  // 2. Autentikasi & refresh token Firebase saat WiFi terhubung
  if (WiFi.status() == WL_CONNECTED) {
    if (firebaseIdToken.length() == 0 && sekarang - waktuCobaFirebase >= 3000UL) {
      waktuCobaFirebase = sekarang;
      if (autentikasiFirebase()) {
        bacaKontrolFirebase();
        kirimDataFirebase();
      }
    } else if (firebaseIdToken.length() > 0 && sekarang - waktuToken >= INTERVAL_REFRESH_TOKEN) {
      autentikasiFirebase();
    }
  }

  // 3. Perhitungan durasi & pembacaan sensor lokal tetap berjalan (meskipun offline)
  hitungDurasi();

  if (sekarang - waktuSensor >= INTERVAL_SENSOR) {
    waktuSensor = sekarang;
    bacaSensor();
    kontrolInkubasi();
  }

  // 4. Sinkronisasi data & kontrol ke Firebase Realtime Database
  if (sekarang - waktuFirebase >= INTERVAL_FIREBASE) {
    waktuFirebase = sekarang;
    if (WiFi.status() == WL_CONNECTED && firebaseIdToken.length() > 0) {
      bacaKontrolFirebase();
      kirimDataFirebase();
    }
  }
}
