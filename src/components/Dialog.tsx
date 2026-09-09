import { useEffect, useId, useRef, type ReactNode } from 'react';
export function Dialog({
  title,
  children,
  onClose,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose?.();
      }}
    >
      {onClose && (
        <button className="close-button dialog-close" aria-label="Bezárás" onClick={onClose}>
          ×
        </button>
      )}
      <h2 id={id}>{title}</h2>
      {children}
    </dialog>
  );
}
