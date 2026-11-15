import { useState, type FormEvent } from 'react';
import { useSession } from '@/app/session';
import { errorMessage } from '@/lib/api';
import { Button, ErrorBox, Field, inputCls, Notice, SampleBanner } from '@/components/ui';

export function LoginPage() {
  const { session, login } = useSession();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      {session?.mode === 'demo' && <SampleBanner />}
      <div className="flex min-h-[80vh] items-center justify-center px-4">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-surface p-6">
          <div className="flex items-center gap-3">
            <img src="/icon.webp" alt="" className="size-10 rounded-lg" />
            <div>
              <h1 className="text-lg font-semibold">AI Automation HQ</h1>
              <p className="text-xs text-ink-mute">관리자 로그인</p>
            </div>
          </div>
          {session && !session.passwordConfigured && (
            <Notice tone="warn">
              관리자 비밀번호가 아직 설정되지 않았습니다. <code>npm run secret:password</code> 로 해시를 만든 뒤 <code>ADMIN_PASSWORD_HASH</code> secret에 등록하세요.
            </Notice>
          )}
          {session?.mode === 'demo' && <Notice tone="brand">로컬 데모 모드 비밀번호: demo</Notice>}
          <Field label="비밀번호">
            {(id) => (
              <input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} />
            )}
          </Field>
          {error && <ErrorBox message={error} />}
          <Button type="submit" variant="primary" loading={busy} className="w-full">
            로그인
          </Button>
        </form>
      </div>
    </div>
  );
}
