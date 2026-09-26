import { X } from 'lucide-react';
import './WorldNotice.css';

/** A World ID outcome from our side (after IDKit closed), in IDKit's own error style. */
export function WorldNotice({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return (
    <div className="world-notice-backdrop" role="presentation" onClick={onClose}>
      <section className="world-notice" role="alertdialog" aria-modal="true" aria-labelledby="world-notice-title" onClick={e => e.stopPropagation()}>
        <button type="button" className="world-notice-close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
        <div className="world-notice-icon" aria-hidden="true">
          <svg viewBox="0 0 88 88" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="88" height="88" rx="44" fill="#FFAE00" />
            <path d="M64.1707 59.5415H22.8298L43.4998 22.3354L64.1707 59.5415ZM42.1208 51.3003L42.1218 54.0503H44.8992L44.8982 51.3003H42.1208ZM42.1248 46.7085H44.8748V36.6255H42.1248V46.7085Z" fill="white" />
          </svg>
        </div>
        <p id="world-notice-title" className="world-notice-title">{title}</p>
        <p className="world-notice-message">{message}</p>
        <button type="button" className="world-notice-btn" onClick={onClose}>Close</button>
      </section>
    </div>
  );
}
