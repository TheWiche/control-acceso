import { useState } from 'react';
import { Check, Copy, KeyRound, Link2, MessageCircle, Nfc, TriangleAlert } from 'lucide-react';
import type { PassSecret } from '../lib/types';
import { buildMessage, buildPinMessage, canWriteNfc, copyText, passUrl, whatsappUrl, writeNfcTag, type ShareInfo } from '../lib/share';
import { Modal, useToast } from './ui';

/** Se muestra UNA vez tras crear/regenerar: el servidor solo conserva el hash del token y del PIN. */
export function PassShare({ secret, info, doorCodes, onClose }: {
  secret: PassSecret; info: ShareInfo; doorCodes: { code: string; name: string }[]; onClose: () => void;
}) {
  const { push } = useToast();
  const [pinSeparate, setPinSeparate] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const link = passUrl(secret.token);
  const message = buildMessage(info, link, secret.pin, pinSeparate);

  async function copy(key: string, text: string) {
    if (await copyText(text)) { setCopied(key); setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800); }
    else push({ kind: 'err', title: 'No se pudo copiar' });
  }

  async function nfc(url: string) {
    try { await writeNfcTag(url); push({ kind: 'ok', title: 'Sticker NFC escrito', text: 'Acércalo a un celular para probarlo.' }); }
    catch (e) { push({ kind: 'err', title: 'No se pudo escribir el sticker', text: e instanceof Error ? e.message : undefined }); }
  }

  return (
    <Modal title="Acceso creado" onClose={onClose} wide
      footer={<button className="btn btn-primary" onClick={onClose}>Listo</button>}>
      <div className="stack">
        <div className="banner banner-warn">
          <TriangleAlert size={18} aria-hidden />
          <div>Guarda o envía el enlace y el PIN <strong>ahora</strong>: por seguridad no se pueden volver a ver. Si los pierdes, usa «Regenerar» en la lista.</div>
        </div>

        <div className="share-box">
          <span className="muted small"><Link2 size={14} aria-hidden /> Enlace único</span>
          <div className="share-row">
            <code className="share-link">{link}</code>
            <button className="icon-btn" aria-label="Copiar enlace" onClick={() => void copy('link', link)}>{copied === 'link' ? <Check size={18} /> : <Copy size={18} />}</button>
          </div>
        </div>

        <div className="share-box">
          <span className="muted small"><KeyRound size={14} aria-hidden /> PIN</span>
          <div className="share-row">
            <span className="pin-big mono">{secret.pin}</span>
            <button className="icon-btn" aria-label="Copiar PIN" onClick={() => void copy('pin', secret.pin)}>{copied === 'pin' ? <Check size={18} /> : <Copy size={18} />}</button>
          </div>
        </div>

        <label className="check">
          <input type="checkbox" checked={pinSeparate} onChange={(e) => setPinSeparate(e.target.checked)} />
          <span>Enviar el PIN en un mensaje aparte <span className="muted small">(más seguro: si interceptan uno, no sirve)</span></span>
        </label>

        <pre className="msg-preview">{message}</pre>

        <div className="share-actions">
          <a className="btn btn-wa" href={whatsappUrl(info.phone, message)} target="_blank" rel="noopener noreferrer">
            <MessageCircle size={18} aria-hidden />Compartir por WhatsApp
          </a>
          {pinSeparate && (
            <a className="btn" href={whatsappUrl(info.phone, buildPinMessage(info.guest, secret.pin))} target="_blank" rel="noopener noreferrer">
              <KeyRound size={16} aria-hidden />Enviar el PIN por separado
            </a>
          )}
          <button className="btn" onClick={() => void copy('msg', message)}>{copied === 'msg' ? <Check size={16} /> : <Copy size={16} />}Copiar mensaje</button>
        </div>

        <details className="nfc-help">
          <summary><Nfc size={16} aria-hidden /> Sticker NFC / QR en la puerta</summary>
          <p className="muted small">
            Escribe esta URL en un sticker NFC pegado junto a la puerta: el invitado acerca el teléfono, escribe su PIN y abre.
            El PIN <strong>no</strong> va en el sticker. Si pierdes el sticker, revoca el acceso o regenera el enlace.
            En iPhone no se puede escribir desde la web: usa una app como «NFC Tools».
          </p>
          {doorCodes.map((d) => {
            const url = passUrl(secret.token, d.code);
            return (
              <div key={d.code} className="share-row">
                <div className="nfc-url"><strong className="small">{d.name}</strong><code className="share-link">{url}</code></div>
                <button className="icon-btn" aria-label={`Copiar URL de ${d.name}`} onClick={() => void copy(`d-${d.code}`, url)}>{copied === `d-${d.code}` ? <Check size={18} /> : <Copy size={18} />}</button>
                {canWriteNfc() && <button className="btn btn-sm" onClick={() => void nfc(url)}><Nfc size={14} aria-hidden />Escribir</button>}
              </div>
            );
          })}
        </details>
      </div>
    </Modal>
  );
}
