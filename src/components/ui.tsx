import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, Loader2, XCircle } from 'lucide-react';

export function cx(...v: (string | false | null | undefined)[]) {
  return v.filter(Boolean).join(' ');
}

// ---------------- Button ----------------
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
export function Button({
  variant = 'secondary',
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-brand text-white hover:bg-brand-ink border-transparent',
    secondary: 'bg-surface text-ink border-line-strong hover:bg-sunken',
    danger: 'bg-surface text-fail-ink border-fail/40 hover:bg-fail-soft',
    ghost: 'bg-transparent text-ink-soft border-transparent hover:bg-sunken hover:text-ink',
  };
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-label font-medium transition-colors active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

// ---------------- Status ----------------
export type Status = 'NORMAL' | 'FAILED' | 'ATTENTION' | 'UNKNOWN';
export const STATUS_META: Record<Status, { label: string; cls: string; Icon: typeof CheckCircle2; dot: string }> = {
  NORMAL: { label: '정상', cls: 'text-ok-ink', Icon: CheckCircle2, dot: 'bg-ok' },
  FAILED: { label: '실패', cls: 'text-fail-ink', Icon: XCircle, dot: 'bg-fail' },
  ATTENTION: { label: '확인 필요', cls: 'text-warn-ink', Icon: AlertTriangle, dot: 'bg-warn' },
  UNKNOWN: { label: '확인 불가', cls: 'text-neutral-ink', Icon: CircleHelp, dot: 'bg-neutral' },
};
export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[(status as Status) in STATUS_META ? (status as Status) : 'UNKNOWN'];
  return (
    <span className={cx('inline-flex items-center gap-1 text-label font-medium whitespace-nowrap', meta.cls)}>
      <meta.Icon className="size-3.5" aria-hidden />
      {meta.label}
    </span>
  );
}

const TONES = {
  ok: 'bg-ok-soft text-ok-ink',
  fail: 'bg-fail-soft text-fail-ink',
  warn: 'bg-warn-soft text-warn-ink',
  neutral: 'bg-neutral-soft text-neutral-ink',
  brand: 'bg-brand-soft text-brand-ink',
} as const;
export type Tone = keyof typeof TONES;
export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone])}>
      {children}
    </span>
  );
}

export function runTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'success':
      return 'ok';
    case 'failure':
      return 'fail';
    case 'running':
    case 'queued':
      return 'brand';
    default:
      return 'neutral';
  }
}

export function integrationTone(status: string | undefined): Tone {
  return status === 'connected' ? 'ok' : status === 'error' || status === 'reauth_required' ? 'fail' : 'neutral';
}

// ---------------- Layout pieces ----------------
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-title font-semibold text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('min-w-0 rounded-lg border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-2">
          <h2 className="text-label font-semibold whitespace-nowrap text-ink">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line px-4 py-8 text-center">
      <p className="text-sm font-medium text-ink-soft">{title}</p>
      {children && <div className="mt-2 text-sm text-ink-mute">{children}</div>}
    </div>
  );
}

/** 내용 자리에 스피너 대신 회색 줄(skeleton)을 둔다. 화면이 로드 후 덜 출렁이고, 무엇이 올지 미리 보인다. */
export function Loading({ label = '불러오는 중…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-2.5 py-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="h-3.5 animate-pulse rounded-sm bg-sunken" style={{ width: `${[92, 76, 84, 64][i % 4]}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-fail/30 bg-fail-soft px-4 py-3 text-sm text-fail-ink">
      <span>{message}</span>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          다시 시도
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const border = { ok: 'border-ok/30', fail: 'border-fail/30', warn: 'border-warn/40', neutral: 'border-line', brand: 'border-brand/30' }[tone];
  return <div className={cx('rounded-md border px-3 py-2 text-sm', TONES[tone], border)}>{children}</div>;
}

// ---------------- Table ----------------
export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-sunken/60 text-xs text-ink-mute">
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cx('px-3 py-2.5 align-top', className)}>{children}</td>
);

// ---------------- Modal (native dialog: 포커스 트랩·Esc 지원) ----------------
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(92vw,560px)] rounded-lg border border-line bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim"
    >
      <div className="border-b border-line px-5 py-3">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
      </div>
      <div className="max-h-[70vh] overflow-y-auto px-5 py-4 text-sm">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
    </dialog>
  );
}

// ---------------- Form fields ----------------
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-ink-soft">
        {label}
      </label>
      {children(id)}
      {hint && !error && <p className="text-xs text-ink-mute">{hint}</p>}
      {error && <p className="text-xs text-fail-ink">{error}</p>}
    </div>
  );
}

export const inputCls =
  'w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm placeholder:text-ink-mute focus:border-brand disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-mute aria-[invalid=true]:border-fail';

export function SampleBanner() {
  return (
    <div className="bg-warn-soft px-4 py-1.5 text-center text-xs font-medium text-warn-ink" role="note">
      샘플 데이터 — 데모 모드입니다. 실제 계정·운영 데이터가 아니며 외부 API를 호출하지 않습니다.
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href) return <span className="text-ink-mute">-</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-ink underline-offset-2 hover:underline">
      {children}
    </a>
  );
}
