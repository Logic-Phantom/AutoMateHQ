import { useState } from 'react';
import {
  CADENCE_LABEL,
  CADENCES,
  CATEGORIES,
  CATEGORY_LABEL,
  MAINTENANCE_MODE_LABEL,
  MAINTENANCE_MODES,
  MONITORING_MODE_LABEL,
  MONITORING_MODES,
  PRIORITIES,
  PRIORITY_LABEL,
} from '@shared/constants';
import type { ProjectInput } from '@shared/schemas';
import { ApiError, errorMessage } from '@/lib/api';
import { Button, ErrorBox, Field, inputCls, Notice } from '@/components/ui';

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

export const EMPTY_PROJECT: ProjectInput = {
  projectKey: '',
  name: '',
  description: '',
  category: 'other',
  repoOwner: null,
  repoName: null,
  defaultBranch: 'main',
  docsUrl: null,
  monitoringMode: 'github_actions',
  expectedCadence: 'daily',
  expectedDays: [],
  intervalHours: null,
  expectedTimeLocal: '07:00',
  timezone: 'Asia/Seoul',
  gracePeriodMinutes: 60,
  priority: 'normal',
  maintenanceMode: 'AUDIT',
  maintenanceEnabled: false,
  isActive: true,
  workflowFile: null,
  workflowEvent: 'any',
};

export function ProjectForm({
  initial,
  isEdit,
  onSubmit,
  onCancel,
}: {
  initial: ProjectInput;
  isEdit?: boolean;
  onSubmit: (v: ProjectInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [v, setV] = useState<ProjectInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ProjectInput>(k: K, value: ProjectInput[K]) => setV((s) => ({ ...s, [k]: value }));
  const usesGithub = v.monitoringMode === 'github_actions' || v.monitoringMode === 'github_webhook';

  const submit = async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await onSubmit(v);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setFieldErrors(Object.fromEntries((err.details as { path: string; message: string }[]).map((d) => [d.path, d.message])));
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="프로젝트 키 (영문 소문자·숫자·하이픈)" error={fieldErrors.projectKey} hint="Heartbeat 요청에 쓰입니다. 생성 후 변경 불가">
          {(id) => <input id={id} required disabled={isEdit} value={v.projectKey} onChange={(e) => set('projectKey', e.target.value)} className={inputCls} placeholder="instagram-card-publisher" />}
        </Field>
        <Field label="이름" error={fieldErrors.name}>
          {(id) => <input id={id} required value={v.name} onChange={(e) => set('name', e.target.value)} className={inputCls} />}
        </Field>
      </div>
      <Field label="설명">
        {(id) => <input id={id} value={v.description} onChange={(e) => set('description', e.target.value)} className={inputCls} />}
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="분류">
          {(id) => (
            <select id={id} value={v.category} onChange={(e) => set('category', e.target.value as ProjectInput['category'])} className={inputCls}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
          )}
        </Field>
        <Field label="모니터링 방식">
          {(id) => (
            <select id={id} value={v.monitoringMode} onChange={(e) => set('monitoringMode', e.target.value as ProjectInput['monitoringMode'])} className={inputCls}>
              {MONITORING_MODES.map((m) => <option key={m} value={m}>{MONITORING_MODE_LABEL[m]}</option>)}
            </select>
          )}
        </Field>
        <Field label="중요도">
          {(id) => (
            <select id={id} value={v.priority} onChange={(e) => set('priority', e.target.value as ProjectInput['priority'])} className={inputCls}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          )}
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-md border border-line p-3">
        <legend className="px-1 text-xs font-medium text-ink-soft">GitHub 저장소 {usesGithub ? '(필수)' : '(선택)'}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="owner" error={fieldErrors.repoOwner}>
            {(id) => <input id={id} value={v.repoOwner ?? ''} onChange={(e) => set('repoOwner', e.target.value || null)} className={inputCls} placeholder="Logic-Phantom" />}
          </Field>
          <Field label="repository" error={fieldErrors.repoName}>
            {(id) => <input id={id} value={v.repoName ?? ''} onChange={(e) => set('repoName', e.target.value || null)} className={inputCls} />}
          </Field>
          <Field label="기본 브랜치">
            {(id) => <input id={id} value={v.defaultBranch} onChange={(e) => set('defaultBranch', e.target.value)} className={inputCls} />}
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="감시할 워크플로 파일" hint="비우면 저장소의 모든 워크플로">
            {(id) => <input id={id} value={v.workflowFile ?? ''} onChange={(e) => set('workflowFile', e.target.value || null)} className={inputCls} placeholder="daily.yml" />}
          </Field>
          <Field label="문서 URL (https)" error={fieldErrors.docsUrl}>
            {(id) => <input id={id} value={v.docsUrl ?? ''} onChange={(e) => set('docsUrl', e.target.value || null)} className={inputCls} />}
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-line p-3">
        <legend className="px-1 text-xs font-medium text-ink-soft">기대 실행 일정 (미실행 탐지 기준)</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="주기">
            {(id) => (
              <select id={id} value={v.expectedCadence} onChange={(e) => set('expectedCadence', e.target.value as ProjectInput['expectedCadence'])} className={inputCls}>
                {CADENCES.map((c) => <option key={c} value={c}>{CADENCE_LABEL[c]}</option>)}
              </select>
            )}
          </Field>
          {['daily', 'weekdays', 'weekly'].includes(v.expectedCadence) && (
            <Field label="기대 실행 시각(현지)" error={fieldErrors.expectedTimeLocal}>
              {(id) => <input id={id} type="time" value={v.expectedTimeLocal ?? ''} onChange={(e) => set('expectedTimeLocal', e.target.value || null)} className={inputCls} />}
            </Field>
          )}
          {v.expectedCadence === 'interval' && (
            <Field label="간격(시간)" error={fieldErrors.intervalHours}>
              {(id) => <input id={id} type="number" min={1} max={168} value={v.intervalHours ?? ''} onChange={(e) => set('intervalHours', e.target.value ? Number(e.target.value) : null)} className={inputCls} />}
            </Field>
          )}
          <Field label="유예 시간(분)" hint="예정 시각 + 유예 시간이 지나도 실행이 없으면 '확인 필요'">
            {(id) => <input id={id} type="number" min={5} max={1440} value={v.gracePeriodMinutes} onChange={(e) => set('gracePeriodMinutes', Number(e.target.value))} className={inputCls} />}
          </Field>
        </div>
        {v.expectedCadence === 'weekly' && (
          <div role="group" aria-label="실행 요일" className="flex flex-wrap gap-2">
            {WEEKDAYS.map((label, i) => {
              const day = i + 1;
              const on = v.expectedDays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set('expectedDays', on ? v.expectedDays.filter((d) => d !== day) : [...v.expectedDays, day].sort())}
                  className={`rounded-md border px-2.5 py-1 text-sm ${on ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line'}`}
                >
                  {label}
                </button>
              );
            })}
            {fieldErrors.expectedDays && <p className="text-xs text-fail-ink">{fieldErrors.expectedDays}</p>}
          </div>
        )}
        <p className="text-xs text-ink-mute">시간대: {v.timezone}. 실행 예정일이 아닌 날은 미실행으로 판정하지 않습니다.</p>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-line p-3">
        <legend className="px-1 text-xs font-medium text-ink-soft">AI 유지보수 정책</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.maintenanceEnabled} onChange={(e) => set('maintenanceEnabled', e.target.checked)} />
          자동 유지보수 허용 (끄면 읽기 전용 점검만 가능)
        </label>
        <Field label="허용 최대 모드">
          {(id) => (
            <select id={id} value={v.maintenanceMode} onChange={(e) => set('maintenanceMode', e.target.value as ProjectInput['maintenanceMode'])} className={inputCls} disabled={!v.maintenanceEnabled}>
              {MAINTENANCE_MODES.map((m) => <option key={m} value={m}>{m} — {MAINTENANCE_MODE_LABEL[m]}</option>)}
            </select>
          )}
        </Field>
        {v.maintenanceEnabled && v.maintenanceMode === 'DRAFT_PR' && (
          <Notice tone="warn">Draft PR 모드에서도 기본 브랜치 push·자동 merge·인증/결제/게시 로직·workflow 권한 변경은 하지 않습니다.</Notice>
        )}
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={v.isActive} onChange={(e) => set('isActive', e.target.checked)} />
        활성화 (비활성 프로젝트는 집계·알림에서 제외)
      </label>

      {error && <ErrorBox message={error} />}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>취소</Button>
        <Button type="submit" variant="primary" loading={busy}>
          {isEdit ? '저장' : '등록'}
        </Button>
      </div>
    </form>
  );
}
