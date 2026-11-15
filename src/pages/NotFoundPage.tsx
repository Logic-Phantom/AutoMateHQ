import { Link } from 'react-router';
import { EmptyState } from '@/components/ui';

export function NotFoundPage() {
  return (
    <EmptyState title="페이지를 찾을 수 없습니다.">
      <Link to="/" className="text-brand-ink hover:underline">대시보드로 이동</Link>
    </EmptyState>
  );
}
