import React from 'react';
import type { Question } from '../data/mockQuestions';
import './QuestionRenderer.css';

interface QuestionRendererProps {
  question: Question;
  value: any;
  onChange: (value: any) => void;
}

const QuestionRenderer: React.FC<QuestionRendererProps> = ({ question, value, onChange }) => {
  switch (question.type) {
    case 'mc':
      return (
        <div className="qr-mc-options">
          {question.options?.map((option, index) => (
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

    case 'scale':
      const { min = 1, max = 5, minLabel, maxLabel } = question.scaleConfig || {};
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

    case 'date':
      return (
        <input
          type="date"
          className="qr-date-input"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'tuple':
      const fields = question.tupleConfig?.fields || [];
      const currentValues = Array.isArray(value) ? value : Array(fields.length).fill('');

      const handleTupleChange = (index: number, val: string) => {
        const newValues = [...currentValues];
        newValues[index] = val;
        onChange(newValues);
      };

      return (
        <div className="qr-tuple-container">
          {fields.map((field, index) => (
            <div key={index} className="qr-tuple-field">
              <label>{field.label}</label>
              <input
                type={field.type === 'number' ? 'number' : 'text'}
                value={currentValues[index]}
                onChange={(e) => handleTupleChange(index, e.target.value)}
                className="qr-tuple-input"
              />
            </div>
          ))}
        </div>
      );

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
