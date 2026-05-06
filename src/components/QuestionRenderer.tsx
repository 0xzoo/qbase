import React from 'react';
import type { Query, CheckboxAnswerValue, AnswerData } from '../lib/types';
import './QuestionRenderer.css';

interface QuestionRendererProps {
  question: Query;
  value: unknown;
  onChange: (value: unknown) => void;
}

const QuestionRenderer: React.FC<QuestionRendererProps> = ({ question, value, onChange }) => {
  switch (question.type) {
    case 'mc':
      return (
        <div className="qr-mc-options">
          {question.a_options?.map((option, index) => (
            <button
              key={index}
              className={`qr-mc-option ${value === option ? 'selected' : ''}`}
              onClick={() => onChange(option)}
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
              className={`qr-checkbox-option ${selectedIndices.includes(index) ? 'selected' : ''}`}
            >
              <input
                type="checkbox"
                checked={selectedIndices.includes(index)}
                onChange={() => handleToggle(index)}
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
        />
      );
  }
};

export default QuestionRenderer;
