import React, { useMemo } from 'react';
import OracleAnswerCard from './OracleAnswerCard';
import type { Answer } from '../lib/types';
import './OracleComparisonView.css';

interface OracleComparisonViewProps {
  /** Oracle answers for one question, grouped by model */
  answers: Answer[];
}

/**
 * Simple heuristic: count model sources that gave a substantive (non-refused) answer.
 * If all non-refused answers tend to agree in length/tone, show consensus.
 * For v0 we use a basic heuristic: >50% answer sources have similar sentiment.
 */
function computeConsensus(answers: Answer[]): {
  type: 'full' | 'partial' | 'none' | 'single';
  message: string;
} {
  const nonRefused = answers.filter(a => !a.oracle_refused);
  const uniqueSources = new Set(answers.map(a => a.answer_source));
  const uniqueNonRefused = new Set(nonRefused.map(a => a.answer_source));

  if (uniqueSources.size < 2) {
    return { type: 'single', message: '' };
  }

  if (nonRefused.length === 0) {
    return { type: 'none', message: 'All models declined to answer' };
  }

  // Count unique answer sources that gave substantive answers
  const sourceCount = uniqueNonRefused.size;
  const totalModels = uniqueSources.size;

  if (sourceCount === totalModels && nonRefused.length >= 2) {
    // Simple text-based consensus heuristic: same direction?
    // For yes/no MC or short answers, check for agreement on key terms.
    // For v0: if all non-refused answers are shorter than 500 chars each,
    // we can't easily determine semantic agreement — flag as "answered"
    const allShort = nonRefused.every(a => (a.value?.length || 0) < 500);
    if (allShort) {
      return {
        type: 'full',
        message: `${totalModels} models answered`,
      };
    }
    return {
      type: 'full',
      message: `${totalModels} models answered`,
    };
  }

  const refusedCount = totalModels - sourceCount;
  if (refusedCount > 0 && sourceCount > 0) {
    return {
      type: 'partial',
      message: `${sourceCount} answered · ${refusedCount} declined`,
    };
  }

  return { type: 'none', message: 'No consensus' };
}

const OracleComparisonView: React.FC<OracleComparisonViewProps> = ({ answers }) => {
  const consensus = useMemo(() => computeConsensus(answers), [answers]);

  // No oracle answers
  if (answers.length === 0) return null;

  // Single model answer — render as a stand-alone card (no comparison grid)
  if (answers.length === 1) {
    return (
      <div className="oracle-comparison-section">
        {consensus.type !== 'single' && consensus.message && (
          <div className={`oracle-consensus-badge oracle-consensus--${consensus.type}`}>
            {consensus.message}
          </div>
        )}
        <OracleAnswerCard answer={answers[0]} />
      </div>
    );
  }

  // Two or more — side-by-side grid
  return (
    <div className="oracle-comparison-section">
      {/* Consensus indicator */}
      {consensus.message && (
        <div className={`oracle-consensus-badge oracle-consensus--${consensus.type}`}>
          <span className="oracle-consensus-icon">
            {consensus.type === 'full' ? '✓' : consensus.type === 'partial' ? '~' : '✗'}
          </span>
          {consensus.message}
        </div>
      )}

      <div className="oracle-comparison-grid">
        {answers.map(answer => (
          <OracleAnswerCard
            key={answer.id}
            answer={answer}
            compact={true}
          />
        ))}
      </div>
    </div>
  );
};

export default OracleComparisonView;
