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
  const { user, isAuthenticated, getAuthToken } = useAuth();

  const [stem, setStem] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    setError(null);
    setIsSubmitting(true);

    const token = getAuthToken();
    if (!token) {
      setError('Authentication required. Please log in again.');
      setIsSubmitting(false);
      return;
    }

    try {
      // Step 1: Create mc question (server fires background cast without embed)
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
        }),
      });

      if (!createRes.ok) {
        const errData = await createRes.json().catch(() => ({}));
        if (createRes.status === 429) {
          setError(errData.error || 'Too many requests. Please wait and try again.');
        } else if (createRes.status === 402) {
          setError('Insufficient QP for question creation.');
        } else {
          setError(errData.error || `Failed to create poll: ${createRes.status}`);
        }
        setIsSubmitting(false);
        return;
      }

      const { id: questionId } = await createRes.json() as { id: string };

      // Step 2: Cast snap card (no text — snap-only cast)
      const castText = '';

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
    }
  };

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

      {error && <div className="poll-form__error">{error}</div>}

      <button
        className="poll-form__submit"
        onClick={handleSubmit}
        disabled={!canSubmit}
      >
        {isSubmitting ? 'Creating…' : 'Create Poll'}
      </button>
    </div>
  );
};

export default PollCreationForm;
