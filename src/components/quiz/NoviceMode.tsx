import React, { useState } from 'react';
import './NoviceMode.css';

const NoviceMode: React.FC = () => {
  const [goal, setGoal] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedDraft, setGeneratedDraft] = useState<string | null>(null);

  const handleGenerate = () => {
    setIsGenerating(true);
    // Simulate Architect Agent generation
    setTimeout(() => {
      setGeneratedDraft(`
        Quiz Draft: "${goal}"
        
        Dimensions:
        - Extroversion vs. Introversion
        - Thinking vs. Feeling
        
        Proposed Questions:
        1. How do you recharge after a long day? (MC)
        2. When making decisions, what matters most? (MC)
        3. I enjoy being the center of attention. (Scale)
      `);
      setIsGenerating(false);
    }, 2000);
  };

  return (
    <div className="novice-mode">
      <div className="architect-header">
        <h3>Architect Agent</h3>
        <p>Tell me what kind of quiz you want to create, and I'll build it for you.</p>
      </div>

      <div className="input-section">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g., I want a quiz to tell my friends which 'The Office' character they are..."
          className="goal-input"
          rows={4}
        />
        <button
          className="generate-button"
          onClick={handleGenerate}
          disabled={!goal || isGenerating}
        >
          {isGenerating ? 'Architect is thinking...' : 'Generate Quiz Draft'}
        </button>
      </div>

      {generatedDraft && (
        <div className="draft-preview">
          <h4>Generated Draft</h4>
          <pre>{generatedDraft}</pre>
          <div className="draft-actions">
            <button className="accept-button">Accept & Publish</button>
            <button className="refine-button">Refine with Architect</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default NoviceMode;
