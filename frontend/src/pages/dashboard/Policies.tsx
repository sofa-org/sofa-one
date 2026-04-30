import { useEffect, useState } from 'react';
import { useOpenfort } from '@openfort/react';
import { Plus, X, AlertCircle, Loader2 } from 'lucide-react';
import {
  listPoliciesAuth,
  createPolicyAuth,
  deletePolicyAuth,
  enablePolicyAuth,
  disablePolicyAuth,
  listPolicyRulesAuth,
  createPolicyRuleAuth,
  deletePolicyRuleAuth,
  getApiErrorMessage,
  type CriterionInput,
  type CriterionType,
  type Policy,
  type PolicyRule,
  type PolicyRuleAction,
  type PolicyRuleInput,
  type PolicyRuleOperation,
} from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CriterionDraft {
  type: CriterionType;
  // ethValue
  ethValueOperator?: '<=' | '>=' | '<' | '>';
  ethValue?: string;
  // evmAddress / evmTypedDataVerifyingContract
  addressOperator?: 'in' | 'not in';
  addresses?: string; // newline-separated
  // evmNetwork
  networkOperator?: 'in' | 'not in';
  chainIds?: string; // comma-separated
  // evmData
  dataOperator?: '==' | 'in' | 'not in' | '<' | '<=' | '>' | '>=' | 'match';
  abi?: string;
  functionName?: string;
  argsJson?: string;
  // evmMessage
  messagePattern?: string;
  // evmTypedDataField
  fieldOperator?: 'in' | '<=' | 'match';
  fieldPath?: string;
  fieldValues?: string; // newline-separated for 'in', single value otherwise
}

// ─── Constants ────────────────────────────────────────────────────────────────

type PolicyScope = 'account';

const POLICY_RULE_OPERATIONS: PolicyRuleOperation[] = [
  'signEvmTransaction',
  'sendEvmTransaction',
  'signEvmMessage',
  'signEvmTypedData',
  'signEvmHash',
  'sponsorEvmTransaction',
];

const OPERATION_CRITERIA: Record<PolicyRuleOperation, CriterionType[]> = {
  signEvmTransaction: ['ethValue', 'evmAddress', 'evmData'],
  sendEvmTransaction: ['ethValue', 'evmAddress', 'evmNetwork', 'evmData'],
  signEvmMessage: ['evmMessage'],
  signEvmTypedData: ['evmTypedDataVerifyingContract', 'evmTypedDataField'],
  signEvmHash: [],
  sponsorEvmTransaction: ['ethValue', 'evmAddress', 'evmNetwork', 'evmData'],
};

const DEFAULT_CRITERION: CriterionDraft = {
  type: 'ethValue',
  ethValueOperator: '<=',
  ethValue: '',
  addressOperator: 'in',
  addresses: '',
  networkOperator: 'in',
  chainIds: '',
  dataOperator: '==',
  abi: '',
  functionName: '',
  argsJson: '',
  messagePattern: '',
  fieldOperator: 'in',
  fieldPath: '',
  fieldValues: '',
};

// ─── Rule form state ───────────────────────────────────────────────────────────

interface RuleFormState {
  action: PolicyRuleAction;
  operation: PolicyRuleOperation;
  criteria: CriterionDraft[];
}

const DEFAULT_RULE_FORM: RuleFormState = {
  action: 'accept',
  operation: 'signEvmTransaction',
  criteria: [],
};

// ─── Criterion → API object ────────────────────────────────────────────────────

function criterionDraftToApi(c: CriterionDraft): CriterionInput | null {
  switch (c.type) {
    case 'ethValue':
      if (!c.ethValue?.trim()) return null;
      return { type: 'ethValue', operator: c.ethValueOperator ?? '<=', ethValue: c.ethValue.trim() };
    case 'evmAddress': {
      const addrs = (c.addresses ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!addrs.length) return null;
      return { type: 'evmAddress', operator: c.addressOperator ?? 'in', addresses: addrs };
    }
    case 'evmNetwork': {
      const ids = (c.chainIds ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      if (!ids.length) return null;
      return { type: 'evmNetwork', operator: c.networkOperator ?? 'in', chainIds: ids };
    }
    case 'evmData': {
      if (!c.abi?.trim() || !c.functionName?.trim()) return null;
      const obj: CriterionInput = {
        type: 'evmData',
        operator: c.dataOperator ?? '==',
        abi: c.abi.trim(),
        functionName: c.functionName.trim(),
      };
      if (c.argsJson?.trim()) {
        try { obj.args = JSON.parse(c.argsJson.trim()); } catch { return null; }
      }
      return obj;
    }
    case 'evmMessage':
      if (!c.messagePattern?.trim()) return null;
      return { type: 'evmMessage', operator: 'match', pattern: c.messagePattern.trim() };
    case 'evmTypedDataVerifyingContract': {
      const addrs = (c.addresses ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!addrs.length) return null;
      return { type: 'evmTypedDataVerifyingContract', operator: c.addressOperator ?? 'in', addresses: addrs };
    }
    case 'evmTypedDataField': {
      if (!c.fieldPath?.trim()) return null;
      const op = c.fieldOperator ?? 'in';
      const base: CriterionInput = { type: 'evmTypedDataField', operator: op, fieldPath: c.fieldPath.trim() };
      if (op === 'in') {
        base.values = (c.fieldValues ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
      } else {
        base.value = c.fieldValues?.trim() ?? '';
      }
      return base;
    }
    default:
      return null;
  }
}

function criterionSummary(c: CriterionDraft): string {
  switch (c.type) {
    case 'ethValue': {
      const wei = c.ethValue?.trim() ?? '';
      const eth = wei ? (Number(BigInt(wei)) / 1e18).toFixed(4).replace(/\.?0+$/, '') : '?';
      return `ethValue ${c.ethValueOperator ?? '<='} ${eth} ETH`;
    }
    case 'evmAddress': {
      const addrs = (c.addresses ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
      return `address ${c.addressOperator ?? 'in'} [${addrs.map((a) => a.slice(0, 6) + '…').join(', ')}]`;
    }
    case 'evmNetwork': {
      const ids = (c.chainIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      return `network ${c.networkOperator ?? 'in'} [${ids.join(', ')}]`;
    }
    case 'evmData':
      return `data ${c.dataOperator ?? '=='} ${c.functionName?.trim() ?? '?'}()`;
    case 'evmMessage':
      return `message match "${c.messagePattern?.trim() ?? ''}"`;
    case 'evmTypedDataVerifyingContract': {
      const addrs = (c.addresses ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
      return `verifyingContract ${c.addressOperator ?? 'in'} [${addrs.map((a) => a.slice(0, 6) + '…').join(', ')}]`;
    }
    case 'evmTypedDataField':
      return `field ${c.fieldPath?.trim() ?? '?'} ${c.fieldOperator ?? 'in'} ${c.fieldValues?.trim() ? '"' + c.fieldValues.trim().slice(0, 20) + '"' : '[]'}`;
    default:
      return c.type;
  }
}

// ─── Criterion form fields ─────────────────────────────────────────────────────

function CriterionFields({
  draft,
  onChange,
  inputCls,
  selectCls,
  textareaCls,
}: {
  draft: CriterionDraft;
  onChange: (patch: Partial<CriterionDraft>) => void;
  inputCls: string;
  selectCls: string;
  textareaCls: string;
}) {
  switch (draft.type) {
    case 'ethValue':
      return (
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="w-full sm:w-32 shrink-0">
            <label className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Operator</label>
            <select
              value={draft.ethValueOperator ?? '<='}
              onChange={(e) => onChange({ ethValueOperator: e.target.value as CriterionDraft['ethValueOperator'] })}
              className={`${selectCls} w-full`}
            >
              {(['<=', '>=', '<', '>'] as const).map((op) => <option key={op} value={op}>{op}</option>)}
            </select>
          </div>
          <div className="flex-1">
            <label className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Wei Amount</label>
            <input
              type="text"
              placeholder="e.g. 1000000000000000000 (1 ETH)"
              value={draft.ethValue ?? ''}
              onChange={(e) => onChange({ ethValue: e.target.value })}
              className={`${inputCls} w-full`}
            />
          </div>
        </div>
      );

    case 'evmAddress':
    case 'evmTypedDataVerifyingContract':
      return (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">List Type</label>
            <select
              value={draft.addressOperator ?? 'in'}
              onChange={(e) => onChange({ addressOperator: e.target.value as 'in' | 'not in' })}
              className={`${selectCls} w-full sm:w-48`}
            >
              <option value="in">Allowlist (in)</option>
              <option value="not in">Denylist (not in)</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Addresses (One per line)</label>
            <textarea
              rows={3}
              placeholder="0x1234...&#10;0xabcd..."
              value={draft.addresses ?? ''}
              onChange={(e) => onChange({ addresses: e.target.value })}
              className={textareaCls}
            />
          </div>
        </div>
      );

    case 'evmNetwork':
      return (
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="sm:w-48 shrink-0">
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">List Type</label>
            <select
              value={draft.networkOperator ?? 'in'}
              onChange={(e) => onChange({ networkOperator: e.target.value as 'in' | 'not in' })}
              className={`${selectCls} w-full`}
            >
              <option value="in">Allowlist (in)</option>
              <option value="not in">Denylist (not in)</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Chain IDs</label>
            <input
              type="text"
              placeholder="Comma-separated, e.g. 1, 137, 8453"
              value={draft.chainIds ?? ''}
              onChange={(e) => onChange({ chainIds: e.target.value })}
              className={`${inputCls} w-full`}
            />
          </div>
        </div>
      );

    case 'evmData':
      return (
        <div className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="sm:w-48 shrink-0">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Operator</label>
              <select
                value={draft.dataOperator ?? '=='}
                onChange={(e) => onChange({ dataOperator: e.target.value as CriterionDraft['dataOperator'] })}
                className={`${selectCls} w-full`}
              >
                {(['==', 'in', 'not in', '<', '<=', '>', '>=', 'match'] as const).map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Function Name</label>
              <input
                type="text"
                placeholder="e.g. transfer"
                value={draft.functionName ?? ''}
                onChange={(e) => onChange({ functionName: e.target.value })}
                className={`${inputCls} w-full`}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Contract ABI (JSON Array)</label>
            <textarea
              rows={3}
              placeholder='[{"type":"function","name":"transfer",...}]'
              value={draft.abi ?? ''}
              onChange={(e) => onChange({ abi: e.target.value })}
              className={textareaCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Args Constraints (Optional JSON)</label>
            <textarea
              rows={2}
              placeholder='{"amount": "1000000"}'
              value={draft.argsJson ?? ''}
              onChange={(e) => onChange({ argsJson: e.target.value })}
              className={textareaCls}
            />
          </div>
        </div>
      );

    case 'evmMessage':
      return (
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">RE2 Regex Pattern</label>
          <input
            type="text"
            placeholder="e.g. ^Sign in to MyApp:"
            value={draft.messagePattern ?? ''}
            onChange={(e) => onChange({ messagePattern: e.target.value })}
            className={`${inputCls} w-full`}
          />
        </div>
      );

    case 'evmTypedDataField':
      return (
        <div className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="sm:w-48 shrink-0">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Operator</label>
              <select
                value={draft.fieldOperator ?? 'in'}
                onChange={(e) => onChange({ fieldOperator: e.target.value as 'in' | '<=' | 'match' })}
                className={`${selectCls} w-full`}
              >
                <option value="in">Allowlist (in)</option>
                <option value="<=">Max value {'(<='})</option>
                <option value="match">Regex Match (match)</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Field Path</label>
              <input
                type="text"
                placeholder="e.g. order.buyer"
                value={draft.fieldPath ?? ''}
                onChange={(e) => onChange({ fieldPath: e.target.value })}
                className={`${inputCls} w-full`}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">
              {draft.fieldOperator === 'in' ? 'Values (One per line)' : 'Value Constraint'}
            </label>
            <textarea
              rows={3}
              placeholder={
                draft.fieldOperator === 'in'
                  ? 'value1\nvalue2'
                  : draft.fieldOperator === 'match'
                  ? '^expected string$'
                  : '1000000'
              }
              value={draft.fieldValues ?? ''}
              onChange={(e) => onChange({ fieldValues: e.target.value })}
              className={textareaCls}
            />
          </div>
        </div>
      );

    default:
      return null;
  }
}

// ─── Criteria builder ──────────────────────────────────────────────────────────

function CriteriaBuilder({
  criteria,
  onChange,
  operation,
}: {
  criteria: CriterionDraft[];
  onChange: (criteria: CriterionDraft[]) => void;
  operation: PolicyRuleOperation;
}) {
  const availableCriterionTypes = OPERATION_CRITERIA[operation];
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<CriterionDraft>({
    ...DEFAULT_CRITERION,
    type: availableCriterionTypes[0] ?? 'ethValue',
  });

  // Reset draft when operation changes
  useEffect(() => {
    setShowForm(false);
    setDraft({ ...DEFAULT_CRITERION, type: availableCriterionTypes[0] ?? 'ethValue' });
  }, [operation]);

  const inputCls =
    'rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder-brand-muted/50 bg-white shadow-sm';
  const selectCls =
    'rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white shadow-sm';
  const textareaCls =
    'w-full rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder-brand-muted/50 bg-white shadow-sm font-mono';

  function handleAdd() {
    const api = criterionDraftToApi(draft);
    if (!api) return; // incomplete
    onChange([...criteria, draft]);
    setDraft({ ...DEFAULT_CRITERION });
    setShowForm(false);
  }

  function handleRemove(idx: number) {
    onChange(criteria.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold font-serif text-brand-text">Criteria</h4>
          <p className="text-[11px] text-brand-muted mt-0.5">Define conditions for this rule to trigger</p>
        </div>
        {!showForm && availableCriterionTypes.length > 0 && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="rounded-full border border-dashed border-brand-border bg-brand-surface px-3 py-1.5 text-xs font-medium text-brand-text hover:border-brand-accent hover:text-brand-accent transition-colors shadow-sm"
          >
            + Add Criterion
          </button>
        )}
      </div>

      {availableCriterionTypes.length === 0 ? (
        <p className="text-[11px] text-brand-muted italic">This operation has no configurable criteria — the rule will accept or reject all matching requests.</p>
      ) : (
        <>
        {/* Existing criteria chips */}
        {criteria.length > 0 && (
        <div className="flex flex-wrap gap-2 p-4 bg-brand-surface border border-brand-border rounded-xl">
          {criteria.map((c, idx) => (
            <span
              key={idx}
              className="group flex items-center gap-2 rounded-full border border-brand-accent/20 bg-brand-accent/5 pl-3 pr-1 py-1 text-[11px] text-brand-text font-mono shadow-sm transition-colors hover:border-brand-accent/40 hover:bg-brand-accent/10"
            >
              <span className="opacity-90">{criterionSummary(c)}</span>
              <button
                type="button"
                onClick={() => handleRemove(idx)}
                className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-brand-muted hover:bg-red-100 hover:text-red-600 transition-colors"
                title="Remove criterion"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Add criterion form */}
      {showForm && (
        <div className="rounded-xl border border-brand-border bg-brand-surface/50 p-5 space-y-5 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1.5 h-full bg-brand-accent/40" />
          
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold font-serif text-brand-text">New Criterion Definition</span>
            <button
              type="button"
              onClick={() => { setShowForm(false); setDraft({ ...DEFAULT_CRITERION }); }}
              className="flex h-7 w-7 items-center justify-center rounded-full text-brand-muted hover:bg-brand-border hover:text-brand-text transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-5">
            <div>
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-brand-muted">Criterion Type</label>
              <select
                value={draft.type}
                onChange={(e) => setDraft({ ...DEFAULT_CRITERION, type: e.target.value as CriterionType })}
                className={`${selectCls} w-full sm:w-64`}
              >
                {availableCriterionTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            <div className="border-t border-brand-border pt-5">
              <CriterionFields
                draft={draft}
                onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
                inputCls={inputCls}
                selectCls={selectCls}
                textareaCls={textareaCls}
              />
            </div>
          </div>

          <div className="flex justify-end pt-3">
            <button
              type="button"
              onClick={handleAdd}
              className="rounded-full bg-brand-text px-6 py-2 text-xs font-semibold text-white shadow-md hover:bg-brand-text/90 hover:shadow-lg transition-all"
            >
              Confirm Criterion
            </button>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}

// ─── Rule display helper ───────────────────────────────────────────────────────

function RuleDetails({ rule }: { rule: PolicyRule }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-4 w-full">
      <div className="flex items-center gap-3 shrink-0 sm:w-64">
        <span
          className={`inline-flex items-center justify-center rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${
            rule.action === 'accept'
              ? 'bg-green-100 text-green-700 border border-green-200/60 shadow-sm'
              : 'bg-red-100 text-red-700 border border-red-200/60 shadow-sm'
          }`}
        >
          {rule.action}
        </span>
        <span className="font-mono text-sm font-medium text-brand-text">{rule.operation}</span>
      </div>
      
      {rule.criteria && rule.criteria.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 sm:border-l sm:border-brand-border sm:pl-4">
          {rule.criteria.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 rounded-lg border border-brand-border bg-brand-surface px-2.5 py-1.5 text-[10px] text-brand-muted font-mono shadow-sm">
              <span className="font-bold text-brand-text">{String(c.type)}</span>
              {('operator' in c && c.operator) ? <span className="opacity-80">{String((c as Record<string, unknown>).operator)}</span> : null}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-[11px] font-medium text-brand-muted italic sm:border-l sm:border-brand-border sm:pl-4">No conditions (applies to all)</span>
      )}
    </div>
  );
}

// ─── Add rule form ─────────────────────────────────────────────────────────────

interface AddRuleFormProps {
  form: RuleFormState;
  onChange: (patch: Partial<RuleFormState>) => void;
  onSubmit: () => void;
  loading: boolean;
  onCancel?: () => void;
}

function AddRuleForm({ form, onChange, onSubmit, loading, onCancel }: AddRuleFormProps) {
  const selectCls =
    'rounded-lg border border-brand-border px-3 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white shadow-sm';

  return (
    <div className="rounded-2xl border border-brand-border bg-brand-bg p-6 space-y-6 shadow-sm relative overflow-hidden">
      <div className="absolute top-0 left-0 w-1.5 h-full bg-brand-text" />
      
      <div className="flex items-center justify-between border-b border-brand-border pb-4">
        <div>
          <h3 className="text-base font-bold font-serif text-brand-text">Configure Rule</h3>
          <p className="text-[11px] text-brand-muted mt-1 uppercase tracking-wider font-semibold">Define actions and triggers</p>
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-surface text-brand-muted hover:bg-brand-border hover:text-brand-text transition-colors shadow-sm"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        {/* Action selector */}
        <div>
          <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-brand-muted">Action to Take</label>
          <div className="flex rounded-lg bg-brand-surface p-1 border border-brand-border shadow-inner h-[42px]">
            <button
              type="button"
              onClick={() => onChange({ action: 'accept' })}
              className={`flex-1 rounded-md text-sm font-medium transition-all duration-200 ${
                form.action === 'accept' 
                  ? 'bg-green-100 text-green-700 shadow-sm border border-green-200/50' 
                  : 'text-brand-muted hover:text-brand-text hover:bg-white/50'
              }`}
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => onChange({ action: 'reject' })}
              className={`flex-1 rounded-md text-sm font-medium transition-all duration-200 ${
                form.action === 'reject' 
                  ? 'bg-red-100 text-red-700 shadow-sm border border-red-200/50' 
                  : 'text-brand-muted hover:text-brand-text hover:bg-white/50'
              }`}
            >
              Reject
            </button>
          </div>
        </div>

        {/* Operation selector */}
        <div>
          <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-brand-muted">Target Operation</label>
          <select
            value={form.operation}
            onChange={(e) => onChange({ operation: e.target.value as PolicyRuleOperation, criteria: [] })}
            className={`${selectCls} w-full`}
          >
            {POLICY_RULE_OPERATIONS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="border-t border-brand-border pt-4">
        <CriteriaBuilder
          criteria={form.criteria}
          onChange={(criteria) => onChange({ criteria })}
          operation={form.operation}
        />
      </div>

      <div className="flex justify-end gap-3 pt-6 border-t border-brand-border">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full bg-brand-surface border border-brand-border px-5 py-2.5 text-sm font-medium text-brand-text hover:bg-white transition-colors shadow-sm"
          >
            Cancel
          </button>
        )}
        <button
          onClick={onSubmit}
          disabled={loading}
          className="rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-md hover:bg-brand-text/90 hover:shadow-lg transition-all disabled:opacity-50 disabled:shadow-none"
        >
          {loading ? 'Saving...' : 'Save Rule'}
        </button>
      </div>
    </div>
  );
}

// ─── Rule body builder ─────────────────────────────────────────────────────────

function buildRuleBody(
  form: RuleFormState,
  setError: (msg: string) => void,
): PolicyRuleInput | null {
  const body: PolicyRuleInput = {
    action: form.action,
    operation: form.operation,
  };
  if (form.criteria.length > 0) {
    const apiCriteria: CriterionInput[] = [];
    for (const c of form.criteria) {
      const api = criterionDraftToApi(c);
      if (!api) {
        setError(`Invalid or incomplete criterion: ${c.type}`);
        return null;
      }
      apiCriteria.push(api);
    }
    body.criteria = apiCriteria;
  }
  return body;
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function PoliciesPage() {
  const { client, user } = useOpenfort();
  const getToken = () => client.getAccessToken();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create policy form
  const newScope: PolicyScope = 'account';
  const [newDescription, setNewDescription] = useState('');
  const [newEnabled, setNewEnabled] = useState(true);

  // Pending rules for create policy form
  const [pendingRules, setPendingRules] = useState<RuleFormState[]>([]);
  const [newRuleForm, setNewRuleForm] = useState<RuleFormState>(DEFAULT_RULE_FORM);
  const [showNewRuleForm, setShowNewRuleForm] = useState(false);

  // Expanded rules per policy
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rulesMap, setRulesMap] = useState<Record<string, PolicyRule[]>>({});
  const [rulesLoading, setRulesLoading] = useState<string | null>(null);

  // Add-rule form state per policy
  const [ruleFormMap, setRuleFormMap] = useState<Record<string, RuleFormState>>({});

  // ── Fetch helpers ────────────────────────────────────────────────────────────

  async function fetchPolicies() {
    try {
      const policies = await listPoliciesAuth(getToken);
      setPolicies(policies);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user) void fetchPolicies();
  }, [user]);

  async function fetchRules(policyId: string) {
    setRulesLoading(policyId);
    try {
      const rules = await listPolicyRulesAuth(getToken, policyId);
      setRulesMap((prev) => ({ ...prev, [policyId]: rules }));
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setRulesLoading(null);
    }
  }

  // ── Action handlers ──────────────────────────────────────────────────────────

  function handleAddPendingRule() {
    const body = buildRuleBody(newRuleForm, (msg) => setError(msg));
    if (!body) return;
    setPendingRules((prev) => [...prev, newRuleForm]);
    setNewRuleForm(DEFAULT_RULE_FORM);
    setShowNewRuleForm(false);
  }

  function handleRemovePendingRule(index: number) {
    setPendingRules((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleCreate() {
    setActionLoading(true);
    setError(null);
    try {
      // Build all rule bodies first — Openfort requires at least one rule on create
      const builtRules: PolicyRuleInput[] = [];
      for (const form of pendingRules) {
        const body = buildRuleBody(form, (msg) => setError(msg));
        if (!body) {
          setActionLoading(false);
          return;
        }
        builtRules.push(body);
      }

      const created = await createPolicyAuth(getToken, {
        scope: newScope,
        description: newDescription.trim() || undefined,
        enabled: newEnabled,
        rules: builtRules,
      });

      // scope is always 'account', no reset needed
      setNewDescription('');
      setNewEnabled(true);
      setPendingRules([]);
      setNewRuleForm(DEFAULT_RULE_FORM);
      setShowNewRuleForm(false);
      
      // Close the native details element programmatically 
      const detailsEl = document.getElementById('new-policy-details') as HTMLDetailsElement;
      if (detailsEl) detailsEl.open = false;

      await fetchPolicies();
      if (created?.id) {
        await fetchRules(created.id);
        setExpandedId(created.id);
      }
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this policy? This cannot be undone.')) return;
    setActionLoading(true);
    setError(null);
    try {
      await deletePolicyAuth(getToken, id);
      if (expandedId === id) setExpandedId(null);
      await fetchPolicies();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleToggleEnabled(policy: Policy) {
    setActionLoading(true);
    setError(null);
    try {
      if (policy.enabled) {
        await disablePolicyAuth(getToken, policy.id);
      } else {
        await enablePolicyAuth(getToken, policy.id);
      }
      await fetchPolicies();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!rulesMap[id]) {
      await fetchRules(id);
    }
  }

  function getRuleForm(id: string): RuleFormState {
    return ruleFormMap[id] ?? DEFAULT_RULE_FORM;
  }

  function patchRuleForm(id: string, patch: Partial<RuleFormState>) {
    setRuleFormMap((prev) => ({ ...prev, [id]: { ...getRuleForm(id), ...patch } }));
  }

  async function handleAddRule(policyId: string) {
    const form = getRuleForm(policyId);
    const body = buildRuleBody(form, (msg) => setError(msg));
    if (!body) return;
    setActionLoading(true);
    setError(null);
    try {
      await createPolicyRuleAuth(getToken, policyId, body);
      await fetchRules(policyId);
      setRuleFormMap((prev) => ({ ...prev, [policyId]: DEFAULT_RULE_FORM }));
      await fetchPolicies();
      
      // Close the native details element programmatically
      const detailsEl = document.getElementById(`add-rule-details-${policyId}`) as HTMLDetailsElement;
      if (detailsEl) detailsEl.open = false;
      
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDeleteRule(policyId: string, ruleIndex: number) {
    if (!confirm('Delete this rule?')) return;
    setActionLoading(true);
    setError(null);
    try {
      await deletePolicyRuleAuth(getToken, policyId, ruleIndex);
      await fetchRules(policyId);
      await fetchPolicies();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const inputCls =
    'rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder-brand-muted/50 bg-brand-surface shadow-sm transition-shadow';

  return (
    <div className="mx-auto max-w-6xl space-y-10 pb-16">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-5 border-b border-brand-border pb-6">
        <div>
          <h1 className="text-3xl font-bold font-serif text-brand-text">Policies</h1>
          <p className="mt-2 text-sm text-brand-muted">Control authentication, signing, and transaction logic via strict rulesets.</p>
        </div>
        <button
          onClick={() => {
            const el = document.getElementById('new-policy-details') as HTMLDetailsElement;
            if (el) el.open = true;
          }}
          className="rounded-full border border-brand-border bg-white px-5 py-2 text-xs font-semibold text-brand-text shadow-sm transition-all hover:border-brand-accent hover:text-brand-accent flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" /> Create Policy
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
          <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
          <p>{error}</p>
        </div>
      )}

      {/* ── Create policy form ─────────────────────────────────────────────── */}
      <details id="new-policy-details" className="group [&_summary::-webkit-details-marker]:hidden">
        <summary className="list-none cursor-default hidden" />
        <div className="rounded-2xl border border-brand-border bg-white p-7 shadow-xl relative overflow-hidden ring-1 ring-black/5 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="absolute top-0 left-0 w-full h-1.5 bg-brand-text" />
          
          <div className="flex items-center justify-between mb-8 pt-2">
            <div>
              <h2 className="text-xl font-bold font-serif text-brand-text">Create Policy</h2>
              <p className="text-xs font-semibold uppercase tracking-wider text-brand-muted mt-1">Configure high-level settings and attach rules to govern operations.</p>
            </div>
            <button
              onClick={() => {
                const el = document.getElementById('new-policy-details') as HTMLDetailsElement;
                if (el) el.open = false;
              }}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-surface text-brand-muted hover:bg-brand-border hover:text-brand-text transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-4 items-start">
            <div className="sm:col-span-3">
              <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">Description</label>
              <input
                type="text"
                placeholder="e.g. Reject all large transactions above 10 ETH"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className={`${inputCls} w-full`}
              />
            </div>
            <div>
              <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">Initial Status</label>
              <label className="flex h-[44px] items-center gap-3 px-4 py-2 text-sm font-medium text-brand-text border border-brand-border rounded-lg bg-brand-surface cursor-pointer hover:bg-brand-bg transition-colors shadow-sm">
                <input
                  type="checkbox"
                  checked={newEnabled}
                  onChange={(e) => setNewEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-brand-border text-brand-accent focus:ring-brand-accent transition-colors"
                />
                Enabled Active
              </label>
            </div>
          </div>

          <div className="mt-10 border-t border-brand-border pt-8">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-lg font-bold font-serif text-brand-text">Policy Rules</h3>
                <p className="text-xs text-brand-muted mt-1">Rules are evaluated sequentially. The first matching rule applies.</p>
              </div>
              {!showNewRuleForm && (
                <button
                  onClick={() => setShowNewRuleForm(true)}
                  className="rounded-full border border-brand-border bg-white px-5 py-2 text-xs font-semibold text-brand-text hover:border-brand-accent hover:text-brand-accent hover:shadow-sm transition-all"
                >
                  + Add Rule
                </button>
              )}
            </div>

            {pendingRules.length > 0 && (
              <div className="mb-6 rounded-2xl border border-brand-border bg-brand-surface divide-y divide-brand-border shadow-sm overflow-hidden">
                {pendingRules.map((rule, idx) => (
                  <div key={idx} className="flex flex-col sm:flex-row sm:items-center justify-between p-5 gap-5 hover:bg-white transition-colors">
                    <RuleDetails rule={rule as unknown as PolicyRule} />
                    <button
                      onClick={() => handleRemovePendingRule(idx)}
                      className="shrink-0 rounded-full border border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-100 hover:border-red-300 transition-colors shadow-sm"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {showNewRuleForm && (
              <div className="mb-6 animate-in fade-in slide-in-from-top-2 duration-200">
                <AddRuleForm
                  form={newRuleForm}
                  onChange={(patch) => setNewRuleForm({ ...newRuleForm, ...patch })}
                  onSubmit={handleAddPendingRule}
                  loading={false}
                  onCancel={() => setShowNewRuleForm(false)}
                />
              </div>
            )}
          </div>

          <div className="mt-8 flex justify-end gap-3 border-t border-brand-border pt-6 bg-brand-surface -mx-7 -mb-7 px-7 pb-7 rounded-b-2xl">
            <button
              onClick={() => {
                const el = document.getElementById('new-policy-details') as HTMLDetailsElement;
                if (el) el.open = false;
              }}
              className="rounded-full bg-white border border-brand-border px-6 py-2.5 text-sm font-medium text-brand-text hover:bg-brand-bg transition-colors shadow-sm"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={actionLoading}
              className="rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-text/90 hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:shadow-none disabled:transform-none"
            >
              Save Policy
            </button>
          </div>
        </div>
      </details>

      {/* ── Policy list ────────────────────────────────────────────────────── */}
      <div className="space-y-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-brand-muted">
            <Loader2 className="h-8 w-8 animate-spin text-brand-accent mb-4" />
            <p className="text-sm font-medium">Loading policies...</p>
          </div>
        ) : policies.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 px-6 text-center border border-dashed border-brand-border rounded-2xl bg-brand-surface/30">
            <div className="mb-5 rounded-full bg-white p-5 border border-brand-border shadow-sm">
              <svg className="w-8 h-8 text-brand-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-bold font-serif text-brand-text mb-2">No policies configured</h3>
            <p className="text-sm text-brand-muted max-w-md mb-8 leading-relaxed">Create your first policy to strictly define the capabilities and limits of your agent wallet and operations.</p>
            <button
              onClick={() => {
                const el = document.getElementById('new-policy-details') as HTMLDetailsElement;
                if (el) el.open = true;
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-text/90 hover:shadow-xl hover:-translate-y-0.5 transition-all"
            >
              Create Policy
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border border-brand-border bg-white shadow-sm overflow-hidden divide-y divide-brand-border">
            {policies.map((policy) => {
              const isExpanded = expandedId === policy.id;
              const rules = rulesMap[policy.id] ?? [];

              return (
                <div key={policy.id} className={`transition-all duration-300 ${isExpanded ? 'bg-brand-surface' : 'bg-white'}`}>
                  {/* Policy row */}
                  <div className="flex items-center justify-between px-7 py-4 gap-4 hover:bg-brand-surface transition-colors">
                    <div className="flex items-center gap-4 min-w-0">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold shrink-0 ${
                          policy.enabled
                            ? 'bg-green-100 text-green-700'
                            : 'bg-brand-surface border border-brand-border text-brand-muted'
                        }`}
                      >
                        {policy.enabled ? 'Active' : 'Disabled'}
                      </span>

                      {policy.description ? (
                        <span className="text-sm text-brand-text truncate">{policy.description}</span>
                      ) : (
                        <span className="text-sm text-brand-muted italic truncate">No description</span>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-3 shrink-0">
                      <button
                        onClick={() => handleExpand(policy.id)}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-all shadow-sm ${
                          isExpanded 
                            ? 'bg-brand-text border-brand-text text-white' 
                            : 'bg-white border-brand-border text-brand-text hover:border-brand-accent hover:text-brand-accent'
                        }`}
                      >
                        {isExpanded ? 'Hide Rules' : 'Manage Rules'}
                      </button>
                      <button
                        onClick={() => handleToggleEnabled(policy)}
                        disabled={actionLoading}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-all shadow-sm disabled:opacity-50 ${
                          policy.enabled
                            ? 'bg-white border-amber-200 text-amber-700 hover:bg-amber-50 hover:border-amber-300'
                            : 'bg-white border-green-200 text-green-700 hover:bg-green-50 hover:border-green-300'
                        }`}
                      >
                        {policy.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={() => handleDelete(policy.id)}
                        disabled={actionLoading}
                        className="rounded-full bg-white border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 shadow-sm hover:bg-red-50 hover:border-red-300 transition-all disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {/* Expandable rules section */}
                  {isExpanded && (
                    <div className="border-t border-brand-border px-6 py-8 shadow-inner animate-in slide-in-from-top-2 duration-300">
                      <div className="flex flex-col gap-6 max-w-4xl mx-auto">
                        <div className="flex items-center justify-between border-b border-brand-border pb-4">
                          <div>
                            <h3 className="text-base font-bold font-serif text-brand-text">Policy Rule Chain</h3>
                            <p className="text-[11px] text-brand-muted mt-1 uppercase tracking-wider font-semibold">Execution sequence for {policy.scope}</p>
                          </div>
                          <button
                            onClick={() => {
                              const el = document.getElementById(`add-rule-details-${policy.id}`) as HTMLDetailsElement;
                              if (el) el.open = true;
                            }}
                            className="rounded-full bg-white border border-dashed border-brand-border px-4 py-2 text-xs font-semibold text-brand-text shadow-sm hover:border-brand-accent hover:text-brand-accent hover:-translate-y-0.5 transition-all"
                          >
                            + Add Rule
                          </button>
                        </div>

                        {rulesLoading === policy.id ? (
                          <div className="flex items-center justify-center py-10">
                            <Loader2 className="h-6 w-6 animate-spin text-brand-accent" />
                          </div>
                        ) : rules.length === 0 ? (
                          <div className="rounded-2xl border border-dashed border-brand-border bg-white p-8 text-center shadow-sm">
                            <p className="text-sm font-semibold text-brand-text">This policy has no rules yet.</p>
                            <p className="text-xs text-brand-muted mt-2">Add rules to start enforcing operational logic.</p>
                          </div>
                        ) : (
                          <div className="rounded-2xl border border-brand-border bg-white shadow-sm overflow-hidden divide-y divide-brand-border">
                            {rules.map((rule, ruleIndex) => (
                              <div
                                key={ruleIndex}
                                className="flex flex-col lg:flex-row lg:items-center justify-between p-5 gap-5 hover:bg-brand-surface/30 transition-colors relative group"
                              >
                                <div className="absolute top-1/2 -left-[3px] w-[6px] h-[6px] rounded-full bg-brand-border -translate-y-1/2 hidden lg:block group-hover:bg-brand-accent transition-colors" />
                                
                    <RuleDetails rule={rule as unknown as PolicyRule} />
                                
                                <button
                                  onClick={() => handleDeleteRule(policy.id, ruleIndex)}
                                  disabled={actionLoading}
                                  className="shrink-0 rounded-full border border-red-200 bg-white px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-red-600 hover:bg-red-50 hover:border-red-300 transition-colors shadow-sm disabled:opacity-50"
                                >
                                  Remove Rule
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        <details id={`add-rule-details-${policy.id}`} className="group [&_summary::-webkit-details-marker]:hidden">
                          <summary className="list-none hidden" />
                          <div className="mt-2 animate-in fade-in slide-in-from-top-4 duration-300">
                            <AddRuleForm
                              form={getRuleForm(policy.id)}
                              onChange={(patch) => patchRuleForm(policy.id, patch)}
                              onSubmit={() => handleAddRule(policy.id)}
                              loading={actionLoading}
                              onCancel={() => {
                                const el = document.getElementById(`add-rule-details-${policy.id}`) as HTMLDetailsElement;
                                if (el) el.open = false;
                                setRuleFormMap((prev) => ({ ...prev, [policy.id]: DEFAULT_RULE_FORM }));
                              }}
                            />
                          </div>
                        </details>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
