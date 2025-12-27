import React from 'react';
import './PresetOptionsSelector.css';

export interface PresetOption {
  id: string;
  name: string;
  options: string[];
}

const PRESETS: PresetOption[] = [
  {
    id: 'agreement',
    name: 'Agreement (Likert)',
    options: ['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'],
  },
  {
    id: 'frequency',
    name: 'Frequency',
    options: ['Never', 'Rarely', 'Sometimes', 'Often', 'Always'],
  },
  {
    id: 'importance',
    name: 'Importance',
    options: ['Not at all', 'Slightly', 'Moderately', 'Very', 'Extremely'],
  },
  {
    id: 'probability',
    name: 'Probability',
    options: ['Impossible', 'Unlikely', 'Possible', 'Likely', 'Certain'],
  },
  {
    id: 'binary',
    name: 'Binary',
    options: ['Yes', 'No'],
  },
  {
    id: 'true_false',
    name: 'True/False',
    options: ['True', 'False'],
  },
];

interface PresetOptionsSelectorProps {
  onSelect: (options: string[]) => void;
}

const PresetOptionsSelector: React.FC<PresetOptionsSelectorProps> = ({ onSelect }) => {
  return (
    <div className="preset-options-selector">
      <h4>Preset Options</h4>
      <div className="preset-grid">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="preset-button"
            onClick={() => onSelect(preset.options)}
          >
            <span className="preset-name">{preset.name}</span>
            <span className="preset-preview">{preset.options.join(', ')}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default PresetOptionsSelector;
