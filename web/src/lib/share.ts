import { DAY_NAMES, fmtDateTime } from './format';

/** URL pública del acceso. El token va en el fragmento (#): no viaja al servidor ni en Referer. */
export function passUrl(token: string, deviceCode?: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/p/${token}${deviceCode ? `?d=${deviceCode}` : ''}`;
}

export interface ShareInfo {
  guest: string;
  phone: string | null;
  doors: string[];
  from: string;
  until: string;
  days: number[] | null;
  start: string | null;
  end: string | null;
  maxUses: number | null;
}

export function usesText(max: number | null): string {
  return max === null ? 'Ilimitados durante la vigencia' : max === 1 ? '1 solo uso' : `${max} usos`;
}

export function daysText(days: number[] | null): string {
  if (!days || days.length === 7) return 'Todos los días';
  return days.map((n) => DAY_NAMES[n - 1]).join(', ');
}

/** Mensaje claro para el invitado. Con `pinSeparate` el PIN se omite (se manda en otro mensaje). */
export function buildMessage(i: ShareInfo, link: string, pin: string, pinSeparate: boolean): string {
  const lines = [
    `Hola ${i.guest} 👋`,
    `Te compartieron acceso a: ${i.doors.join(', ')}.`,
    '',
    `🔗 Abre este enlace al llegar:`,
    link,
  ];
  if (!pinSeparate) lines.push('', `🔑 PIN: ${pin}`);
  lines.push(
    '',
    `🕒 Válido: ${fmtDateTime(i.from)} → ${fmtDateTime(i.until)}`,
    `📅 Días: ${daysText(i.days)}`,
  );
  if (i.start && i.end) lines.push(`⏰ Horario: ${i.start} a ${i.end}`);
  lines.push(`🔢 Usos: ${usesText(i.maxUses)}`, '', 'Abre el enlace, escribe el PIN y toca la llave. No lo compartas con nadie más.');
  return lines.join('\n');
}

export const buildPinMessage = (guest: string, pin: string) =>
  `Hola ${guest}, tu PIN de acceso es: ${pin}\n(Úsalo con el enlace que te envié. No lo compartas.)`;

/** wa.me exige el número en formato internacional, solo dígitos. Sin número abre el selector de contactos. */
export function whatsappUrl(phone: string | null, text: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { return document.execCommand('copy'); } finally { ta.remove(); }
  }
}

interface NdefWriter { write(msg: { records: { recordType: string; data: string }[] }): Promise<void> }
export const canWriteNfc = () => 'NDEFReader' in window;

/** Android + Chrome: escribe la URL en un sticker NFC. En iPhone usa una app como «NFC Tools». */
export async function writeNfcTag(url: string): Promise<void> {
  const Ctor = (window as unknown as { NDEFReader: new () => NdefWriter }).NDEFReader;
  await new Ctor().write({ records: [{ recordType: 'url', data: url }] });
}
