import React, { useState, useEffect } from 'react';
import { Search, AlertCircle, CheckCircle2, Trash2, Plus } from 'lucide-react';
import PresetOptionsSelector from './PresetOptionsSelector';
import './ProMode.css';

interface QuestionOption {
  text: string;
  weight: number;
}

interface Question {
  stem: string;
  type: 'mc' | 'scale' | 'text';
  options: QuestionOption[];
  isLinked?: boolean;
  linkedId?: string;
  allows_text: boolean;
}

const ProMode: React.FC = () => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [searchingIndex, setSearchingIndex] = useState<number | null>(null);

  const addQuestion = () => {
    setQuestions([...questions, { stem: '', type: 'mc', options: [], allows_text: false }]);
  };

  const updateQuestion = (index: number, field: keyof Question, value: any) => {
    const newQuestions = [...questions];
    newQuestions[index] = { ...newQuestions[index], [field]: value };

    // Reset link status when stem changes
    if (field === 'stem') {
      newQuestions[index].isLinked = false;
      newQuestions[index].linkedId = undefined;
    }

    setQuestions(newQuestions);
  };

  const handleOptionSelect = (index: number, options: string[]) => {
    const newOptions: QuestionOption[] = options.map(opt => ({
      text: opt,
      weight: 1.0 // Default weight
    }));
    updateQuestion(index, 'options', newOptions);
  };

  const updateOptionText = (qIndex: number, optIndex: number, text: string) => {
    const newQuestions = [...questions];
    newQuestions[qIndex].options[optIndex].text = text;
    setQuestions(newQuestions);
  };

  const updateOptionWeight = (qIndex: number, optIndex: number, weight: number) => {
    const newQuestions = [...questions];
    newQuestions[qIndex].options[optIndex].weight = weight;
    setQuestions(newQuestions);
  };

  const addOption = (qIndex: number) => {
    const newQuestions = [...questions];
    newQuestions[qIndex].options.push({ text: '', weight: 1.0 });
    setQuestions(newQuestions);
  };

  const removeOption = (qIndex: number, optIndex: number) => {
    const newQuestions = [...questions];
    newQuestions[qIndex].options.splice(optIndex, 1);
    setQuestions(newQuestions);
  };

  // Mock Smart Search Effect
  useEffect(() => {
    questions.forEach((q, index) => {
      if (q.stem.length > 10 && !q.isLinked && searchingIndex !== index) {
        // Simulate search trigger
        setSearchingIndex(index);
        setTimeout(() => {
          // 50% chance of finding a match for demo purposes
          const foundMatch = Math.random() > 0.5;
          if (foundMatch) {
            const newQuestions = [...questions];
            newQuestions[index].isLinked = true;
            newQuestions[index].linkedId = `QID:${Math.floor(Math.random() * 10000)}`;
            setQuestions(newQuestions);
          }
          setSearchingIndex(null);
        }, 1500);
      }
    });
  }, [questions]);

  return (
    <div className="pro-mode">
      <div className="studio-header">
        <h3>Studio Mode</h3>
        <p>Granular control for professional quiz creation.</p>
      </div>

      <div className="metadata-section">
        <input
          type="text"
          placeholder="Quiz Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="title-input"
        />
        <textarea
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="description-input"
        />
      </div>

      <div className="questions-section">
        <h4>Questions</h4>
        {questions.map((q, index) => (
          <div key={index} className="create-question-card">
            <div className="stem-wrapper">
              <input
                type="text"
                placeholder="Question Stem"
                value={q.stem}
                onChange={(e) => updateQuestion(index, 'stem', e.target.value)}
                className="stem-input"
              />
              <div className="smart-search-indicator">
                {searchingIndex === index && (
                  <span className="searching">
                    <Search size={14} className="spin" /> Searching Registry...
                  </span>
                )}
                {q.isLinked && (
                  <span className="linked">
                    <CheckCircle2 size={14} /> Linked to {q.linkedId} (0 QP)
                  </span>
                )}
                {!q.isLinked && !searchingIndex && q.stem.length > 10 && (
                  <span className="new-query">
                    <AlertCircle size={14} /> New Query (5 QP)
                  </span>
                )}
              </div>
            </div>

            <div className="type-selector-row">
              <div className="type-selector">
                <label>Type:</label>
                <select
                  value={q.type}
                  onChange={(e) => updateQuestion(index, 'type', e.target.value)}
                >
                  <option value="mc">Multiple Choice</option>
                  <option value="scale">Scale</option>
                  <option value="text">Text</option>
                </select>
              </div>

              {q.type !== 'text' && (
                <div className="mandate-type-toggle">
                  <label>
                    <input
                      type="checkbox"
                      checked={!q.allows_text}
                      onChange={(e) => updateQuestion(index, 'allows_text', !e.target.checked)}
                    />
                    Mandate Type (No Text Fallback)
                  </label>
                </div>
              )}
            </div>

            {(q.type === 'mc' || q.type === 'scale') && (
              <div className="options-section">
                <h5>Options & Weights</h5>
                <PresetOptionsSelector
                  onSelect={(options) => handleOptionSelect(index, options)}
                />
                <div className="current-options">
                  <div className="options-grid">
                    <div className="grid-header">
                      <span>Option Label</span>
                      <span>Weight (-1.0 to 1.0)</span>
                      <span></span>
                    </div>
                    {q.options.map((opt, i) => (
                      <div key={i} className="option-row">
                        <input
                          type="text"
                          value={opt.text}
                          onChange={(e) => updateOptionText(index, i, e.target.value)}
                          className="option-text-input"
                          placeholder={`Option ${i + 1}`}
                        />
                        <input
                          type="number"
                          min="-1"
                          max="1"
                          step="0.1"
                          value={opt.weight}
                          onChange={(e) => updateOptionWeight(index, i, parseFloat(e.target.value))}
                          className="weight-input"
                        />
                        <button
                          className="delete-option-btn"
                          onClick={() => removeOption(index, i)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    className="add-option-btn"
                    onClick={() => addOption(index)}
                  >
                    <Plus size={16} /> Add Option
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        <button className="add-question-button" onClick={addQuestion}>
          + Add Question
        </button>
      </div>
    </div>
  );
};

export default ProMode;
