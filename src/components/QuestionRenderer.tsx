import React from 'react';
import type { Query } from '../lib/types';
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

    case 'boolean':
      return (
        <div className="qr-boolean-options">
          <button
            className={`qr-bool-btn yes ${value === true ? 'selected' : ''}`}
            onClick={() => onChange(true)}
          >
            Yes
          </button>
          <button
            className={`qr-bool-btn no ${value === false ? 'selected' : ''}`}
            onClick={() => onChange(false)}
          >
            No
          </button>
        </div>
      );

    case 'scale': {
      const { min = 1, max = 5, minLabel, maxLabel } = question.scale_config || {};
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

    case 'date':
      return (
        <input
          type="date"
          className="qr-date-input"
          value={value as string || ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'tuple': {
      // Tuple config would need to be defined in the Query type if needed
      // For now, we'll skip this case or handle it differently
      return (
        <div className="qr-text-input">
          <textarea
            className="qr-text-input"
            placeholder="Type your answer..."
            value={value as string || ''}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    }

    case 'text':
    default:
      return (
        <textarea
          className="qr-text-input"
          placeholder="Type your answer..."
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
};

export default QuestionRenderer;
