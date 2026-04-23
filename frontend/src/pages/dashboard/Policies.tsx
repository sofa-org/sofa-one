import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  listPoliciesAuth,
  createPolicyAuth,
  deletePolicyAuth,
  enablePolicyAuth,
  disablePolicyAuth,
  listPolicyRulesAuth,
  createPolicyRuleAuth,
  deletePolicyRuleAuth,
} from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

type PolicyRuleAction = 'accept' | 'reject';
type PolicyRuleOperation =
  | 'signEvmTransaction'
  | 'sendEvmTransaction'
  | 'signEvmMessage'
  | 'signEvmTypedData'
  | 'signEvmHash'
  | 'sponsorEvmTransaction';

type CriterionType =
  | 'ethValue'
  | 'evmAddress'
  | 'evmNetwork'
  | 'evmData'
  | 'evmMessage'
  | 'evmTypedDataVerifyingContract'
  | 'evmTypedDataField';

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

interface PolicyRule {
  action: PolicyRuleAction;
  operation: PolicyRuleOperation;
  criteria?: Record<string, unknown>[];
}

interface Policy {
  id: string;
  scope: string;
  description?: string;
  enabled: boolean;
  deleted: boolean;
  rules?: PolicyRule[];
  createdAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

type PolicyScope = 'project' | 'account' | 'transaction';
const POLICY_SCOPES: PolicyScope[] = ['project', 'account', 'transaction'];

const POLICY_RULE_OPERATIONS: PolicyRuleOperation[] = [
  'signEvmTransaction',
  'sendEvmTransaction',
  'signEvmMessage',
  'signEvmTypedData',
  'signEvmHash',
  'sponsorEvmTransaction',
];

const CRITERION_TYPES: CriterionType[] = [
  'ethValue',
  'evmAddress',
  'evmNetwork',
  'evmData',
  'evmMessage',
  'evmTypedDataVerifyingContract',
  'evmTypedDataField',
];

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

function criterionDraftToApi(c: CriterionDraft): Record<string, unknown> | null {
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
      const obj: Record<string, unknown> = {
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
      const base: Record<string, unknown> = { type: 'evmTypedDataField', operator: op, fieldPath: c.fieldPath.trim() };
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
        <div className="flex gap-2">
          <select
            value={draft.ethValueOperator ?? '<='}
            onChange={(e) => onChange({ ethValueOperator: e.target.value as CriterionDraft['ethValueOperator'] })}
            className={`${selectCls} w-24 shrink-0`}
          >
            {(['<=', '>=', '<', '>'] as const).map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
          <input
            type="text"
            placeholder="wei, e.g. 1000000000000000000 = 1 ETH"
            value={draft.ethValue ?? ''}
            onChange={(e) => onChange({ ethValue: e.target.value })}
            className={`${inputCls} flex-1`}
          />
        </div>
      );

    case 'evmAddress':
    case 'evmTypedDataVerifyingContract':
      return (
        <div className="space-y-2">
          <select
            value={draft.addressOperator ?? 'in'}
            onChange={(e) => onChange({ addressOperator: e.target.value as 'in' | 'not in' })}
            className={selectCls}
          >
            <option value="in">in (allowlist)</option>
            <option value="not in">not in (denylist)</option>
          </select>
          <textarea
            rows={3}
            placeholder="One address per line&#10;0x1234…&#10;0xabcd…"
            value={draft.addresses ?? ''}
            onChange={(e) => onChange({ addresses: e.target.value })}
            className={textareaCls}
          />
        </div>
      );

    case 'evmNetwork':
      return (
        <div className="space-y-2">
          <select
            value={draft.networkOperator ?? 'in'}
            onChange={(e) => onChange({ networkOperator: e.target.value as 'in' | 'not in' })}
            className={selectCls}
          >
            <option value="in">in (allowlist)</option>
            <option value="not in">not in (denylist)</option>
          </select>
          <input
            type="text"
            placeholder="Comma-separated chain IDs, e.g. 1,137,8453"
            value={draft.chainIds ?? ''}
            onChange={(e) => onChange({ chainIds: e.target.value })}
            className={inputCls}
          />
        </div>
      );

    case 'evmData':
      return (
        <div className="space-y-2">
          <select
            value={draft.dataOperator ?? '=='}
            onChange={(e) => onChange({ dataOperator: e.target.value as CriterionDraft['dataOperator'] })}
            className={selectCls}
          >
            {(['==', 'in', 'not in', '<', '<=', '>', '>=', 'match'] as const).map((op) => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Function name, e.g. transfer"
            value={draft.functionName ?? ''}
            onChange={(e) => onChange({ functionName: e.target.value })}
            className={inputCls}
          />
          <textarea
            rows={3}
            placeholder='Contract ABI JSON, e.g. [{"type":"function","name":"transfer",...}]'
            value={draft.abi ?? ''}
            onChange={(e) => onChange({ abi: e.target.value })}
            className={textareaCls}
          />
          <textarea
            rows={2}
            placeholder='Args constraints (optional), e.g. {"amount": "1000000"}'
            value={draft.argsJson ?? ''}
            onChange={(e) => onChange({ argsJson: e.target.value })}
            className={textareaCls}
          />
        </div>
      );

    case 'evmMessage':
      return (
        <input
          type="text"
          placeholder='RE2 regex pattern, e.g. ^Sign in to MyApp:'
          value={draft.messagePattern ?? ''}
          onChange={(e) => onChange({ messagePattern: e.target.value })}
          className={inputCls}
        />
      );

    case 'evmTypedDataField':
      return (
        <div className="space-y-2">
          <select
            value={draft.fieldOperator ?? 'in'}
            onChange={(e) => onChange({ fieldOperator: e.target.value as 'in' | '<=' | 'match' })}
            className={selectCls}
          >
            <option value="in">in (allowlist)</option>
            <option value="<=">{'<='} (max value)</option>
            <option value="match">match (regex)</option>
          </select>
          <input
            type="text"
            placeholder="Field path, e.g. order.buyer"
            value={draft.fieldPath ?? ''}
            onChange={(e) => onChange({ fieldPath: e.target.value })}
            className={inputCls}
          />
          <textarea
            rows={3}
            placeholder={
              draft.fieldOperator === 'in'
                ? 'One value per line'
                : draft.fieldOperator === 'match'
                ? 'RE2 regex pattern'
                : 'Max value, e.g. 1000000'
            }
            value={draft.fieldValues ?? ''}
            onChange={(e) => onChange({ fieldValues: e.target.value })}
            className={textareaCls}
          />
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
}: {
  criteria: CriterionDraft[];
  onChange: (criteria: CriterionDraft[]) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<CriterionDraft>({ ...DEFAULT_CRITERION });

  const inputCls =
    'w-full rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder-brand-muted bg-white';
  const selectCls =
    'w-full rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white';
  const textareaCls =
    'w-full rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder-brand-muted bg-white font-mono';

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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-brand-muted">Criteria</span>
        {!showForm && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="rounded-full border border-brand-border px-2 py-0.5 text-xs text-brand-text hover:bg-brand-bg"
          >
            + Add Criterion
          </button>
        )}
      </div>

      {/* Existing criteria chips */}
      {criteria.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {criteria.map((c, idx) => (
            <span
              key={idx}
              className="flex items-center gap-1 rounded-full bg-brand-accent/10 px-2 py-0.5 text-xs text-brand-accent"
            >
              {criterionSummary(c)}
              <button
                type="button"
                onClick={() => handleRemove(idx)}
                className="ml-0.5 text-brand-muted hover:text-red-500 leading-none"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Add criterion form */}
      {showForm && (
        <div className="rounded-lg border border-brand-border bg-brand-bg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-brand-text">New Criterion</span>
            <button
              type="button"
              onClick={() => { setShowForm(false); setDraft({ ...DEFAULT_CRITERION }); }}
              className="text-brand-muted hover:text-brand-text text-sm leading-none"
            >
              ×
            </button>
          </div>

          {/* Type selector */}
          <select
            value={draft.type}
            onChange={(e) => setDraft({ ...DEFAULT_CRITERION, type: e.target.value as CriterionType })}
            className={selectCls}
          >
            {CRITERION_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          {/* Type-specific fields */}
          <CriterionFields
            draft={draft}
            onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
            inputCls={inputCls}
            selectCls={selectCls}
            textareaCls={textareaCls}
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleAdd}
              className="rounded-full bg-brand-text px-3 py-1 text-xs font-medium text-white hover:bg-brand-text/90"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Rule display helper ───────────────────────────────────────────────────────

function RuleDetails({ rule }: { rule: PolicyRule }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
          rule.action === 'accept'
            ? 'bg-green-100 text-green-700'
            : 'bg-red-100 text-red-700'
        }`}
      >
        {rule.action}
      </span>
      <span className="font-mono text-xs text-brand-text">{rule.operation}</span>
      {rule.criteria && rule.criteria.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {rule.criteria.map((c, i) => (
            <span key={i} className="rounded-full bg-brand-accent/10 px-2 py-0.5 text-xs text-brand-accent font-mono">
              {String(c.type)}
              {c.operator ? ` ${String(c.operator)}` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Add rule form ─────────────────────────────────────────────────────────────

interface AddRuleFormProps {
  policyId: string;
  form: RuleFormState;
  onChange: (patch: Partial<RuleFormState>) => void;
  onSubmit: () => void;
  loading: boolean;
}

function AddRuleForm({ policyId: _policyId, form, onChange, onSubmit, loading }: AddRuleFormProps) {
  const selectCls =
    'rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white';

  return (
    <div className="rounded-lg border border-brand-border bg-brand-surface p-4 space-y-3">
      <p className="text-xs font-semibold text-brand-text">Add Rule</p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {/* Action selector */}
        <select
          value={form.action}
          onChange={(e) => onChange({ action: e.target.value as PolicyRuleAction })}
          className={selectCls}
        >
          <option value="accept">accept</option>
          <option value="reject">reject</option>
        </select>

        {/* Operation selector */}
        <select
          value={form.operation}
          onChange={(e) => onChange({ operation: e.target.value as PolicyRuleOperation })}
          className={selectCls}
        >
          {POLICY_RULE_OPERATIONS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
      </div>

      {/* Criteria builder */}
      <CriteriaBuilder
        criteria={form.criteria}
        onChange={(criteria) => onChange({ criteria })}
      />

      <div className="flex justify-end">
        <button
          onClick={onSubmit}
          disabled={loading}
          className="rounded-full bg-brand-text px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-text/90 disabled:opacity-50"
        >
          Add Rule
        </button>
      </div>
    </div>
  );
}

// ─── Rule body builder ─────────────────────────────────────────────────────────

function buildRuleBody(
  form: RuleFormState,
  setError: (msg: string) => void,
): { action: PolicyRuleAction; operation: PolicyRuleOperation; criteria?: Record<string, unknown>[] } | null {
  const body: { action: PolicyRuleAction; operation: PolicyRuleOperation; criteria?: Record<string, unknown>[] } = {
    action: form.action,
    operation: form.operation,
  };
  if (form.criteria.length > 0) {
    const apiCriteria: Record<string, unknown>[] = [];
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
  const { getToken } = useAuth();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create policy form
  const [newScope, setNewScope] = useState<PolicyScope>('project');
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
      const res = await listPoliciesAuth(getToken);
      setPolicies(res?.data ?? []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchPolicies();
  }, []);

  async function fetchRules(policyId: string) {
    setRulesLoading(policyId);
    try {
      const res = await listPolicyRulesAuth(getToken, policyId);
      setRulesMap((prev) => ({ ...prev, [policyId]: res?.data ?? [] }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
      const result = await createPolicyAuth(getToken, {
        scope: newScope,
        description: newDescription.trim() || undefined,
        enabled: newEnabled,
      });

      const newPolicyId = (result as any)?.data?.id ?? (result as any)?.id;

      if (newPolicyId && pendingRules.length > 0) {
        for (const form of pendingRules) {
          const body = buildRuleBody(form, (msg) => setError(msg));
          if (!body) {
            setActionLoading(false);
            return;
          }
          await createPolicyRuleAuth(getToken, newPolicyId, body);
        }
      }

      setNewScope('project');
      setNewDescription('');
      setNewEnabled(true);
      setPendingRules([]);
      setNewRuleForm(DEFAULT_RULE_FORM);
      setShowNewRuleForm(false);
      await fetchPolicies();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const inputCls =
    'rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder-brand-muted bg-white';
  const selectCls =
    'rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold font-serif text-brand-text">Policies</h1>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Create policy form ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-brand-border bg-brand-surface p-6 shadow-sm">
        <h2 className="text-base font-semibold font-serif text-brand-text">Create New Policy</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <select
            value={newScope}
            onChange={(e) => setNewScope(e.target.value as PolicyScope)}
            className={selectCls}
          >
            {POLICY_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            className={`${inputCls} sm:col-span-2`}
          />
          <label className="flex items-center gap-2 px-1 py-2 text-sm text-brand-text cursor-pointer">
            <input
              type="checkbox"
              checked={newEnabled}
              onChange={(e) => setNewEnabled(e.target.checked)}
              className="rounded border-brand-border accent-brand-accent"
            />
            Enabled
          </label>
        </div>

        <div className="mt-6 border-t border-brand-border pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold font-serif text-brand-text">Rules (optional)</h3>
            {!showNewRuleForm && (
              <button
                onClick={() => setShowNewRuleForm(true)}
                className="rounded-full border border-brand-border px-3 py-1 text-xs font-medium text-brand-text hover:bg-brand-bg"
              >
                Add Rule
              </button>
            )}
          </div>

          {pendingRules.length > 0 && (
            <div className="mb-4 rounded-lg border border-brand-border bg-brand-surface divide-y divide-brand-border">
              {pendingRules.map((rule, idx) => (
                <div key={idx} className="flex items-center justify-between px-4 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        rule.action === 'accept'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {rule.action}
                    </span>
                    <span className="font-mono text-xs text-brand-text">{rule.operation}</span>
                    {rule.criteria.length > 0 && (
                      <span className="text-xs text-brand-muted">{rule.criteria.length} criterion{rule.criteria.length !== 1 ? 'a' : ''}</span>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemovePendingRule(idx)}
                    className="ml-4 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-brand-muted hover:bg-red-50 hover:text-red-600"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {showNewRuleForm && (
            <div className="mb-4 relative">
              <button
                onClick={() => setShowNewRuleForm(false)}
                className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full text-brand-muted hover:bg-brand-bg hover:text-brand-text"
              >
                ×
              </button>
              <AddRuleForm
                policyId="new-policy"
                form={newRuleForm}
                onChange={(patch) => setNewRuleForm({ ...newRuleForm, ...patch })}
                onSubmit={handleAddPendingRule}
                loading={false}
              />
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end border-t border-brand-border pt-4">
          <button
            onClick={handleCreate}
            disabled={actionLoading}
            className="rounded-full bg-brand-text px-4 py-2 text-sm font-medium text-white hover:bg-brand-text/90 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </div>

      {/* ── Policy list ────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-brand-border bg-brand-surface shadow-sm">
        <div className="border-b border-brand-border px-6 py-4">
          <h2 className="text-base font-semibold font-serif text-brand-text">Your Policies</h2>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-accent border-t-transparent" />
          </div>
        ) : policies.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-brand-muted">No policies yet.</p>
        ) : (
          <div className="divide-y divide-brand-border">
            {policies.map((policy) => {
              const isExpanded = expandedId === policy.id;
              const rules = rulesMap[policy.id] ?? [];
              const ruleCount = policy.rules?.length ?? 0;

              return (
                <div key={policy.id}>
                  {/* Policy row */}
                  <div className="flex items-center justify-between px-6 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm text-brand-text capitalize">
                          {policy.scope}
                        </span>
                        {policy.description && (
                          <span className="text-xs text-brand-muted">{policy.description}</span>
                        )}
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            policy.enabled
                              ? 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {policy.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        <span className="text-xs text-brand-muted">
                          {ruleCount} rule{ruleCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-brand-muted">
                        Created {new Date(policy.createdAt * 1000).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="ml-4 flex shrink-0 items-center gap-2">
                      <button
                        onClick={() => handleExpand(policy.id)}
                        className="rounded-full border border-brand-border px-3 py-1.5 text-xs font-medium text-brand-text hover:bg-brand-bg"
                      >
                        {isExpanded ? 'Hide Rules' : 'Manage Rules'}
                      </button>
                      <button
                        onClick={() => handleToggleEnabled(policy)}
                        disabled={actionLoading}
                        className={`rounded-full border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                          policy.enabled
                            ? 'border-amber-200 text-amber-700 hover:bg-amber-50'
                            : 'border-green-200 text-green-700 hover:bg-green-50'
                        }`}
                      >
                        {policy.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={() => handleDelete(policy.id)}
                        disabled={actionLoading}
                        className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {/* Expandable rules section */}
                  {isExpanded && (
                    <div className="border-t border-brand-border bg-brand-bg px-6 py-4 space-y-4">
                      <h3 className="text-sm font-semibold font-serif text-brand-text">Rules</h3>

                      {rulesLoading === policy.id ? (
                        <div className="flex justify-center py-4">
                          <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand-accent border-t-transparent" />
                        </div>
                      ) : rules.length === 0 ? (
                        <p className="text-xs text-brand-muted">No rules yet.</p>
                      ) : (
                        <div className="rounded-lg border border-brand-border bg-brand-surface divide-y divide-brand-border">
                          {rules.map((rule, ruleIndex) => (
                            <div
                              key={ruleIndex}
                              className="flex items-center justify-between px-4 py-3"
                            >
                              <RuleDetails rule={rule} />
                              <button
                                onClick={() => handleDeleteRule(policy.id, ruleIndex)}
                                disabled={actionLoading}
                                className="ml-4 shrink-0 rounded-full border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                              >
                                Delete
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      <AddRuleForm
                        policyId={policy.id}
                        form={getRuleForm(policy.id)}
                        onChange={(patch) => patchRuleForm(policy.id, patch)}
                        onSubmit={() => handleAddRule(policy.id)}
                        loading={actionLoading}
                      />
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
