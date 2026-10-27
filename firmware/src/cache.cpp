#include "cache.h"
#include <LittleFS.h>
#include <deque>
#include <vector>
#include "config.h"
#include "lock.h"
#include "state.h"

namespace {

struct __attribute__((packed)) Entry {
  uint8_t  uid[10];
  uint8_t  uidLen;
  uint8_t  admin;
  uint8_t  days;      // bit0 = lunes … bit6 = domingo
  int16_t  start;     // minutos locales; -1 = sin ventana
  int16_t  end;
  uint32_t from;      // epoch UTC; 0 = sin límite
  uint32_t until;
};

struct __attribute__((packed)) Header {
  uint32_t magic;     // 'ACL1'
  char     version[33];
  int16_t  utcOffsetMin;
  uint32_t count;
};

struct __attribute__((packed)) Event {
  char     kind[12];
  char     uid[21];
  uint8_t  granted;
  char     reason[24];
  uint32_t ts;        // epoch (0 si no había hora válida)
};

constexpr uint32_t MAGIC = 0x314C4341;  // "ACL1"
const char* ALLOW_PATH = "/allow.bin";
const char* EVENTS_PATH = "/events.bin";

SemaphoreHandle_t   s_mtx;
std::vector<Entry>  s_entries;
char                s_version[33] = "";
int16_t             s_offset = 0;
std::deque<Event>   s_events;

struct Guard {
  Guard() { xSemaphoreTake(s_mtx, portMAX_DELAY); }
  ~Guard() { xSemaphoreGive(s_mtx); }
};

bool writeAtomic(const char* path, const void* hdr, size_t hdrLen, const void* data, size_t dataLen) {
  String tmp = String(path) + ".tmp";
  File f = LittleFS.open(tmp, "w");
  if (!f) return false;
  bool ok = f.write((const uint8_t*)hdr, hdrLen) == hdrLen &&
            (dataLen == 0 || f.write((const uint8_t*)data, dataLen) == dataLen);
  f.close();
  if (!ok) { LittleFS.remove(tmp); return false; }
  LittleFS.remove(path);
  return LittleFS.rename(tmp, path);   // un corte de luz deja el archivo viejo o el nuevo, nunca uno a medias
}

void loadAllowlist() {
  File f = LittleFS.open(ALLOW_PATH, "r");
  if (!f) return;
  Header h;
  if (f.read((uint8_t*)&h, sizeof h) != sizeof h || h.magic != MAGIC || h.count > ALLOWLIST_MAX_ENTRIES) { f.close(); return; }
  std::vector<Entry> v(h.count);
  if (h.count && f.read((uint8_t*)v.data(), h.count * sizeof(Entry)) != h.count * sizeof(Entry)) { f.close(); return; }
  f.close();
  s_entries.swap(v);
  memcpy(s_version, h.version, sizeof s_version);
  s_version[32] = 0;
  s_offset = h.utcOffsetMin;
}

void saveEvents() {
  std::vector<Event> v(s_events.begin(), s_events.end());
  uint32_t n = v.size();
  writeAtomic(EVENTS_PATH, &n, sizeof n, v.data(), v.size() * sizeof(Event));
}

void loadEvents() {
  File f = LittleFS.open(EVENTS_PATH, "r");
  if (!f) return;
  uint32_t n = 0;
  if (f.read((uint8_t*)&n, sizeof n) == sizeof n && n <= EVENTS_MAX) {
    for (uint32_t i = 0; i < n; i++) {
      Event e;
      if (f.read((uint8_t*)&e, sizeof e) != sizeof e) break;
      s_events.push_back(e);
    }
  }
  f.close();
}

bool inWindow(int16_t start, int16_t end, int minutes) {
  if (start < 0 || end < 0) return true;
  return start < end ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end);
}

}  // namespace

namespace Cache {

void begin() {
  s_mtx = xSemaphoreCreateMutex();
  if (!LittleFS.begin(true)) {           // true = formatea si la partición está vacía o corrupta
    log_e("LittleFS no disponible: la caché offline funcionará solo en RAM");
    return;
  }
  Guard g;
  loadAllowlist();
  loadEvents();
  log_i("Caché: %u UIDs (versión %s), %u eventos pendientes", (unsigned)s_entries.size(), s_version, (unsigned)s_events.size());
}

bool decide(const uint8_t* uid, uint8_t len, bool* admin, const char** reason) {
  Guard g;
  *admin = false;
  if (g_disabled) { *reason = "device_inactive"; return false; }

  const Entry* e = nullptr;
  for (const Entry& x : s_entries)
    if (x.uidLen == len && memcmp(x.uid, uid, len) == 0) { e = &x; break; }
  if (!e) { *reason = "unknown_credential"; return false; }

  *admin = e->admin;
  if (e->admin) { *reason = ""; return true; }                 // admin: válido siempre, incluso en lockdown
  if (Lock::lockdown()) { *reason = "lockdown"; return false; }

  bool hasTimeRules = e->from || e->until || e->days != 0x7F || e->start >= 0;
  if (!timeValid()) {
    // Sin hora fiable (arranque sin red y sin RTC) solo pasan credenciales sin restricciones horarias.
    if (hasTimeRules) { *reason = "outside_schedule"; return false; }
    *reason = ""; return true;
  }

  uint32_t now = nowEpoch();
  if ((e->from && now < e->from) || (e->until && now >= e->until)) { *reason = "grant_expired"; return false; }

  int64_t local = (int64_t)now + (int64_t)s_offset * 60;
  int dow = (int)(((local / 86400) + 3) % 7);                  // 1970-01-01 fue jueves => 0 = lunes
  int minutes = (int)((local % 86400) / 60);
  if (!(e->days & (1 << dow)) || !inWindow(e->start, e->end, minutes)) { *reason = "outside_schedule"; return false; }

  *reason = "";
  return true;
}

bool replace(JsonArrayConst entries, const char* version, int utcOffsetMin) {
  std::vector<Entry> v;
  v.reserve(min((size_t)entries.size(), (size_t)ALLOWLIST_MAX_ENTRIES));
  for (JsonObjectConst o : entries) {
    if (v.size() >= ALLOWLIST_MAX_ENTRIES) break;
    Entry e{};
    e.uidLen = hexToBytes(o["uid"] | "", e.uid, sizeof e.uid);
    if (e.uidLen < 4) continue;
    e.admin = o["admin"] | false;
    e.days  = (uint8_t)((o["days"] | 127) & 0x7F);
    e.start = o["start"].isNull() ? -1 : (int16_t)(o["start"].as<int>());
    e.end   = o["end"].isNull() ? -1 : (int16_t)(o["end"].as<int>());
    e.from  = o["from"].isNull() ? 0 : o["from"].as<uint32_t>();
    e.until = o["until"].isNull() ? 0 : o["until"].as<uint32_t>();
    v.push_back(e);
  }
  Header h{};
  h.magic = MAGIC;
  strlcpy(h.version, version, sizeof h.version);
  h.utcOffsetMin = (int16_t)utcOffsetMin;
  h.count = v.size();
  bool saved = writeAtomic(ALLOW_PATH, &h, sizeof h, v.data(), v.size() * sizeof(Entry));

  Guard g;
  s_entries.swap(v);
  strlcpy(s_version, version, sizeof s_version);
  s_offset = (int16_t)utcOffsetMin;
  return saved;
}

String version() { Guard g; return String(s_version); }
size_t size() { Guard g; return s_entries.size(); }

void pushEvent(const char* kind, const char* uidHex, bool granted, const char* reason) {
  Event e{};
  strlcpy(e.kind, kind, sizeof e.kind);
  strlcpy(e.uid, uidHex ? uidHex : "", sizeof e.uid);
  e.granted = granted;
  strlcpy(e.reason, reason ? reason : "", sizeof e.reason);
  e.ts = timeValid() ? nowEpoch() : 0;
  Guard g;
  if (s_events.size() >= EVENTS_MAX) s_events.pop_front();   // se conservan los más recientes
  s_events.push_back(e);
  saveEvents();
}

size_t pendingEvents() { Guard g; return s_events.size(); }

size_t peekEvents(JsonArray out, size_t max) {
  Guard g;
  size_t n = 0;
  for (const Event& e : s_events) {
    if (n >= max) break;
    JsonObject o = out.add<JsonObject>();
    o["kind"] = e.kind;
    if (e.uid[0]) o["uid"] = e.uid;
    o["granted"] = (bool)e.granted;
    if (e.reason[0]) o["reason"] = e.reason;
    if (e.ts) o["ts"] = e.ts;
    n++;
  }
  return n;
}

void dropEvents(size_t n) {
  Guard g;
  while (n-- && !s_events.empty()) s_events.pop_front();
  saveEvents();
}

}  // namespace Cache
