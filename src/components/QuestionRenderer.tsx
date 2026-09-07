import React from 'react';
import type { Query, CheckboxAnswerValue, AnswerData } from '../lib/types';
import { apiClient } from '../lib/apiClient';
import './QuestionRenderer.css';

interface QuestionRendererProps {
  question: Query;
  value: unknown;
  onChange: (value: unknown) => void;
  /** When true, all inputs are disabled — used for poll locks (closed / ineligible). */
  disabled?: boolean;
  /** Audience a write-in vote is cast with (the slide's visibility toggle). */
  audience?: 'Public' | 'Anon';
}

/**
 * Open-options poll renderer (mc + options_config.open). Options come from
 * question.poll_options (live, declared order — the current wave's set). An
 * inline "add your own" row posts to POST /api/polls/:id/options, which both
 * creates/merges the option
 * and records the user's vote; on success we select the returned label.
 */
const OpenMcOptions: React.FC<{
  question: Query;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  audience: 'Public' | 'Anon';
}> = ({ question, value, onChange, disabled, audience }) => {
  const seedLabels = React.useMemo(
    () => question.poll_options?.map((o) => o.label) ?? question.a_options ?? [],
    [question.poll_options, question.a_options],
  );
  const [options, setOptions] = React.useState<string[]>(seedLabels);
  const [draft, setDraft] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [spent, setSpent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => { setOptions(seedLabels); }, [question.id, seedLabels]);

  const cap = question.options_config?.cap ?? 24;
  const atCap = options.length >= cap;

  const submitWriteIn = async () => {
    const label = draft.trim();
    if (!label || adding) return;
    setAdding(true);
    setError(null);
    try {
      const pollId = question.current_poll?.id;
      if (!pollId) {
        setError('This poll is not accepting write-ins right now');
        return;
      }
      const res = await apiClient.post(`/api/polls/${pollId}/options`, { label, audience });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body?.error || 'Could not add option');
        return;
      }
      const { option } = await res.json() as { option: { label: string } };
      setOptions((prev) => (prev.includes(option.label) ? prev : [...prev, option.label]));
      onChange(option.label);
      setSpent(true);
      setDraft('');
    } catch {
      setError('Network error — try again');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="qr-mc-options">
      {options.map((option, index) => (
        <button
          key={index}
          className={`qr-mc-option ${value === option ? 'selected' : ''}`}
          onClick={() => onChange(option)}
          disabled={disabled}
        >
          {option}
        </button>
      ))}
      {!disabled && !spent && !atCap && (
        <div className="qr-writein-row">
          <input
            className="qr-writein-input"
            type="text"
            maxLength={60}
            placeholder="Add your own…"
            value={draft}
            disabled={adding}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submitWriteIn(); } }}
          />
          <button
            className="qr-writein-add"
            onClick={() => void submitWriteIn()}
            disabled={adding || !draft.trim()}
          >
            {adding ? '…' : 'Add'}
          </button>
        </div>
      )}
      {error && <div className="qr-writein-error">{error}</div>}
    </div>
  );
};

const QuestionRenderer: React.FC<QuestionRendererProps> = ({ question, value, onChange, disabled = false, audience = 'Public' }) => {
  switch (question.type) {
    case 'mc':
      if (question.options_config?.open) {
        return <OpenMcOptions question={question} value={value} onChange={onChange} disabled={disabled} audience={audience} />;
      }
      return (
        <div className="qr-mc-options">
          {question.a_options?.map((option, index) => (
            <button
              key={index}
              className={`qr-mc-option ${value === option ? 'selected' : ''}`}
              onClick={() => onChange(option)}
              disabled={disabled}
            >
              {option}
            </button>
          ))}
        </div>
      );

    case 'checkbox': {
      // Value is CheckboxAnswerValue with indices array
      const selectedIndices = (value as CheckboxAnswerValue)?.indices || [];

      const handleToggle = (index: number) => {
        const newIndices = selectedIndices.includes(index)
          ? selectedIndices.filter((i: number) => i !== index)
          : [...selectedIndices, index].sort((a, b) => a - b);

        // Build the selected text from indices
        const selectedText = newIndices
          .map((i: number) => question.a_options?.[i])
          .filter(Boolean)
          .join(', ');

        onChange({
          text: selectedText,
          indices: newIndices
        } as CheckboxAnswerValue);
      };

      return (
        <div className="qr-checkbox-options">
          {question.a_options?.map((option, index) => (
            <label
              key={index}
              className={`qr-checkbox-option ${selectedIndices.includes(index) ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
            >
              <input
                type="checkbox"
                checked={selectedIndices.includes(index)}
                onChange={() => handleToggle(index)}
                disabled={disabled}
              />
              <span className="checkbox-label">{option}</span>
            </label>
          ))}
        </div>
      );
    }

    case 'scale': {
      const scaleConfig = question.scale_config || { min: 1, max: 5 };
      const { min = 1, max = 5, showNumericValue = false, customLabels } = scaleConfig;
      const range = max - min + 1;

      // Resolve endpoint labels from customLabels, then minLabel/maxLabel, then numbers
      const labelForValue = (val: number): string => {
        const custom = customLabels?.find(c => c.value === val);
        if (custom) return custom.label;
        if (val === min && scaleConfig.minLabel) return scaleConfig.minLabel;
        if (val === max && scaleConfig.maxLabel) return scaleConfig.maxLabel;
        return String(val);
      };
      const minLabel = labelForValue(min);
      const maxLabel = labelForValue(max);

      // Ranges >5: slider. ≤5: buttons.
      if (range > 5) {
        return (
          <div className="qr-scale-container qr-scale-slider">
            <div className="qr-scale-slider-row">
              <span className="qr-scale-slider-label">{minLabel}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={scaleConfig.step || 1}
                value={typeof value === 'number' ? value : Math.ceil((min + max) / 2)}
                onChange={(e) => onChange(parseInt(e.target.value, 10))}
                className="qr-scale-range-input"
                disabled={disabled}
              />
              <span className="qr-scale-slider-label">{maxLabel}</span>
            </div>
            {typeof value === 'number' && (
              <div className="qr-scale-slider-value">{labelForValue(value)}</div>
            )}
          </div>
        );
      }

      return (
        <div className="qr-scale-container">
          <div className="qr-scale-options">
            {Array.from({ length: range }, (_, i) => min + i).map((num) => (
              <button
                key={num}
                className={`qr-scale-btn ${value === num ? 'selected' : ''}`}
                onClick={() => onChange(num)}
                disabled={disabled}
                style={{
                  width: num === Math.ceil((min + max) / 2) ? 40 : 32,
                  height: num === Math.ceil((min + max) / 2) ? 40 : 32,
                  opacity: value === num ? 1 : 0.3 + ((num - min) % 4) * 0.1
                }}
              >
                {showNumericValue ? num : ''}
              </button>
            ))}
          </div>
          <div className="qr-scale-labels">
            <span>{minLabel}</span>
            <span>{maxLabel}</span>
          </div>
        </div>
      );
    }

    case 'date': {
      const includeTime = question.date_config?.include_time ?? false;
      const inputType = includeTime ? 'datetime-local' : 'date';
      const iso = (value as AnswerData)?.iso ?? (typeof value === 'string' ? value : '');
      return (
        <input
          type={inputType}
          className="qr-date-input"
          value={iso}
          onChange={(e) => onChange({ iso: e.target.value })}
          disabled={disabled}
        />
      );
    }

    case 'text':
    default:
      return (
        <textarea
          className="qr-text-input"
          placeholder="Type your answer..."
          value={(typeof value === 'string' ? value : '') || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      );
  }
};

export default QuestionRenderer;
