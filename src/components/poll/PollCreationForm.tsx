import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { pollSnapUrl } from '../../lib/clientCast';
import './PollCreationForm.css';

const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;
const MIN_STEM_LENGTH = 5;
const DEFAULT_WAVE_DAYS = 7;

/** datetime-local value (local time, minute precision) for N days from now. */
function defaultClosesAt(days: number): string {
  const d = new Date(Date.now() + days * 24 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The question a new wave is opened on (re-ask mode). */
export interface ExistingQuestion {
  id: string;
  stem: string;
  type: string;
  a_options?: string[];
}

interface PollCreationFormProps {
  /** If true, navigates to question page on success. If false, calls onSuccess with the question ID. */
  navigateOnSuccess?: boolean;
  /** Called after successful creation (only if navigateOnSuccess is false). */
  onSuccess?: (questionId: string) => void;
  /** Called when user cancels. */
  onCancel?: () => void;
  /**
   * Re-ask mode: open a new wave on this existing question instead of
   * creating one. The wave starts from the question's declared options with
   * zero inherited stats.
   */
  existingQuestion?: ExistingQuestion;
}

const PollCreationForm: React.FC<PollCreationFormProps> = ({
  navigateOnSuccess = true,
  onSuccess,
  onCancel,
  existingQuestion,
}) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAuthenticated, getAuthToken } = useAuth();
  const reask = !!existingQuestion;

  const [stem, setStem] = useState(existingQuestion?.stem ?? '');
  const [options, setOptions] = useState<string[]>(existingQuestion?.a_options ?? ['', '']);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A poll is a wave: it always has a close time (default one week out).
  // Holder gate + write-ins stay behind the disclosure toggle.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [closesAt, setClosesAt] = useState<string>(defaultClosesAt(DEFAULT_WAVE_DAYS)); // datetime-local string
  const [gateEnabled, setGateEnabled] = useState(false);
  // World ID gate: one verified human, one answer. A wave has one gate, so it
  // and the holder gate exclude each other.
  const [worldGate, setWorldGate] = useState(false);
  const [gateType, setGateType] = useState<'nft_snapshot' | 'token_snapshot'>('nft_snapshot');
  const [gateContract, setGateContract] = useState('');
  const [gateChain, setGateChain] = useState<'base'>('base');     // v0: base only
  const [gateMinBalance, setGateMinBalance] = useState('');       // human-readable, e.g. "4420000"
  const [allowWriteIns, setAllowWriteIns] = useState(false);      // open-options poll → options_config.open
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
    (reask || filledOptions.length >= MIN_OPTIONS) &&
    !!closesAt &&
    !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    // A wave needs a close time in the future.
    const closesMs = Date.parse(closesAt);
    if (!Number.isFinite(closesMs) || closesMs <= Date.now()) {
      setError('Close time must be in the future');
      return;
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
      const gatePayload = worldGate
        ? { eligibility_gate: { type: 'world_id' as const, credential: 'proof_of_human' as const } }
        : gateEnabled
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
        : {};
      const wavePayload = {
        closes_at: new Date(closesAt).toISOString(),
        ...(allowWriteIns ? { options_config: { open: true } } : {}),
        ...gatePayload,
      };
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

      // Step 1: the wave. Re-ask mode opens a wave on the existing question
      // (POST /api/polls, free); otherwise create the mc question and its
      // first wave in one request. With a holder gate the server snapshots
      // holders synchronously (or reuses a prior identical snapshot), so this
      // can take 10–30s.
      let questionId: string;
      let pollId: string | undefined;
      let snapshot: { holder_address_count: number; holder_fid_count: number } | undefined;
      if (reask && existingQuestion) {
        const res = await fetch('/api/polls', {
          method: 'POST',
          headers,
          body: JSON.stringify({ question_id: existingQuestion.id, ...wavePayload }),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          setError(errData.error || (res.status === 503 ? 'Holder snapshot failed. Please try again.' : `Failed to open poll: ${res.status}`));
          setIsSubmitting(false);
          setSubmitStage('idle');
          return;
        }
        const json = await res.json() as { poll: { id: string }; snapshot?: { holder_address_count: number; holder_fid_count: number } };
        questionId = existingQuestion.id;
        pollId = json.poll.id;
        snapshot = json.snapshot;
      } else {
        const createRes = await fetch('/api/queries', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            stem: stem.trim(),
            type: 'mc',
            a_options: filledOptions,
            includeEmbed: false, // suppress server-side embed cast (older deploys)
            cast_mode: 'none' as const, // no server cast — @polls bot casts the poll (signerless Phase 5b)
            ...wavePayload,
          }),
        });

        if (!createRes.ok) {
          const errData = await createRes.json().catch(() => ({}));
          if (createRes.status === 429) {
            setError(errData.error || 'Too many requests. Please wait and try again.');
          } else if (createRes.status === 402) {
            setError('Insufficient QP for question creation.');
          } else if (createRes.status === 503) {
            setError(errData.error || 'Holder snapshot failed. Please try again.');
          } else if (errData.existing_id) {
            // Both dedup gates land here: the question exists — open a wave on it.
            setError('This question already exists. Opening a new poll on it instead…');
            navigate(`/create-poll?question=${errData.existing_id}`);
            return;
          } else {
            setError(errData.error || `Failed to create poll: ${createRes.status}`);
          }
          setIsSubmitting(false);
          setSubmitStage('idle');
          return;
        }

        const createJson = await createRes.json() as {
          id: string;
          poll_id?: string;
          snapshot?: { holder_address_count: number; holder_fid_count: number };
        };
        questionId = createJson.id;
        pollId = createJson.poll_id;
        snapshot = createJson.snapshot;
      }
      if (snapshot) setSnapshotInfo(snapshot);
      setSubmitStage('creating');

      // Cast includes question + options text for searchability ("all questions are casts")
      const castOptions = reask ? (existingQuestion?.a_options ?? []) : filledOptions;
      const castText = `${stem.trim()}\n\n${castOptions.map((o, i) => `${['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'][i]} ${o}`).join('\n')}`;

      // The cast embeds the wave's own snap URL: every in-feed answer is
      // attributed to this wave, and after it closes the cast shows its results.
      const castRes = await fetch('/api/farcaster/cast', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          usePollsBot: true,  // cast from @polls bot (FID 3321680)
          text: castText,
          embeds: [{ url: pollId ? pollSnapUrl(pollId) : `${window.location.origin}/snap/question/${questionId}` }],
          entityType: 'query',
          entityId: questionId,
          includeSnap: true,
          ...(pollId ? { pollId } : {}),
        }),
      });

      if (!castRes.ok) {
        console.warn('[PollCreation] Snap cast failed (poll still created):', castRes.status);
        // The wave exists — snap cast failure is non-critical.
      }

      sessionStorage.setItem('qbase_question_created', Date.now().toString());
      // The feed orders by latest poll and doesn't refetch on mount, so drop
      // the cached lists: the next visit loads them fresh.
      queryClient.removeQueries({ queryKey: ['questions', 'list'] });

      const target = pollId ? `/question/${questionId}?poll=${pollId}` : `/question/${questionId}`;
      if (navigateOnSuccess) {
        navigate(target, {
          state: { isNewQuestion: !reask, castPending: true },
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
    if (!isSubmitting) return reask ? 'Open new poll' : 'Create Poll';
    if (submitStage === 'snapshotting') return 'Snapshotting holders…';
    return 'Creating…';
  })();

  return (
    <div className="poll-form">
      <div className="poll-form__header">
        <h2 className="poll-form__title">{reask ? 'Ask again as a new poll' : 'Create a Poll'}</h2>
        {onCancel && (
          <button className="poll-form__cancel" onClick={onCancel}>✕</button>
        )}
      </div>

      {reask && (
        <p className="poll-form__hint" style={{ marginTop: 0 }}>
          A fresh poll over the same question: it starts from the question's options with zero inherited answers.
        </p>
      )}

      <label className="poll-form__label">Question</label>
      <input
        className="poll-form__stem"
        type="text"
        placeholder="What do you want to ask?"
        value={stem}
        onChange={e => setStem(e.target.value)}
        maxLength={300}
        disabled={isSubmitting || reask}
        readOnly={reask}
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
              disabled={isSubmitting || reask}
              readOnly={reask}
            />
            {!reask && options.length > MIN_OPTIONS && (
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

      {!reask && options.length < MAX_OPTIONS && (
        <button
          className="poll-form__add-option"
          onClick={addOption}
          disabled={isSubmitting}
        >
          + Add option
        </button>
      )}

      <label className="poll-form__writein-toggle" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 13, fontWeight: 500, color: 'var(--qbase-text, #475569)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={allowWriteIns}
          onChange={e => setAllowWriteIns(e.target.checked)}
          disabled={isSubmitting}
          style={{ margin: 0 }}
        />
        Allow voters to write in their own options
      </label>
      {allowWriteIns && (
        <p className="poll-form__hint" style={{ margin: '2px 0 0 24px' }}>
          Voters can add a new choice (and vote it) alongside yours.
        </p>
      )}

      <label className="poll-form__label">Closes at</label>
      <input
        className="poll-form__closes-at"
        type="datetime-local"
        value={closesAt}
        onChange={e => setClosesAt(e.target.value)}
        disabled={isSubmitting}
        required
      />
      <p className="poll-form__hint">
        Voting locks past this time; results stay visible. The question itself stays open forever.
      </p>

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
          <label className="poll-form__label" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={worldGate}
              onChange={e => { setWorldGate(e.target.checked); if (e.target.checked) setGateEnabled(false); }}
              disabled={isSubmitting}
              style={{ marginRight: 8 }}
            />
            Verified humans only (World ID)
          </label>
          {worldGate && (
            <p className="poll-form__hint">
              Each answer needs a World ID proof of human, once per person per wave, whichever account they use.
              The proof shows the answerer is a unique human, not who they are.
            </p>
          )}
          <label className="poll-form__label" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={gateEnabled}
              onChange={e => { setGateEnabled(e.target.checked); if (e.target.checked) setWorldGate(false); }}
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
