import React from 'react';
import type { Query, CheckboxAnswerValue } from '../lib/types';
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
      const { min = 1, max = 5, minLabel, maxLabel } = scaleConfig;
      const range = Array.from({ length: max - min + 1 }, (_, i) => min + i);

      return (
        <div className="qr-scale-container">
          <div className="qr-scale-options">
            {range.map((num) => (
              <button
                key={num}
                className={`qr-scale-btn ${value === num ? 'selected' : ''}`}
                onClick={() => onChange(num)}
              >
                {num}
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
