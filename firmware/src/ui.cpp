// Pantalla TFT 1,8" 128x160 (ST7735): reposo (puerta, conexión, hora y estado) y una pantalla de color
// de UI_EVENT_MS por cada evento (concedido, denegado, registro…). Bus HSPI propio: el PN532 usa VSPI,
// así que lector y pantalla nunca comparten bus ni necesitan cerrojos entre tareas.
#include "ui.h"
#include "config.h"

#if DISPLAY_ENABLED
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <SPI.h>
#include <time.h>
#include "cache.h"
#include "lock.h"
#include "state.h"

namespace {

struct UiMsg {
  Ui::Kind kind;
  char     a[33];
  char     b[33];
};

constexpr uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) {
  return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}
constexpr uint16_t C_BG = rgb(15, 23, 42), C_BAR = rgb(30, 41, 59), C_TEXT = 0xFFFF, C_MUTED = rgb(148, 163, 184);
constexpr uint16_t C_OK = rgb(22, 163, 74), C_BAD = rgb(220, 38, 38), C_WARN = rgb(217, 119, 6), C_INFO = rgb(37, 99, 235);
constexpr int16_t  HEADER_H = 18, BAR_H = 32;

QueueHandle_t   s_queue = nullptr;
SPIClass        s_spi(HSPI);
Adafruit_ST7735 s_tft(&s_spi, PIN_TFT_CS, PIN_TFT_DC, PIN_TFT_RST);
int16_t         W = 160, H = 128;

/** UTF-8 -> CP437 (la fuente clásica de GFX): tildes, ñ, ¿ y ¡ del español. Lo demás, '?'. */
void toCp437(const char* in, char* out, size_t n) {
  size_t o = 0;
  const uint8_t* p = (const uint8_t*)(in ? in : "");
  while (*p && o + 1 < n) {
    uint8_t c = *p++;
    if (c < 0x80) { out[o++] = (char)c; continue; }
    char m = '?';
    if (c == 0xC3 && *p) {
      switch (*p++) {
        case 0xA1: m = (char)0xA0; break;  // á
        case 0xA9: m = (char)0x82; break;  // é
        case 0xAD: m = (char)0xA1; break;  // í
        case 0xB3: m = (char)0xA2; break;  // ó
        case 0xBA: m = (char)0xA3; break;  // ú
        case 0xBC: m = (char)0x81; break;  // ü
        case 0xB1: m = (char)0xA4; break;  // ñ
        case 0x91: m = (char)0xA5; break;  // Ñ
        case 0x89: m = (char)0x90; break;  // É
        case 0x81: m = 'A'; break;         // Á, Í, Ó, Ú: CP437 no las tiene
        case 0x8D: m = 'I'; break;
        case 0x93: m = 'O'; break;
        case 0x9A: m = 'U'; break;
      }
    } else if (c == 0xC2 && *p) {
      switch (*p++) {
        case 0xBF: m = (char)0xA8; break;  // ¿
        case 0xA1: m = (char)0xAD; break;  // ¡
        case 0xB0: m = (char)0xF8; break;  // °
      }
    } else {
      while ((*p & 0xC0) == 0x80) p++;     // otro carácter multibyte: se salta entero
    }
    out[o++] = m;
  }
  out[o] = 0;
}

/** 7B9D2A54 -> 7B:9D:2A:54 */
void fmtUid(const char* hex, char* out, size_t n) {
  size_t o = 0;
  for (size_t i = 0; hex[i] && hex[i + 1] && o + 3 < n; i += 2) {
    if (i) out[o++] = ':';
    out[o++] = hex[i];
    out[o++] = hex[i + 1];
  }
  out[o] = 0;
}

/** Imprime texto YA convertido a CP437 con la fuente clásica y fondo (se redibuja encima sin parpadeo). */
void printCp437(const char* cp, int16_t x, int16_t y, uint8_t size, uint16_t fg, uint16_t bg) {
  s_tft.setFont();
  s_tft.setTextSize(size);
  s_tft.setTextColor(fg, bg);
  s_tft.setCursor(x, y);
  s_tft.print(cp);
}

/** Texto UTF-8 (admite tildes) en la fuente clásica, recortado a `maxChars`. */
void classicAt(const char* utf8, int16_t x, int16_t y, uint8_t size, uint16_t fg, uint16_t bg, size_t maxChars) {
  char buf[48];
  toCp437(utf8, buf, sizeof buf);
  if (strlen(buf) > maxChars) buf[maxChars] = 0;
  printCp437(buf, x, y, size, fg, bg);
}

void classicCentered(const char* utf8, int16_t y, uint8_t size, uint16_t fg, uint16_t bg) {
  char buf[48];
  toCp437(utf8, buf, sizeof buf);
  size_t maxChars = W / (6 * size);
  if (strlen(buf) > maxChars) buf[maxChars] = 0;
  printCp437(buf, (W - (int16_t)(strlen(buf) * 6 * size)) / 2, y, size, fg, bg);
}

/** Fuente grande (solo ASCII), centrada sobre la línea base. Si no cabe, usa la clásica. */
void fontCentered(const GFXfont* f, const char* ascii, int16_t baseline, uint16_t fg, uint16_t bg) {
  int16_t x1, y1;
  uint16_t w, h;
  s_tft.setFont(f);
  s_tft.setTextSize(1);
  s_tft.getTextBounds(ascii, 0, baseline, &x1, &y1, &w, &h);
  if ((int16_t)w > W - 4) { classicCentered(ascii, baseline - 12, 2, fg, bg); return; }
  s_tft.setTextColor(fg);
  s_tft.setCursor((W - (int16_t)w) / 2 - x1, baseline);
  s_tft.print(ascii);
  s_tft.setFont();
}

enum class Icon : uint8_t { Check, Cross, Card };

void thickLine(int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint16_t c) {
  for (int8_t d = -2; d <= 2; d++) s_tft.drawLine(x0, y0 + d, x1, y1 + d, c);
}

void drawIcon(Icon i, int16_t cx, int16_t cy, uint16_t bg) {
  s_tft.fillCircle(cx, cy, 20, C_TEXT);
  switch (i) {
    case Icon::Check:
      thickLine(cx - 10, cy, cx - 3, cy + 7, bg);
      thickLine(cx - 3, cy + 7, cx + 10, cy - 7, bg);
      break;
    case Icon::Cross:
      thickLine(cx - 8, cy - 8, cx + 8, cy + 8, bg);
      thickLine(cx - 8, cy + 8, cx + 8, cy - 8, bg);
      break;
    case Icon::Card:
      s_tft.fillRoundRect(cx - 12, cy - 8, 24, 16, 3, bg);
      s_tft.fillRect(cx - 12, cy - 4, 24, 3, C_TEXT);
      break;
  }
}

const char* denyText(const char* r) {
  static const struct { const char* key; const char* text; } T[] = {
    {"unknown_credential", "Tarjeta no registrada"}, {"credential_inactive", "Tarjeta desactivada"},
    {"credential_expired", "Tarjeta vencida"},       {"user_suspended", "Usuario suspendido"},
    {"no_grant", "Sin permiso aquí"},                {"grant_expired", "Permiso vencido"},
    {"outside_schedule", "Fuera de horario"},        {"device_inactive", "Puerta deshabilitada"},
    {"lockdown", "Bloqueo total"},
  };
  for (auto& t : T)
    if (r && strcmp(r, t.key) == 0) return t.text;
  return "Acceso no permitido";
}

const char* enrollErrorText(const char* e) {
  if (!e || !*e) return "Sin conexión";
  if (strcmp(e, "uid_already_registered") == 0) return "Ya estaba registrada";
  return "Inténtalo de nuevo";
}

void drawEvent(const UiMsg& m) {
  uint16_t bg = C_OK;
  Icon icon = Icon::Check;
  const char *title = "", *l1 = nullptr, *l2 = nullptr;
  char uid[32] = "";
  switch (m.kind) {
    case Ui::Granted:
      title = "Bienvenido";
      l1 = *m.a ? m.a : "Acceso concedido";
      if (strcmp(m.b, "offline") == 0) l2 = "Modo sin conexión";
      break;
    case Ui::Remote:     title = "Abierto"; l1 = "Desde la app"; break;
    case Ui::ExitButton: title = "Salida";  l1 = "Puerta abierta"; break;
    case Ui::Denied:
      bg = C_BAD; icon = Icon::Cross; title = "Denegado";
      l1 = denyText(m.a);
      if (*m.b) { fmtUid(m.b, uid, sizeof uid); l2 = uid; }
      break;
    case Ui::EnrollWait:
      bg = C_INFO; icon = Icon::Card; title = "Registro"; l1 = "Acerque la tarjeta";
      break;
    case Ui::EnrollSent:
      bg = C_INFO; icon = Icon::Card; title = "Leyendo...";
      fmtUid(m.a, uid, sizeof uid); l1 = uid;
      break;
    case Ui::EnrollOk:
      title = "Registrada"; l1 = "Asígnala en el panel";
      fmtUid(m.a, uid, sizeof uid); l2 = uid;
      break;
    case Ui::EnrollFail:
      bg = C_BAD; icon = Icon::Cross; title = "Error"; l1 = enrollErrorText(m.a);
      break;
  }
  s_tft.fillScreen(bg);
  int16_t titleY = H * 60 / 100;
  drawIcon(icon, W / 2, H * 27 / 100, bg);
  fontCentered(&FreeSansBold9pt7b, title, titleY, C_TEXT, bg);
  if (l1 && *l1) {
    char b[48];
    toCp437(l1, b, sizeof b);
    classicCentered(l1, titleY + 8, strlen(b) * 12 <= (size_t)W ? 2 : 1, C_TEXT, bg);
  }
  if (l2 && *l2) classicCentered(l2, H - 14, 1, C_TEXT, bg);
}

// ---------------------------------------------------------------- reposo
void drawHeader(bool online, const char* name) {
  s_tft.fillRect(0, 0, W, HEADER_H, C_BAR);
  const char* st = online ? "En línea" : "Sin red";
  int16_t sx = W - 4 - 6 * (online ? 8 : 7);
  s_tft.fillCircle(sx - 7, 8, 3, online ? C_OK : C_BAD);
  classicAt(st, sx, 5, 1, C_MUTED, C_BAR, 10);
  classicAt(name, 4, 5, 1, C_TEXT, C_BAR, (sx - 16) / 6);
}

void drawClock(bool valid, const tm& t) {
  int16_t top = HEADER_H, bottom = H - BAR_H, center = (top + bottom) / 2;
  s_tft.fillRect(0, top, W, bottom - top, C_BG);
  char hhmm[6] = "--:--";
  if (valid) snprintf(hhmm, sizeof hhmm, "%02d:%02d", t.tm_hour, t.tm_min);
  fontCentered(&FreeSansBold18pt7b, hhmm, center + 8, C_TEXT, C_BG);
  if (!valid) return;
  static const char* D[] = {"dom", "lun", "mar", "mié", "jue", "vie", "sáb"};
  static const char* M[] = {"ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"};
  char d[24];
  snprintf(d, sizeof d, "%s %d %s", D[t.tm_wday], t.tm_mday, M[t.tm_mon]);
  classicCentered(d, center + 16, 1, C_MUTED, C_BG);
}

/** Estado de la barra inferior: lo más importante primero. */
uint16_t barState(char* l1, size_t n1, char* l2, size_t n2) {
  l2[0] = 0;
  uint32_t hold = Lock::holdUntil(), now = nowEpoch();
  bool holding = hold && timeValid() && now < hold && !Lock::lockdown();
  if (g_disabled) { strlcpy(l1, "Puerta deshabilitada", n1); return C_BAR; }
  if (Lock::lockdown()) { strlcpy(l1, "BLOQUEO TOTAL", n1); strlcpy(l2, "Solo administradores", n2); return C_BAD; }
  if (holding) {
    uint32_t s = hold - now;
    strlcpy(l1, "Puerta abierta", n1);
    if (s >= 3600) snprintf(l2, n2, "Cierra en %u:%02u:%02u", (unsigned)(s / 3600), (unsigned)(s / 60 % 60), (unsigned)(s % 60));
    else snprintf(l2, n2, "Cierra en %u:%02u", (unsigned)(s / 60), (unsigned)(s % 60));
    return C_WARN;
  }
  if (Lock::isUnlocked()) { strlcpy(l1, "Puerta abierta", n1); return C_OK; }
  if (enrollActive()) { strlcpy(l1, "Modo registro", n1); strlcpy(l2, "Acerque la tarjeta", n2); return C_INFO; }
  if (!g_online) { strlcpy(l1, "Sin conexión", n1); strlcpy(l2, "Funciona en modo local", n2); return C_BAR; }
  strlcpy(l1, "Acerque su tarjeta", n1);
  return C_BAR;
}

void drawBar(const char* l1, const char* l2, uint16_t bg) {
  int16_t y = H - BAR_H;
  s_tft.fillRect(0, y, W, BAR_H, bg);
  if (*l2) {
    classicCentered(l1, y + 6, 1, C_TEXT, bg);
    classicCentered(l2, y + 18, 1, C_TEXT, bg);
  } else {
    classicCentered(l1, y + 12, 1, C_TEXT, bg);
  }
}

}  // namespace

namespace Ui {

void begin() { s_queue = xQueueCreate(4, sizeof(UiMsg)); }

void event(Kind k, const char* a, const char* b) {
  if (!s_queue) return;
  UiMsg m{};
  m.kind = k;
  if (a) strlcpy(m.a, a, sizeof m.a);
  if (b) strlcpy(m.b, b, sizeof m.b);
  xQueueSend(s_queue, &m, 0);   // nunca bloquea a quien avisa
}

}  // namespace Ui

void uiTask(void*) {
  s_spi.begin(PIN_TFT_SCK, -1, PIN_TFT_MOSI, PIN_TFT_CS);
  s_tft.initR(TFT_TAB);
  s_tft.setSPISpeed(TFT_SPI_HZ);
  s_tft.setRotation(TFT_ROTATION);
  s_tft.cp437(true);
  s_tft.setTextWrap(false);
  W = s_tft.width();
  H = s_tft.height();

  s_tft.fillScreen(C_BG);
  fontCentered(&FreeSansBold9pt7b, "Control de acceso", H / 2, C_TEXT, C_BG);
  classicCentered("Conectando...", H / 2 + 10, 1, C_MUTED, C_BG);
  classicCentered("v" FW_VERSION, H - 12, 1, C_MUTED, C_BG);

  UiMsg m;
  bool inEvent = false, idle = false, lastOnline = false;
  Ui::Kind kind = Ui::Granted;
  uint32_t until = 0, lastLeft = 0;
  int lastMinute = -1;
  uint16_t lastBg = 0;
  char lastName[33] = "", lastL1[40] = "", lastL2[40] = "";

  for (;;) {
    if (xQueueReceive(s_queue, &m, pdMS_TO_TICKS(100)) == pdTRUE) {
      drawEvent(m);
      inEvent = true;
      idle = false;
      kind = m.kind;
      lastLeft = 0;
      until = millis() + (m.kind == Ui::EnrollSent ? 6000 : UI_EVENT_MS);
      continue;
    }

    uint32_t now = millis();
    if (inEvent) {
      if (kind == Ui::EnrollWait && enrollActive()) {   // cuenta atrás mientras el lector espera la tarjeta
        int32_t ms = msDiff(g_enrollUntilMs.load(), now);
        uint32_t left = ms > 0 ? (uint32_t)(ms + 999) / 1000 : 0;
        if (left != lastLeft) {
          char t[24];
          snprintf(t, sizeof t, "Quedan %u s", (unsigned)left);
          s_tft.fillRect(0, H - 16, W, 12, C_INFO);
          classicCentered(t, H - 14, 1, C_TEXT, C_INFO);
          lastLeft = left;
        }
        continue;
      }
      if (msDiff(until, now) > 0) continue;
      inEvent = false;
    }

    if (!idle) {   // al volver de un evento: se repinta todo
      s_tft.fillScreen(C_BG);
      idle = true;
      lastMinute = -1;
      lastName[0] = '\x01';
      lastName[1] = 0;
      lastL1[0] = '\x01';
      lastL1[1] = 0;
    }

    char name[33];
    deviceName(name, sizeof name);
    bool online = g_online;
    if (online != lastOnline || strcmp(name, lastName) != 0) {
      drawHeader(online, name);
      lastOnline = online;
      strlcpy(lastName, name, sizeof lastName);
    }

    bool valid = timeValid();
    tm t{};
    if (valid) {
      time_t local = (time_t)nowEpoch() + (time_t)Cache::utcOffsetMin() * 60;
      gmtime_r(&local, &t);
    }
    int minute = valid ? t.tm_hour * 60 + t.tm_min : -2;
    if (minute != lastMinute) {
      drawClock(valid, t);
      lastMinute = minute;
    }

    char l1[40], l2[40];
    uint16_t bg = barState(l1, sizeof l1, l2, sizeof l2);
    if (bg != lastBg || strcmp(l1, lastL1) != 0) {
      drawBar(l1, l2, bg);
    } else if (strcmp(l2, lastL2) != 0) {   // solo cambió la cuenta atrás: se repinta esa línea
      s_tft.fillRect(0, H - BAR_H + 16, W, 10, bg);
      classicCentered(l2, H - BAR_H + 18, 1, C_TEXT, bg);
    }
    lastBg = bg;
    strlcpy(lastL1, l1, sizeof lastL1);
    strlcpy(lastL2, l2, sizeof lastL2);
  }
}

#else  // sin pantalla

namespace Ui {
void begin() {}
void event(Kind, const char*, const char*) {}
}  // namespace Ui

void uiTask(void*) { vTaskDelete(nullptr); }

#endif
