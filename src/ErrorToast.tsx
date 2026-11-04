import { X } from "lucide-react";
import { useEffect, useState } from "react";

export default function ErrorToast({ message, dismiss }: { message?: string; dismiss: string }) {
  return message ? <Toast key={message} message={message} dismiss={dismiss} /> : null;
}

function Toast({ message, dismiss }: { message: string; dismiss: string }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), 6500);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;
  return <div className="error-toast">
    <span role="alert">{message}</span>
    <button type="button" className="icon-button" aria-label={dismiss} data-tip={dismiss}
      onClick={() => setVisible(false)}>
      <X aria-hidden="true" />
    </button>
  </div>;
}
