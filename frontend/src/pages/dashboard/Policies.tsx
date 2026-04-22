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

interface Policy {
  id: string;
  scope: string;
  description?: string;
  enabled: boolean;
  deleted: boolean;
  policyRules: { id: string }[];
  createdAt: number;
}

type RuleType = 'contract_functions' | 'account_functions' | 'rate_limit';
type RateLimitFn = 'gas_per_transaction' | 'gas_per_interval' | 'count_per_interval';
type TimeIntervalType = 'minute' | 'hour' | 'day' | 'week' | 'month';

interface ContractFunctionsRule {
  id: string;
  type: 'contract_functions';
  contract?: { id: string; name?: string; address?: string };
  functionName?: string;
  wildcard: boolean;
  createdAt: number;
}
interface AccountFunctionsRule {
  id: string;
  type: 'account_functions';
  createdAt: number;
}
interface RateLimitGasPerTx {
  id: string;
  type: 'rate_limit';
  functionName: 'gas_per_transaction';
  gasLimit: string;
  createdAt: number;
}
interface RateLimitGasPerInterval {
  id: string;
  type: 'rate_limit';
  functionName: 'gas_per_interval';
  gasLimit: string;
  timeIntervalType: string;
  timeIntervalValue: number;
  createdAt: number;
}
interface RateLimitCountPerInterval {
  id: string;
  type: 'rate_limit';
  functionName: 'count_per_interval';
  countLimit: number;
  timeIntervalType: string;
  timeIntervalValue: number;
  createdAt: number;
}
type PolicyRule =
  | ContractFunctionsRule
  | AccountFunctionsRule
  | RateLimitGasPerTx
  | RateLimitGasPerInterval
  | RateLimitCountPerInterval;

// ─── Constants ────────────────────────────────────────────────────────────────

type PolicyScope = 'project' | 'account' | 'transaction';
const POLICY_SCOPES: PolicyScope[] = ['project', 'account', 'transaction'];

const RULE_TYPES: RuleType[] = ['contract_functions', 'account_functions', 'rate_limit'];

const RULE_TYPE_LABELS: Record<RuleType, string> = {
  contract_functions: 'Contract Functions',
  account_functions: 'Account Functions',
  rate_limit: 'Rate Limit',
};

const RATE_LIMIT_FNS: RateLimitFn[] = [
  'gas_per_transaction',
  'gas_per_interval',
  'count_per_interval',
];

const RATE_LIMIT_FN_LABELS: Record<RateLimitFn, string> = {
  gas_per_transaction: 'Gas per Transaction',
  gas_per_interval: 'Gas per Interval',
  count_per_interval: 'Count per Interval',
};

const TIME_INTERVAL_TYPES: TimeIntervalType[] = ['minute', 'hour', 'day', 'week', 'month'];

// ─── Rule form state ───────────────────────────────────────────────────────────

interface RuleFormState {
  type: RuleType;
  // contract_functions
  contractId: string;
  functionName: string;
  wildcard: boolean;
  // rate_limit
  rateLimitFn: RateLimitFn;
  gasLimit: string;
  countLimit: string;
  timeIntervalType: TimeIntervalType;
  timeIntervalValue: string;
}

const DEFAULT_RULE_FORM: RuleFormState = {
  type: 'contract_functions',
  contractId: '',
  functionName: '',
  wildcard: false,
  rateLimitFn: 'gas_per_transaction',
  gasLimit: '',
  countLimit: '',
  timeIntervalType: 'day',
  timeIntervalValue: '1',
};

// ─── Rule display helper ───────────────────────────────────────────────────────

function RuleDetails({ rule }: { rule: PolicyRule }) {
  if (rule.type === 'contract_functions') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-brand-text">Contract Functions</span>
        {rule.contract && (
          <span className="font-mono text-xs text-brand-muted">
            {rule.contract.name ?? rule.contract.address ?? rule.contract.id}
          </span>
        )}
        {rule.functionName && (
          <span className="text-xs text-brand-muted">.{rule.functionName}</span>
        )}
        {rule.wildcard && (
          <span className="rounded-full bg-brand-accent/10 px-2 py-0.5 text-xs text-brand-accent">
            wildcard
          </span>
        )}
      </div>
    );
  }

  if (rule.type === 'account_functions') {
    return <span className="text-xs font-medium text-brand-text">Account Functions</span>;
  }

  // rate_limit
  if (rule.functionName === 'gas_per_transaction') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-brand-text">Rate Limit</span>
        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
          Gas / Transaction
        </span>
        <span className="font-mono text-xs text-brand-muted">{rule.gasLimit} wei</span>
      </div>
    );
  }

  if (rule.functionName === 'gas_per_interval') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-brand-text">Rate Limit</span>
        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
          Gas / Interval
        </span>
        <span className="font-mono text-xs text-brand-muted">{rule.gasLimit} wei</span>
        <span className="text-xs text-brand-muted">
          per {rule.timeIntervalValue} {rule.timeIntervalType}
        </span>
      </div>
    );
  }

  if (rule.functionName === 'count_per_interval') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-brand-text">Rate Limit</span>
        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
          Count / Interval
        </span>
        <span className="font-mono text-xs text-brand-muted">{rule.countLimit} txns</span>
        <span className="text-xs text-brand-muted">
          per {rule.timeIntervalValue} {rule.timeIntervalType}
        </span>
      </div>
    );
  }

  return null;
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
  const inputCls =
    'rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder-brand-muted bg-white';
  const selectCls =
    'rounded-lg border border-brand-border px-3 py-2 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white';

  return (
    <div className="rounded-lg border border-brand-border bg-brand-surface p-4 space-y-3">
      <p className="text-xs font-semibold text-brand-text">Add Rule</p>

      {/* Rule type selector */}
      <select
        value={form.type}
        onChange={(e) => onChange({ type: e.target.value as RuleType })}
        className={selectCls}
      >
        {RULE_TYPES.map((t) => (
          <option key={t} value={t}>
            {RULE_TYPE_LABELS[t]}
          </option>
        ))}
      </select>

      {/* contract_functions fields */}
      {form.type === 'contract_functions' && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input
            type="text"
            placeholder="Contract ID (con_...) — optional"
            value={form.contractId}
            onChange={(e) => onChange({ contractId: e.target.value })}
            className={inputCls}
          />
          <input
            type="text"
            placeholder="Function name — optional"
            value={form.functionName}
            onChange={(e) => onChange({ functionName: e.target.value })}
            className={inputCls}
          />
          <label className="flex items-center gap-2 px-1 py-2 text-sm text-brand-text cursor-pointer col-span-full">
            <input
              type="checkbox"
              checked={form.wildcard}
              onChange={(e) => onChange({ wildcard: e.target.checked })}
              className="rounded border-brand-border accent-brand-accent"
            />
            Wildcard (match all functions)
          </label>
        </div>
      )}

      {/* account_functions: no extra fields */}
      {form.type === 'account_functions' && (
        <p className="text-xs text-brand-muted">No additional configuration required.</p>
      )}

      {/* rate_limit fields */}
      {form.type === 'rate_limit' && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <select
            value={form.rateLimitFn}
            onChange={(e) => onChange({ rateLimitFn: e.target.value as RateLimitFn })}
            className={`${selectCls} col-span-full`}
          >
            {RATE_LIMIT_FNS.map((fn) => (
              <option key={fn} value={fn}>
                {RATE_LIMIT_FN_LABELS[fn]}
              </option>
            ))}
          </select>

          {(form.rateLimitFn === 'gas_per_transaction' ||
            form.rateLimitFn === 'gas_per_interval') && (
            <input
              type="text"
              placeholder="Gas limit (WEI)"
              value={form.gasLimit}
              onChange={(e) => onChange({ gasLimit: e.target.value })}
              className={inputCls}
            />
          )}

          {form.rateLimitFn === 'count_per_interval' && (
            <input
              type="number"
              placeholder="Count limit"
              value={form.countLimit}
              onChange={(e) => onChange({ countLimit: e.target.value })}
              className={inputCls}
            />
          )}

          {(form.rateLimitFn === 'gas_per_interval' ||
            form.rateLimitFn === 'count_per_interval') && (
            <>
              <select
                value={form.timeIntervalType}
                onChange={(e) => onChange({ timeIntervalType: e.target.value as TimeIntervalType })}
                className={selectCls}
              >
                {TIME_INTERVAL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Interval value"
                value={form.timeIntervalValue}
                onChange={(e) => onChange({ timeIntervalValue: e.target.value })}
                className={inputCls}
                min={1}
              />
            </>
          )}
        </div>
      )}

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

      // result.id is returned based on the API response structure
      // or result.data.id if wrapped in axios data
      const newPolicyId = (result as any)?.data?.id ?? (result as any)?.id;

      if (newPolicyId && pendingRules.length > 0) {
        for (const form of pendingRules) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const body: Parameters<typeof createPolicyRuleAuth>[2] & Record<string, any> = { type: form.type };

          if (form.type === 'contract_functions') {
            if (form.contractId.trim()) body.contract = form.contractId.trim();
            if (form.functionName.trim()) body.functionName = form.functionName.trim();
            body.wildcard = form.wildcard;
          }

          if (form.type === 'rate_limit') {
            body.functionName = form.rateLimitFn;
            if (form.rateLimitFn === 'gas_per_transaction' || form.rateLimitFn === 'gas_per_interval') {
              body.gasLimit = form.gasLimit.trim();
            }
            if (form.rateLimitFn === 'count_per_interval') {
              body.countLimit = Number(form.countLimit);
            }
            if (form.rateLimitFn === 'gas_per_interval' || form.rateLimitFn === 'count_per_interval') {
              body.timeIntervalType = form.timeIntervalType;
              body.timeIntervalValue = Number(form.timeIntervalValue);
            }
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
    setActionLoading(true);
    setError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: Parameters<typeof createPolicyRuleAuth>[2] & Record<string, any> = { type: form.type };

      if (form.type === 'contract_functions') {
        if (form.contractId.trim()) body.contract = form.contractId.trim();
        if (form.functionName.trim()) body.functionName = form.functionName.trim();
        body.wildcard = form.wildcard;
      }

      if (form.type === 'rate_limit') {
        body.functionName = form.rateLimitFn;
        if (form.rateLimitFn === 'gas_per_transaction' || form.rateLimitFn === 'gas_per_interval') {
          body.gasLimit = form.gasLimit.trim();
        }
        if (form.rateLimitFn === 'count_per_interval') {
          body.countLimit = Number(form.countLimit);
        }
        if (form.rateLimitFn === 'gas_per_interval' || form.rateLimitFn === 'count_per_interval') {
          body.timeIntervalType = form.timeIntervalType;
          body.timeIntervalValue = Number(form.timeIntervalValue);
        }
      }

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

  async function handleDeleteRule(policyId: string, ruleId: string) {
    if (!confirm('Delete this rule?')) return;
    setActionLoading(true);
    setError(null);
    try {
      await deletePolicyRuleAuth(getToken, policyId, ruleId);
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
                    {rule.type === 'contract_functions' && (
                      <>
                        <span className="text-xs font-medium text-brand-text">Contract Functions</span>
                        {rule.contractId && <span className="font-mono text-xs text-brand-muted">{rule.contractId}</span>}
                        {rule.functionName && <span className="text-xs text-brand-muted">.{rule.functionName}</span>}
                        {rule.wildcard && <span className="rounded-full bg-brand-accent/10 px-2 py-0.5 text-xs text-brand-accent">wildcard</span>}
                      </>
                    )}
                    {rule.type === 'account_functions' && (
                      <span className="text-xs font-medium text-brand-text">Account Functions</span>
                    )}
                    {rule.type === 'rate_limit' && (
                      <>
                        <span className="text-xs font-medium text-brand-text">Rate Limit</span>
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                          {RATE_LIMIT_FN_LABELS[rule.rateLimitFn] || rule.rateLimitFn}
                        </span>
                        {rule.rateLimitFn !== 'count_per_interval' && rule.gasLimit && (
                          <span className="font-mono text-xs text-brand-muted">{rule.gasLimit} wei</span>
                        )}
                        {rule.rateLimitFn === 'count_per_interval' && rule.countLimit && (
                          <span className="font-mono text-xs text-brand-muted">{rule.countLimit} txns</span>
                        )}
                        {rule.rateLimitFn !== 'gas_per_transaction' && (
                          <span className="text-xs text-brand-muted">
                            per {rule.timeIntervalValue} {rule.timeIntervalType}
                          </span>
                        )}
                      </>
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
              const ruleCount = policy.policyRules?.length ?? 0;

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
                          {rules.map((rule) => (
                            <div
                              key={rule.id}
                              className="flex items-center justify-between px-4 py-3"
                            >
                              <RuleDetails rule={rule} />
                              <button
                                onClick={() => handleDeleteRule(policy.id, rule.id)}
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
