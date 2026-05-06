import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import './PollCreationForm.css';

const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;
const MIN_STEM_LENGTH = 5;

interface PollCreationFormProps {
  /** If true, navigates to question page on success. If false, calls onSuccess with the question ID. */
  navigateOnSuccess?: boolean;
  /** Called after successful creation (only if navigateOnSuccess is false). */
  onSuccess?: (questionId: string) => void;
  /** Called when user cancels. */
  onCancel?: () => void;
}

const PollCreationForm: React.FC<PollCreationFormProps> = ({
  navigateOnSuccess = true,
  onSuccess,
  onCancel,
}) => {
  const navigate = useNavigate();
  const { isAuthenticated, getAuthToken } = useAuth();

  const [stem, setStem] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Advanced (poll-feature) inputs. Hidden by default to keep the form lean
  // for the simple case; tuck-aways for closes_at + NFT gate live behind a
  // disclosure toggle.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [closesAt, setClosesAt] = useState<string>('');           // datetime-local string, e.g. "2026-05-09T18:00"
  const [gateEnabled, setGateEnabled] = useState(false);
  const [gateType, setGateType] = useState<'nft_snapshot' | 'token_snapshot'>('nft_snapshot');
  const [gateContract, setGateContract] = useState('');
  const [gateChain, setGateChain] = useState<'base'>('base');     // v0: base only
  const [gateMinBalance, setGateMinBalance] = useState('');       // human-readable, e.g. "4420000"
  const [submitStage, setSubmitStage] = useState<'idle' | 'snapshotting' | 'creating'>('idle');
  const [snapshotInfo, setSnapshotInfo] = useState<{ holder_address_count: number; holder_fid_count: number } | null>(null);

  const handleOptionChange = (index: number, value: string) => {
    const next = [...options];
    next[index] = value;
    setOptions(next);
  };

  const addOption = () => {
    if (options.length < MAX_OPTIONS) setOptions([...options, '']);
  };

  const removeOption = (index: number) => {
    if (options.length > MIN_OPTIONS) {
      setOptions(options.filter((_, i) => i !== index));
    }
  };

  const filledOptions = options.filter(o => o.trim() !== '');
  const canSubmit =
    isAuthenticated &&
    stem.trim().length >= MIN_STEM_LENGTH &&
    filledOptions.length >= MIN_OPTIONS &&
    !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    // Validate advanced fields when present
    if (closesAt) {
      const closesMs = Date.parse(closesAt);
      if (!Number.isFinite(closesMs) || closesMs <= Date.now()) {
        setError('Close time must be in the future');
        return;
      }
    }
    if (gateEnabled) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(gateContract.trim())) {
        setError('Contract address must be 0x + 40 hex chars');
        return;
      }
      if (gateType === 'token_snapshot') {
        if (!gateMinBalance || !/^\d+(\.\d+)?$/.test(gateMinBalance) || Number(gateMinBalance) <= 0) {
          setError('Minimum balance must be a positive number');
          return;
        }
      }
    }

    setError(null);
    setIsSubmitting(true);
    setSubmitStage(gateEnabled ? 'snapshotting' : 'creating');

    const token = getAuthToken();
    if (!token) {
      setError('Authentication required. Please log in again.');
      setIsSubmitting(false);
      setSubmitStage('idle');
      return;
    }

    try {
      // Step 1: Create mc question (server fires background cast without embed).
      // When `eligibility_gate` is set the server runs the holder snapshot
      // synchronously, so this request can take 10–30s.
      const createRes = await fetch('/api/queries', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          stem: stem.trim(),
          type: 'mc',
          a_options: filledOptions,
          includeEmbed: false, // suppress server-side embed cast
          ...(closesAt ? { closes_at: new Date(closesAt).toISOString() } : {}),
          ...(gateEnabled
            ? {
                eligibility_gate:
                  gateType === 'nft_snapshot'
                    ? {
                        type: 'nft_snapshot' as const,
                        contract: gateContract.trim().toLowerCase(),
                        chain: gateChain,
                      }
                    : {
                        type: 'token_snapshot' as const,
                        contract: gateContract.trim().toLowerCase(),
                        chain: gateChain,
                        min_balance: gateMinBalance.trim(),
                      },
              }
            : {}),
        }),
      });

      if (!createRes.ok) {
        const errData = await createRes.json().catch(() => ({}));
        if (createRes.status === 429) {
          setError(errData.error || 'Too many requests. Please wait and try again.');
        } else if (createRes.status === 402) {
          setError('Insufficient QP for question creation.');
        } else if (createRes.status === 503) {
          setError(errData.error || 'NFT snapshot failed. Please try again.');
        } else {
          setError(errData.error || `Failed to create poll: ${createRes.status}`);
        }
        setIsSubmitting(false);
        setSubmitStage('idle');
        return;
      }

      const createJson = await createRes.json() as {
        id: string;
        snapshot?: { holder_address_count: number; holder_fid_count: number };
      };
      const questionId = createJson.id;
      if (createJson.snapshot) setSnapshotInfo(createJson.snapshot);
      setSubmitStage('creating');

      // Cast includes question + options text for searchability ("all questions are casts")
      const castText = `${stem.trim()}\n\n${filledOptions.map((o, i) => `${['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'][i]} ${o}`).join('\n')}`;

      const castRes = await fetch('/api/farcaster/cast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          usePollsBot: true,  // cast from @polls bot (FID 3321680)
          text: castText,
          embeds: [{ url: `${window.location.origin}/snap/question/${questionId}` }],
          entityType: 'query',
          entityId: questionId,
          includeSnap: true,
        }),
      });

      if (!castRes.ok) {
        console.warn('[PollCreation] Snap cast failed (question still created):', castRes.status);
        // Question is created — snap cast failure is non-critical.
        // has_snap might not be set, but the question page still works.
      }

      sessionStorage.setItem('qbase_question_created', Date.now().toString());

      if (navigateOnSuccess) {
        navigate(`/question/${questionId}`, {
          state: { isNewQuestion: true, castPending: true },
        });
      } else {
        onSuccess?.(questionId);
      }
    } catch (err) {
      console.error('[PollCreation] Error:', err);
      setError('Failed to create poll. Please try again.');
    } finally {
      setIsSubmitting(false);
      setSubmitStage('idle');
    }
  };

  const submitLabel = (() => {
    if (!isSubmitting) return 'Create Poll';
    if (submitStage === 'snapshotting') return 'Snapshotting holders…';
    return 'Creating…';
  })();

  return (
    <div className="poll-form">
      <div className="poll-form__header">
        <h2 className="poll-form__title">Create a Poll</h2>
        {onCancel && (
          <button className="poll-form__cancel" onClick={onCancel}>✕</button>
        )}
      </div>

      <label className="poll-form__label">Question</label>
      <input
        className="poll-form__stem"
        type="text"
        placeholder="What do you want to ask?"
        value={stem}
        onChange={e => setStem(e.target.value)}
        maxLength={300}
        disabled={isSubmitting}
      />

      <label className="poll-form__label">Options</label>
      <div className="poll-form__options">
        {options.map((opt, i) => (
          <div className="poll-form__option-row" key={i}>
            <span className="poll-form__option-number">{i + 1}</span>
            <input
              className="poll-form__option-input"
              type="text"
              placeholder={`Option ${i + 1}`}
              value={opt}
              onChange={e => handleOptionChange(i, e.target.value)}
              maxLength={100}
              disabled={isSubmitting}
            />
            {options.length > MIN_OPTIONS && (
              <button
                className="poll-form__option-remove"
                onClick={() => removeOption(i)}
                disabled={isSubmitting}
                title="Remove option"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {options.length < MAX_OPTIONS && (
        <button
          className="poll-form__add-option"
          onClick={addOption}
          disabled={isSubmitting}
        >
          + Add option
        </button>
      )}

      <button
        type="button"
        className="poll-form__advanced-toggle"
        onClick={() => setAdvancedOpen(o => !o)}
        disabled={isSubmitting}
      >
        {advancedOpen ? '▾ Advanced' : '▸ Advanced'}
      </button>

      {advancedOpen && (
        <div className="poll-form__advanced">
          <label className="poll-form__label">Closes at (optional)</label>
          <input
            className="poll-form__closes-at"
            type="datetime-local"
            value={closesAt}
            onChange={e => setClosesAt(e.target.value)}
            disabled={isSubmitting}
          />
          <p className="poll-form__hint">
            Voting locks past this time; results stay visible.
          </p>

          <label className="poll-form__label" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={gateEnabled}
              onChange={e => setGateEnabled(e.target.checked)}
              disabled={isSubmitting}
              style={{ marginRight: 8 }}
            />
            Restrict voting to onchain holders
          </label>
          {gateEnabled && (
            <>
              <div className="poll-form__gate-type" style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="radio"
                    name="gate-type"
                    value="nft_snapshot"
                    checked={gateType === 'nft_snapshot'}
                    onChange={() => setGateType('nft_snapshot')}
                    disabled={isSubmitting}
                  />
                  NFT
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="radio"
                    name="gate-type"
                    value="token_snapshot"
                    checked={gateType === 'token_snapshot'}
                    onChange={() => setGateType('token_snapshot')}
                    disabled={isSubmitting}
                  />
                  ERC-20 token amount
                </label>
              </div>
              <input
                className="poll-form__option-input"
                type="text"
                placeholder={gateType === 'nft_snapshot' ? '0x… NFT contract address' : '0x… ERC-20 contract address'}
                value={gateContract}
                onChange={e => setGateContract(e.target.value)}
                maxLength={42}
                disabled={isSubmitting}
                style={{ marginTop: 8 }}
              />
              {gateType === 'token_snapshot' && (
                <input
                  className="poll-form__option-input"
                  type="text"
                  inputMode="decimal"
                  placeholder="Minimum amount (e.g. 4420000)"
                  value={gateMinBalance}
                  onChange={e => setGateMinBalance(e.target.value)}
                  disabled={isSubmitting}
                  style={{ marginTop: 8 }}
                />
              )}
              <select
                className="poll-form__chain-select"
                value={gateChain}
                onChange={e => setGateChain(e.target.value as 'base')}
                disabled={isSubmitting}
                style={{ marginTop: 8 }}
              >
                <option value="base">Base</option>
              </select>
              <p className="poll-form__hint">
                {gateType === 'nft_snapshot'
                  ? `We'll snapshot current holders at creation. Only holders with a Farcaster-verified address can vote.`
                  : `We'll snapshot holders with at least the minimum balance at creation. Decimals fetched from the contract; only holders with a Farcaster-verified address can vote.`}
              </p>
            </>
          )}
        </div>
      )}

      {error && <div className="poll-form__error">{error}</div>}

      {snapshotInfo && (
        <div className="poll-form__snapshot-info">
          Snapshot: {snapshotInfo.holder_address_count.toLocaleString()} holder{snapshotInfo.holder_address_count === 1 ? '' : 's'} →{' '}
          {snapshotInfo.holder_fid_count.toLocaleString()} verified on Farcaster
        </div>
      )}

      <button
        className="poll-form__submit"
        onClick={handleSubmit}
        disabled={!canSubmit}
      >
        {submitLabel}
      </button>
    </div>
  );
};

export default PollCreationForm;
